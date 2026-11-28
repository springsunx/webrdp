'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { GuacdConnection } = require('../guac/guacd-connection');
const {
  Parser, encode, encodeUtf16, hasSurrogates, Status,
} = require('../guac/protocol');

/**
 * Length units differ between guacd (Unicode code points) and
 * guacamole-common-js 1.5's WebSocketTunnel (UTF-16 code units). They only
 * diverge for characters outside the BMP (emoji etc.), so re-encode only
 * instructions that contain surrogate pairs.
 */
const toBrowser = (ins) => (hasSurrogates(ins.raw) ? encodeUtf16(ins.opcode, ...ins.args) : ins.raw);
const toGuacd = (ins) => (hasSurrogates(ins.raw) ? encode(ins.opcode, ...ins.args) : ins.raw);
const { ControlState } = require('./control-state');

/** Opcode used for gateway <-> browser control messages inside the tunnel. */
const CTL = 'webrdp';
/** Guacamole internal tunnel opcode (empty string). */
const INTERNAL = '';

/** Input instructions that require control. */
const GATED = new Set(['mouse', 'key', 'size', 'clipboard', 'file', 'pipe', 'argv', 'touch', 'audio', 'put']);
/** Stream payload instructions: allowed only for streams the controller opened. */
const STREAM_PAYLOAD = new Set(['blob', 'end']);
/** Always allowed (flow control / keep-alive). */
const PASSTHROUGH = new Set(['sync', 'nop', 'ack']);
/** Instructions that open a client->server stream (index is args[0]). */
const STREAM_OPEN = new Set(['clipboard', 'file', 'pipe', 'argv', 'audio', 'put']);

const WS_HIGH_WATER = 4 * 1024 * 1024;
const WS_LOW_WATER = 1 * 1024 * 1024;
const WS_HARD_LIMIT = 48 * 1024 * 1024;
const ANCHOR_NOP_MS = 5000;
const LIVENESS_TIMEOUT_MS = 2500;
const DENIED_NOTICE_INTERVAL_MS = 3000;

/** JSON with all non-ASCII escaped so that length == code point count everywhere. */
function asciiJson(obj) {
  return JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest();
}

/** Fatal (non retryable) Guacamole status codes for the browser. */
function isFatal(code) {
  return code >= 0x0300 && code <= 0x03ff && code !== Status.CLIENT_TIMEOUT;
}

/** Refuse a websocket with a Guacamole error the browser understands. */
function rejectSocket(ws, code, message) {
  try {
    ws.send(encode(INTERNAL, randomId(16)));
    ws.send(encode(CTL, asciiJson({ t: 'fatal', code, message, retry: !isFatal(code) })));
    ws.send(encode('error', message, code));
  } catch { /* ignore */ }
  try { ws.close(isFatal(code) ? 4001 : 4000, String(code)); } catch { /* ignore */ }
}

/**
 * Per-browser connection state inside a session.
 */
class Attachment {
  constructor(session, ws, identity, info) {
    this.session = session;
    this.ws = ws;
    this.id = identity.id;
    this.label = info.label || '';
    this.device = info.device || '';
    this.caps = info.caps || {};
    this.guac = null;
    this.parser = new Parser({ maxBuffer: 1024 * 1024, units: 'utf16' });
    this.pressedKeys = new Set();
    this.mouse = { x: 0, y: 0, mask: 0 };
    this.openStreams = new Set();
    this.closed = false;
    this.lastDenied = 0;
    this.paused = false;
    this.overLimitSince = 0;
    this.drainTimer = null;
  }

  sendRaw(text) {
    const ws = this.ws;
    if (this.closed || ws.readyState !== 1) return;
    ws.send(text);
    this._checkBackpressure();
  }

  sendCtl(obj) {
    this.sendRaw(encode(CTL, asciiJson(obj)));
  }

