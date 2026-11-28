'use strict';

const crypto = require('crypto');
const net = require('net');
const { Session, rejectSocket } = require('./session');
const { Status } = require('../guac/protocol');

const SECURITY = new Set(['any', 'nla', 'nla-ext', 'tls', 'rdp', 'vmconnect']);
const HOST_RE = /^[A-Za-z0-9._\-:[\]%]+$/;
const MIME_RE = /^(audio|image)\/[A-Za-z0-9.+\-]+(;[A-Za-z0-9=,.\-]+)*$/;

class ValidationError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function toInt(v, def, min, max, name) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || n < min || n > max) throw new ValidationError(`参数 ${name} 无效`);
  return n;
}

function toBool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function cleanText(v, max) {
  if (v === undefined || v === null) return '';
  // eslint-disable-next-line no-control-regex
  return String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

/**
 * Normalise and validate RDP target parameters coming from the browser
 * (form, URL query/fragment, or the legacy token API).
 */
function normalizeTarget(input, { allowedHosts = [] } = {}) {
  const body = input || {};
  let host = cleanText(body.host ?? body.hostname, 255);
  if (!host) throw new ValidationError('缺少必需的参数 (host, user, password)');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!HOST_RE.test(host)) throw new ValidationError('主机地址无效');
  const user = cleanText(body.user ?? body.username, 256);
  const password = body.password === undefined || body.password === null ? '' : String(body.password);
  if (!user || !password) throw new ValidationError('缺少必需的参数 (host, user, password)');
  if (password.length > 1024) throw new ValidationError('密码过长');
  if (allowedHosts.length) {
    const h = host.toLowerCase();
    if (!allowedHosts.includes(h) && !(net.isIP(h) && allowedHosts.includes(h))) {
      const err = new ValidationError('该主机不在允许列表中');
      err.status = 403;
      throw err;
    }
  }
  let security = cleanText(body.security, 16).toLowerCase() || 'any';
  if (!SECURITY.has(security)) security = 'any';
  const ignoreCert = toBool(body.ignoreCert ?? body['ignore-cert'], true);
  const width = toInt(body.width, 1024, 320, 8192, 'width');
  const height = toInt(body.height, 768, 200, 8192, 'height');
  return {
    host,
    port: toInt(body.port, 3389, 1, 65535, 'port'),
    user,
    password,
    domain: cleanText(body.domain, 256),
    width: width - (width % 2),
    height: height - (height % 2),
    dpi: toInt(body.dpi, 96, 48, 480, 'dpi'),
    security,
    ignoreCert,
    timezone: /^[A-Za-z0-9_+\-/]{1,64}$/.test(String(body.timezone || '')) ? String(body.timezone) : '',
  };
}

function normalizeCaps(caps) {
  const out = { audio: [], image: [] };
  if (!caps || typeof caps !== 'object') return out;
  for (const k of ['audio', 'image']) {
    if (Array.isArray(caps[k])) {
      out[k] = caps[k].map(String).filter((m) => m.length < 64 && MIME_RE.test(m) && m.startsWith(k)).slice(0, 16);
    }
  }
  return out;
}

class SessionManager {
  constructor({ config, log }) {
    this.config = config;
    this.log = log;
    this.secret = crypto.randomBytes(32);
    /** sessionKey -> Session */
    this.sessions = new Map();
    /** ticket -> {expiresAt, key, target, identity, label, device, caps} */
    this.tickets = new Map();
    this._sweep = setInterval(() => this._sweepTickets(), 15000);
    this._sweep.unref();
  }

  /** Same target + same credentials => same shared session. */
  sessionKey(t) {
    const material = JSON.stringify([t.host.toLowerCase(), t.port, t.domain.toLowerCase(), t.user.toLowerCase(), t.password]);
    return crypto.createHmac('sha256', this.secret).update(material).digest('hex');
  }

  /**
   * Issue a one-time ticket for opening the websocket tunnel. Credentials
   * never travel in the websocket URL.
   */
  issueTicket(body) {
    const target = normalizeTarget(body, this.config);
    const key = this.sessionKey(target);
    if (!this.sessions.has(key) && this.sessions.size >= this.config.maxSessions) {
      const err = new Error('服务器会话数已达上限');
      err.status = 503;
      throw err;
    }
    const ticket = crypto.randomBytes(24).toString('base64url');
    this.tickets.set(ticket, {
      expiresAt: Date.now() + this.config.ticketTtlMs,
      key,
      target,
      clientId: typeof body.clientId === 'string' ? body.clientId.slice(0, 64) : null,
      resumeToken: typeof body.resumeToken === 'string' ? body.resumeToken.slice(0, 128) : null,
      label: cleanText(body.name, 24),
      device: cleanText(body.device, 16),
      caps: normalizeCaps(body.caps),
    });
    const existing = this.sessions.get(key);
    return {
      ticket,
      expiresIn: Math.floor(this.config.ticketTtlMs / 1000),
      session: existing ? existing.stats() : null,
    };
  }

  consumeTicket(ticket) {
    if (typeof ticket !== 'string') return null;
    const t = this.tickets.get(ticket);
    if (!t) return null;
    this.tickets.delete(ticket);
    if (t.expiresAt < Date.now()) return null;
    return t;
  }

  _sweepTickets() {
    const now = Date.now();
    for (const [k, t] of this.tickets) if (t.expiresAt < now) this.tickets.delete(k);
  }

  getOrCreate(key, target) {
    let s = this.sessions.get(key);
    if (s && s.phase !== 'closed') return s;
    s = new Session({ key, target, config: this.config, log: this.log });
    this.sessions.set(key, s);
    s.once('closed', () => {
      if (this.sessions.get(key) === s) this.sessions.delete(key);
    });
    this.log.info('session created', { session: s.shortId, host: target.host, port: target.port });
    return s;
  }

  /** Attach a websocket using a ticket. */
  async attach(ws, ticketStr) {
    const t = this.consumeTicket(ticketStr);
    if (!t) {
      // RESOURCE_NOT_FOUND is retryable: the browser simply requests a new ticket.
      rejectSocket(ws, Status.RESOURCE_NOT_FOUND, '连接票据无效或已过期');
      return;
    }
    const s = this.getOrCreate(t.key, t.target);
    await s.attach(ws, {
      clientId: t.clientId,
      resumeToken: t.resumeToken,
      label: t.label,
      device: t.device,
      caps: t.caps,
    });
  }

  stats() {
    return { sessions: [...this.sessions.values()].map((s) => s.stats()), tickets: this.tickets.size };
  }

  shutdown() {
    clearInterval(this._sweep);
    for (const s of [...this.sessions.values()]) s.close('server shutdown');
  }
}

module.exports = { SessionManager, normalizeTarget, normalizeCaps, ValidationError };