  _checkBackpressure() {
    const buffered = this.ws.bufferedAmount;
    if (buffered > WS_HARD_LIMIT) {
      if (!this.overLimitSince) this.overLimitSince = Date.now();
      else if (Date.now() - this.overLimitSince > 10000) {
        this.session.log.warn('client too slow, dropping', { session: this.session.shortId, client: this.id });
        this.ws.terminate();
        return;
      }
    } else {
      this.overLimitSince = 0;
    }
    if (!this.paused && buffered > WS_HIGH_WATER && this.guac) {
      this.paused = true;
      this.guac.pause();
      this.drainTimer = setInterval(() => {
        if (this.closed || this.ws.bufferedAmount < WS_LOW_WATER) {
          clearInterval(this.drainTimer);
          this.drainTimer = null;
          this.paused = false;
          if (this.guac) this.guac.resume();
        }
      }, 25);
    }
  }

  dispose() {
    this.closed = true;
    if (this.drainTimer) clearInterval(this.drainTimer);
    if (this.guac) this.guac.close('participant left');
    this.guac = null;
  }
}

/**
 * One shared RDP session: a gateway-owned "anchor" guacd connection (the
 * Guacamole connection owner, so the RDP session survives browser refreshes)
 * plus one joining guacd user per attached browser.
 */
class Session extends EventEmitter {
  /**
   * @param {object} p
   * @param {string} p.key           session key (HMAC of target + credentials)
   * @param {object} p.target        validated RDP parameters
   * @param {object} p.config
   * @param {object} p.log
   */
  constructor({ key, target, config, log }) {
    super();
    this.key = key;
    this.shortId = key.slice(0, 8);
    this.target = target;
    this.config = config;
    this.log = log;
    this.createdAt = Date.now();
    this.control = new ControlState({ primaryGraceMs: config.primaryGraceMs });
    /** clientId -> sha256(resumeToken) */
    this.identities = new Map();
    /** clientId -> Attachment (online only) */
    this.attachments = new Map();

    this.phase = 'idle'; // idle | connecting | connected | closed
    this.anchor = null;
    this.connectionId = null;
    this.connectedAt = null;
    this.display = { width: target.width, height: target.height };
    this.readyWaiters = [];
    this.everConnected = false;

    this._deadlineTimer = null;
    this._idleTimer = null;
    this._nopTimer = null;
  }

  // ------------------------------------------------------------- lifecycle

  /** Start (or restart) the anchor connection. */
  _startAnchor() {
    if (this.phase === 'connecting' || this.phase === 'connected' || this.phase === 'closed') return;
    this.phase = 'connecting';
    this.connectedAt = null;
    const t = this.target;
    const anchor = new GuacdConnection({
      host: this.config.guacdHost,
      port: this.config.guacdPort,
      timeoutMs: this.config.connectTimeoutMs,
      select: 'rdp',
      size: [t.width, t.height, t.dpi],
      image: ['image/png', 'image/jpeg', 'image/webp'],
      timezone: t.timezone || null,
      name: 'webrdp-anchor',
      args: {
        hostname: t.host,
        port: t.port,
        username: t.user,
        password: t.password,
        domain: t.domain || '',
        width: t.width,
        height: t.height,
        dpi: t.dpi,
        security: t.security,
        'ignore-cert': t.ignoreCert ? 'true' : 'false',
        'resize-method': 'display-update',
        'enable-font-smoothing': 'true',
        'client-name': 'WebRDP',
        'server-layout': t.keyboardLayout || '',
        timezone: t.timezone || '',
      },
    });
    this.anchor = anchor;
    const connectTimer = setTimeout(() => {
      if (anchor === this.anchor && this.phase === 'connecting') {
        anchor.close('connect timeout');
        this._anchorFailed(Status.UPSTREAM_TIMEOUT, '连接远程主机超时');
      }
    }, this.config.connectTimeoutMs);

    anchor.on('ready', (id) => {
      this.connectionId = id;
      this.log.info('guacd connection ready', { session: this.shortId, connection: id });
      this._nopTimer = setInterval(() => anchor.write(encode('nop')), ANCHOR_NOP_MS);
    });
    anchor.on('instructions', (list) => {
      for (const ins of list) {
        switch (ins.opcode) {
          case 'sync':
            anchor.write(encode('sync', ins.args[0]));
            if (this.phase === 'connecting') {
              clearTimeout(connectTimer);
              this._onConnected();
            }
            break;
          case 'size':
            if (ins.args[0] === '0') {
              const w = Number(ins.args[1]);
              const h = Number(ins.args[2]);
              if (w > 0 && h > 0 && (w !== this.display.width || h !== this.display.height)) {
                this.display = { width: w, height: h };
                if (this.phase === 'connected') this.broadcastState();
              }
            }
            break;
          case 'error':
            clearTimeout(connectTimer);
            this._anchorFailed(Number(ins.args[1]) || Status.UPSTREAM_ERROR, ins.args[0] || 'RDP error');
            break;
          case 'required':
            clearTimeout(connectTimer);
            this._anchorFailed(Status.CLIENT_UNAUTHORIZED, `远程主机要求额外凭据: ${ins.args.join(', ')}`);
            break;
          case 'disconnect':
            clearTimeout(connectTimer);
            this._anchorFailed(Status.UPSTREAM_ERROR, '远程会话已断开');
            break;
          default:
            break;
        }
      }
    });
    anchor.on('close', (info) => {
      clearTimeout(connectTimer);
      if (anchor !== this.anchor) return;
      if (info.local) return;
      this._anchorFailed(info.code || Status.UPSTREAM_ERROR, info.message);
    });
    anchor.connect();
  }

  _onConnected() {
    this.phase = 'connected';
    this.connectedAt = Date.now();
    this.everConnected = true;
    this.log.info('RDP session connected', { session: this.shortId, host: this.target.host });
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.resolve();
    this.broadcastState();
  }

  _anchorFailed(code, message) {
    if (this.phase === 'closed' || this.phase === 'idle') return;
    const wasConnected = this.phase === 'connected';
    this.log.warn('RDP session failed', { session: this.shortId, code, message, wasConnected });
    this._stopAnchor();
    this.phase = 'idle';
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.reject(Object.assign(new Error(message), { code }));
    // Kick everybody; identities (incl. reserved primary) are retained so that
    // the automatic reconnect of the browsers restores the same roles.
    for (const att of [...this.attachments.values()]) {
      this._closeAttachment(att, code, message);
    }
    if (!this.everConnected && isFatal(code)) {
      // Credentials are wrong: nothing worth keeping.
      this.close('authentication failed');
    }
  }

  _stopAnchor() {
    clearInterval(this._nopTimer);
    this._nopTimer = null;
    if (this.anchor) {
      const a = this.anchor;
      this.anchor = null;
      a.close('session stopped');
    }
    this.connectionId = null;
    this.connectedAt = null;
  }

  _whenReady() {
    if (this.phase === 'connected') return Promise.resolve();
    if (this.phase === 'closed') return Promise.reject(Object.assign(new Error('会话已关闭'), { code: Status.SESSION_CLOSED }));
    return new Promise((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
      this._startAnchor();
    });
  }

  close(reason = 'closed') {
    if (this.phase === 'closed') return;
    this.log.info('session closed', { session: this.shortId, reason });
    for (const att of [...this.attachments.values()]) {
      this._closeAttachment(att, Status.SESSION_CLOSED, '会话已结束');
    }
    this._stopAnchor();
    this.phase = 'closed';
    clearTimeout(this._deadlineTimer);
    clearTimeout(this._idleTimer);
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.reject(Object.assign(new Error('会话已关闭'), { code: Status.SESSION_CLOSED }));
    this.emit('closed');
  }

  // -------------------------------------------------------------- identity

  _newIdentity() {
    const id = randomId(9);
    const token = randomId(24);
    this.identities.set(id, sha256(token));
    // Bound memory: forget the oldest identities that are not participants.
    if (this.identities.size > this.config.maxParticipants * 10) {
      for (const k of this.identities.keys()) {
        if (!this.control.has(k)) { this.identities.delete(k); break; }
      }
    }
    return { id, token };
  }

  _checkIdentity(id, token) {
    if (typeof id !== 'string' || typeof token !== 'string') return false;
    const stored = this.identities.get(id);
    if (!stored) return false;
    const got = sha256(token);
    return crypto.timingSafeEqual(stored, got);
  }

  /** Ping an existing websocket; resolves true if it answers in time. */
  _isAlive(ws) {
    return new Promise((resolve) => {
      if (ws.readyState !== 1) return resolve(false);
      let done = false;
      const finish = (v) => { if (!done) { done = true; clearTimeout(t); ws.off('pong', onPong); resolve(v); } };
      const onPong = () => finish(true);
      const t = setTimeout(() => finish(false), LIVENESS_TIMEOUT_MS);
      ws.on('pong', onPong);
      try { ws.ping(); } catch { finish(false); }
    });
  }

  // ------------------------------------------------------------ attachment

  /**
   * Attach a browser websocket.
   * @param ws
   * @param info { clientId, resumeToken, label, device, caps }
   */
  async attach(ws, info) {
    if (this.phase === 'closed') {
      return this._reject(ws, Status.SESSION_CLOSED, '会话已结束，请重试');
    }
    clearTimeout(this._idleTimer);
    this._idleTimer = null;

    let identity = null;
    let token = null;
    let resumed = false;
    let replaced = null;
    if (this._checkIdentity(info.clientId, info.resumeToken)) {
      const current = this.attachments.get(info.clientId);
      if (current) {
        const alive = await this._isAlive(current.ws);
        if (ws.readyState !== 1) return; // gave up while we were checking
        if (alive) {
          this.log.info('identity in use by a live connection, issuing new identity', { session: this.shortId });
        } else {
          replaced = current;
          identity = { id: info.clientId };
          token = info.resumeToken;
          resumed = true;
        }
      } else {
        identity = { id: info.clientId };
        token = info.resumeToken;
        resumed = true;
      }
    }
    if (!identity) {
      if (this.control.onlineCount() >= this.config.maxParticipants) {
        return this._reject(ws, Status.CLIENT_TOO_MANY, '共享会话人数已满');
      }
      const ni = this._newIdentity();
      identity = { id: ni.id };
      token = ni.token;
    }

    const att = new Attachment(this, ws, identity, info);
    let events = [];
    if (replaced) {
      // Same person, new connection (refresh / network switch while the old
      // socket is half-open). Keep role and control untouched.
      this._releaseInput(replaced);
      replaced.ws.removeAllListeners('close');
      this._closeAttachment(replaced, Status.SESSION_CONFLICT, '已在新的连接中恢复', true);
      this.attachments.set(att.id, att);
    } else {
      this.attachments.set(att.id, att);
      ({ events } = this.control.join(att.id, { label: info.label, device: info.device }));
    }

    // Guacamole tunnel UUID handshake (marks the tunnel as open in guacamole-common-js).
    att.sendRaw(encode(INTERNAL, randomId(16)));
    att.sendCtl({
      t: 'welcome',
      you: { id: att.id, token, resumed },
      session: { id: this.shortId, createdAt: this.createdAt },
      serverNow: Date.now(),
    });

    ws.on('message', (data, isBinary) => this._onClientMessage(att, isBinary ? null : data.toString('utf8')));
    ws.on('close', () => this._detach(att));
    ws.on('error', () => {});

    this.log.info('participant attached', {
      session: this.shortId, client: att.id, resumed, role: this.control.isPrimary(att.id) ? 'primary' : 'viewer',
      online: this.control.onlineCount(),
    });
    this._afterChange(events);
    // A resumed/replaced connection produces no events; still sync its UI.
    if (!events.length) this._sendState(att);

    try {
      await this._whenReady();
    } catch (err) {
      // _anchorFailed already closed the attachments.
      if (!att.closed) this._closeAttachment(att, err.code || Status.UPSTREAM_ERROR, err.message);
      return;
    }
    if (att.closed) return;
    this._openJoiner(att);
  }

  _reject(ws, code, message) {
    rejectSocket(ws, code, message);
  }

  _openJoiner(att) {
    const t = this.target;
    const audio = Array.isArray(att.caps.audio) ? att.caps.audio : [];
    const image = Array.isArray(att.caps.image) && att.caps.image.length ? att.caps.image : ['image/png', 'image/jpeg'];
    const guac = new GuacdConnection({
      host: this.config.guacdHost,
      port: this.config.guacdPort,
      timeoutMs: this.config.connectTimeoutMs,
      select: this.connectionId,
      size: [this.display.width, this.display.height, t.dpi],
      audio,
      image,
      timezone: t.timezone || null,
      name: att.label || att.id,
      args: {
        // Joining users never receive credentials; settings come from the owner.
        width: this.display.width,
        height: this.display.height,
        dpi: t.dpi,
        'read-only': '',
      },
    });
    att.guac = guac;
    guac.on('instructions', (list) => {
      if (att.closed) return;
      let out = '';
      for (const ins of list) out += toBrowser(ins);
      att.sendRaw(out);
    });
    guac.on('close', (info) => {
      if (att.guac !== guac || att.closed) return;
      att.guac = null;
      if (this.phase === 'connected') {
        this.log.warn('joiner connection lost', { session: this.shortId, client: att.id, message: info.message });
        this._closeAttachment(att, info.code || Status.UPSTREAM_ERROR, '与远程会话的连接中断');
      }
    });
    guac.connect();
  }

  _onClientMessage(att, text) {
    if (att.closed || text === null) return;
    let list;
    try {
      list = att.parser.push(text);
    } catch (err) {
      this.log.warn('bad instruction from browser', { session: this.shortId, client: att.id, error: err.message });
      this._closeAttachment(att, Status.CLIENT_BAD_REQUEST, '协议错误');
      return;
    }
    let forward = '';
    for (const ins of list) {
      const op = ins.opcode;
      if (op === INTERNAL) {
        if (ins.args[0] === 'ping') att.sendRaw(ins.raw);
        continue;
      }
      if (op === CTL) {
        this._onControlMessage(att, ins.args[0]);
        continue;
      }
      if (op === 'disconnect') {
        att.intentional = true;
        continue;
      }
      if (PASSTHROUGH.has(op)) {
        forward += toGuacd(ins);
        continue;
      }
      const isCtl = this.control.isController(att.id);
      if (GATED.has(op)) {
        if (!isCtl) { this._denied(att); continue; }
        if (!this._validateAndTrack(att, ins)) continue;
        forward += toGuacd(ins);
        continue;
      }
      if (STREAM_PAYLOAD.has(op)) {
        const idx = ins.args[0];
        if (!isCtl || !att.openStreams.has(idx)) continue;
        if (op === 'end') att.openStreams.delete(idx);
        forward += toGuacd(ins);
        continue;
      }
      // Unknown / unsupported opcode: drop.
    }
    if (forward && att.guac) att.guac.write(forward);
  }

  _validateAndTrack(att, ins) {
    const a = ins.args;
    switch (ins.opcode) {
      case 'key': {
        const keysym = a[0];
        if (!/^\d{1,10}$/.test(keysym || '')) return false;
        if (a[1] === '1') att.pressedKeys.add(keysym);
        else att.pressedKeys.delete(keysym);
        return true;
      }
      case 'mouse': {
        const x = Number(a[0]); const y = Number(a[1]); const mask = Number(a[2]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isInteger(mask)) return false;
        att.mouse = { x, y, mask };
        return true;
      }
      case 'size': {
        const w = Number(a[0]); const h = Number(a[1]);
        return Number.isInteger(w) && Number.isInteger(h) && w >= 320 && h >= 200 && w <= 8192 && h <= 8192;
      }
      default:
        if (STREAM_OPEN.has(ins.opcode)) att.openStreams.add(a[0]);
        return true;
    }
  }

  _denied(att) {
    const now = Date.now();
    if (now - att.lastDenied < DENIED_NOTICE_INTERVAL_MS) return;
    att.lastDenied = now;
    att.sendCtl({ t: 'denied', reason: 'not_controller' });
    this._sendState(att);
  }

  _onControlMessage(att, json) {
    let msg;
    try { msg = JSON.parse(json); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    let res;
    switch (msg.op) {
      case 'request':
        res = this.control.requestControl(att.id);
        break;
      case 'release':
        res = this.control.releaseControl(att.id);
        break;
      case 'state':
        this._sendState(att);
        return;
      default:
        return;
    }
    att.sendCtl({ t: 'ack', op: msg.op, seq: msg.seq, ok: res.ok, reason: res.reason });
    this._afterChange(res.events, att.id);
    if (!res.events.length) this._sendState(att);
  }

  _detach(att) {
    if (att.closed && !this.attachments.has(att.id)) return;
    if (this.attachments.get(att.id) !== att) { att.dispose(); return; }
    this._releaseInput(att);
    this.attachments.delete(att.id);
    att.dispose();
    const events = this.control.leave(att.id);
    this.log.info('participant detached', {
      session: this.shortId, client: att.id, intentional: !!att.intentional, online: this.control.onlineCount(),
    });
    this._afterChange(events);
  }

  _closeAttachment(att, code, message, silent = false) {
    if (!silent) {
      try {
        att.sendCtl({ t: 'fatal', code, message, retry: !isFatal(code) });
        att.sendRaw(encode('error', message, code));
      } catch { /* ignore */ }
    }
    att.dispose();
    try { att.ws.close(isFatal(code) ? 4001 : 4000, String(code)); } catch { /* ignore */ }
    // The websocket 'close' handler will call _detach (unless removed).
    if (silent) return;
    setTimeout(() => { if (att.ws.readyState !== 3) att.ws.terminate(); }, 3000).unref();
  }

  /** Release keys / buttons / streams held by a participant losing control. */
  _releaseInput(att) {
    const g = att.guac || this.anchor;
    if (!g) { att.pressedKeys.clear(); return; }
    let out = '';
    for (const k of att.pressedKeys) out += encode('key', k, 0);
    att.pressedKeys.clear();
    if (att.mouse.mask) {
      out += encode('mouse', att.mouse.x, att.mouse.y, 0);
      att.mouse.mask = 0;
    }
    for (const idx of att.openStreams) out += encode('end', idx);
    att.openStreams.clear();
    if (out) g.write(out);
  }

  // ------------------------------------------------------------ broadcasting

  _afterChange(events, actorId = null) {
    for (const ev of events) {
      if (ev.type === 'control' && ev.from) {
        const prev = this.attachments.get(ev.from);
        if (prev) this._releaseInput(prev);
      }
    }
    if (events.length) {
      const described = events
        .filter((e) => ['control', 'primary_offline', 'primary_returned', 'primary_assigned', 'primary_expired', 'joined', 'left'].includes(e.type))
        .map((e) => ({
          ...e,
          fromLabel: e.from ? this.control.label(e.from) || this._labelOf(e.from) : null,
          toLabel: e.to ? this.control.label(e.to) : null,
          label: e.id ? this.control.label(e.id) || this._labelOf(e.id) : null,
          actor: actorId,
        }));
      if (described.length) {
        for (const att of this.attachments.values()) att.sendCtl({ t: 'events', events: described });
      }
      this.broadcastState();
    }
    this._schedule();
  }

  _labelOf(id) {
    const att = this.attachments.get(id);
    return att ? att.label : null;
  }

  _schedule() {
    clearTimeout(this._deadlineTimer);
    this._deadlineTimer = null;
    if (this.phase === 'closed') return;
    const deadline = this.control.nextDeadline();
    if (deadline !== null) {
      this._deadlineTimer = setTimeout(() => {
        const events = this.control.tick();
        this._afterChange(events);
      }, Math.max(0, deadline - Date.now()) + 5);
    }
    if (this.attachments.size === 0 && this.phase !== 'closed' && !this._idleTimer) {
      this._idleTimer = setTimeout(() => {
        if (this.attachments.size === 0) this.close('idle');
      }, this.config.sessionIdleMs);
    }
  }

  stateFor(att) {
    const snap = this.control.snapshot();
    return {
      t: 'state',
      ...snap,
      you: {
        id: att.id,
        role: snap.primaryId === att.id ? 'primary' : 'viewer',
        controller: snap.controllerId === att.id,
      },
      phase: this.phase,
      connectedAt: this.connectedAt,
      createdAt: this.createdAt,
      display: this.display,
      serverNow: Date.now(),
    };
  }

  _sendState(att) { att.sendCtl(this.stateFor(att)); }

  broadcastState() {
    for (const att of this.attachments.values()) this._sendState(att);
  }

  stats() {
    return {
      id: this.shortId,
      phase: this.phase,
      online: this.control.onlineCount(),
      connectedAt: this.connectedAt,
      createdAt: this.createdAt,
    };
  }
}

module.exports = { Session, CTL, asciiJson, isFatal, rejectSocket, GATED };
