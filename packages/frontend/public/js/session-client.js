/**
 * Browser-side session client wrapping Guacamole.Client + WebSocketTunnel.
 *
 * Responsibilities:
 *  - Request a one-time ticket from POST /api/session (keeping credentials out of WS URLs).
 *  - Persist per-target identity (clientId + resumeToken) in sessionStorage so
 *    page refresh or transient reconnect restores primary/viewer identity.
 *  - Intercept the gateway's `webrdp` control instructions inside the tunnel.
 *  - Track server-authoritative connection duration using `connectedAt` and
 *    `serverNow` clock offset (never fabricating uptime when disconnected).
 *  - Automatic reconnect with exponential backoff + jitter on retryable errors,
 *    plus immediate retry on `online` / `visibilitychange`.
 */

const CTL_OPCODE = 'webrdp';
const IDENTITY_PREFIX = 'webrdp:id:';

function identityKey(params) {
  return `${IDENTITY_PREFIX}${String(params.host || '').toLowerCase()}:${params.port || 3389}:${String(params.domain || '').toLowerCase()}:${String(params.user || '').toLowerCase()}`;
}

function loadIdentity(params) {
  try {
    const raw = sessionStorage.getItem(identityKey(params));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (obj && typeof obj.id === 'string' && typeof obj.token === 'string') return obj;
  } catch { /* ignore */ }
  return null;
}

function saveIdentity(params, id, token) {
  try {
    sessionStorage.setItem(identityKey(params), JSON.stringify({ id, token }));
  } catch { /* ignore */ }
}

function detectDevice() {
  const w = window.innerWidth || 0;
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (coarse && w <= 768) return 'mobile';
  if (coarse) return 'tablet';
  return 'desktop';
}

function detectCaps() {
  const image = ['image/png', 'image/jpeg'];
  try {
    const c = document.createElement('canvas');
    if (c.toDataURL && c.toDataURL('image/webp').startsWith('data:image/webp')) {
      image.push('image/webp');
    }
  } catch { /* ignore */ }
  return { audio: [], image };
}

function tunnelBaseUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/tunnel`;
}

export class SessionClient extends EventTarget {
  constructor() {
    super();
    this.params = null;
    this.guac = null;
    this.tunnel = null;
    this.state = null; // last server 'state' snapshot
    this.status = 'disconnected'; // disconnected | connecting | connected | reconnecting | error
    this.clockOffset = 0; // serverNow - Date.now()
    this.connectedAt = null; // server epoch ms of active RDP session
    this.frozenDurationMs = null; // last known duration when disconnected/reconnecting
    this._manualDisconnect = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._seq = 0;
    this._lastFatal = null;
    this._connectGen = 0;

    this._onOnline = () => {
      if (this.status === 'reconnecting' && !this._manualDisconnect) {
        this.reconnectNow();
      }
    };
    this._onVisibility = () => {
      if (document.visibilityState === 'visible' && this.status === 'reconnecting' && !this._manualDisconnect) {
        this.reconnectNow();
      }
    };
    window.addEventListener('online', this._onOnline);
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  get isController() {
    return !!(this.state && this.state.you && this.state.you.controller && this.status === 'connected');
  }

  get isPrimary() {
    return !!(this.state && this.state.you && this.state.you.role === 'primary');
  }

  /**
   * Real elapsed RDP session duration in ms, anchored to server time.
   * Returns null if never connected; freezes while reconnecting/disconnected
   * so we never show fake uptime.
   */
  getSessionDurationMs() {
    if (this.status === 'connected' && this.connectedAt) {
      return Math.max(0, (Date.now() + this.clockOffset) - this.connectedAt);
    }
    return this.frozenDurationMs;
  }

  async connect(params) {
    this.params = { ...params };
    this._manualDisconnect = false;
    this._reconnectAttempt = 0;
    this._lastFatal = null;
    this.frozenDurationMs = null;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    await this._open(false);
  }

  reconnectNow() {
    if (!this.params) return;
    this._manualDisconnect = false;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._open(true);
  }

  disconnect() {
    this._manualDisconnect = true;
    this._connectGen++;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    if (this.status === 'connected' && this.connectedAt) {
      this.frozenDurationMs = this.getSessionDurationMs();
    }
    this._teardownClient();
    this._setStatus('disconnected', '已断开');
  }

  requestControl() {
    this._sendCtl({ op: 'request', seq: ++this._seq });
  }

  releaseControl() {
    this._sendCtl({ op: 'release', seq: ++this._seq });
  }

  sendMouseState(mouseState) {
    if (!this.guac || !this.isController) return;
    this.guac.sendMouseState(mouseState, false);
  }

  sendKeyEvent(pressed, keysym) {
    if (!this.guac || !this.isController) return;
    this.guac.sendKeyEvent(pressed ? 1 : 0, keysym);
  }

  sendSize(width, height) {
    if (!this.guac || !this.isController) return;
    this.guac.sendSize(Math.round(width), Math.round(height));
  }

  sendClipboard(text) {
    if (!this.guac || !this.isController || typeof text !== 'string') return;
    try {
      const stream = this.guac.createClipboardStream('text/plain');
      const writer = new window.Guacamole.StringWriter(stream);
      writer.sendText(text);
      writer.sendEnd();
    } catch { /* ignore */ }
  }

  _sendCtl(obj) {
    if (!this.tunnel || !this.tunnel.isConnected()) return;
    this.tunnel.sendMessage(CTL_OPCODE, JSON.stringify(obj));
  }

  _setStatus(status, message, extra = {}) {
    this.status = status;
    this._emit('status', { status, message, ...extra });
  }

  _teardownClient() {
    if (this.guac) {
      const g = this.guac;
      this.guac = null;
      g.onstatechange = null;
      g.onerror = null;
      g.onclipboard = null;
      try { g.disconnect(); } catch { /* ignore */ }
    }
    if (this.tunnel) {
      const t = this.tunnel;
      this.tunnel = null;
      t.onerror = null;
      t.onstatechange = null;
      t.oninstruction = null;
      try { t.disconnect(); } catch { /* ignore */ }
    }
  }

  async _open(isReconnect) {
    const gen = ++this._connectGen;
    this._teardownClient();
    this._lastFatal = null;
    this._setStatus(isReconnect ? 'reconnecting' : 'connecting', isReconnect ? '正在重连...' : '正在连接...');

    const p = this.params;
    const saved = loadIdentity(p);
    let ticketResp;
    try {
      const body = {
        host: p.host,
        port: Number.parseInt(p.port || '3389', 10),
        user: p.user,
        password: p.password,
        domain: p.domain || '',
        width: Number.parseInt(p.width || '1024', 10),
        height: Number.parseInt(p.height || '768', 10),
        dpi: Number.parseInt(p.dpi || '96', 10),
        security: p.security || 'any',
        ignoreCert: p.ignoreCert !== 'false',
        name: p.name || '',
        device: detectDevice(),
        caps: detectCaps(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      };
      if (saved) {
        body.clientId = saved.id;
        body.resumeToken = saved.token;
      }
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (gen !== this._connectGen) return;
      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429;
        this._handleFailure(data.error || `请求失败 (${res.status})`, retryable, res.status);
        return;
      }
      ticketResp = data;
    } catch (err) {
      if (gen !== this._connectGen) return;
      this._handleFailure('无法连接服务器，请检查网络', true, 0);
      return;
    }

    const Guacamole = window.Guacamole;
    if (!Guacamole) {
      this._handleFailure('缺少 Guacamole 客户端脚本', false, 0);
      return;
    }

    const tunnel = new Guacamole.WebSocketTunnel(tunnelBaseUrl());
    tunnel.receiveTimeout = 20000;
    tunnel.unstableThreshold = 3000;
    this.tunnel = tunnel;

    const client = new Guacamole.Client(tunnel);
    this.guac = client;

    // Intercept gateway control instructions before Guacamole.Client sees them.
    const origOnInstruction = tunnel.oninstruction;
    tunnel.oninstruction = (opcode, args) => {
      if (gen !== this._connectGen) return;
      if (opcode === CTL_OPCODE) {
        this._onControlInstruction(args[0]);
        return;
      }
      if (origOnInstruction) origOnInstruction.call(tunnel, opcode, args);
    };

    const origTunnelState = tunnel.onstatechange;
    tunnel.onstatechange = (st) => {
      if (gen !== this._connectGen) return;
      if (origTunnelState) origTunnelState.call(tunnel, st);
      if (st === Guacamole.Tunnel.State.UNSTABLE) {
        this._emit('unstable', { unstable: true });
      } else if (st === Guacamole.Tunnel.State.OPEN) {
        this._emit('unstable', { unstable: false });
      } else if (st === Guacamole.Tunnel.State.CLOSED) {
        if (!this._manualDisconnect && this.status !== 'error') {
          this._onUnexpectedClose();
        }
      }
    };

    tunnel.onerror = (status) => {
      if (gen !== this._connectGen) return;
      if (this._manualDisconnect) return;
      this._onUnexpectedClose(status && status.message, status && status.code);
    };

    client.onstatechange = (st) => {
      if (gen !== this._connectGen) return;
      // 3 = CONNECTED, 5 = DISCONNECTED
      if (st === 3) {
        this._reconnectAttempt = 0;
        this.frozenDurationMs = null;
        this._setStatus('connected', '已连接');
        this._emit('display', { display: client.getDisplay() });
      } else if (st === 5 && !this._manualDisconnect && this.status !== 'error') {
        this._onUnexpectedClose();
      }
    };

    client.onerror = (status) => {
      if (gen !== this._connectGen) return;
      if (this._manualDisconnect) return;
      const code = status ? status.code : 0;
      const msg = (status && status.message) || '远程连接发生错误';
      const fatal = this._lastFatal;
      const retry = fatal ? fatal.retry : !(code >= 0x0300 && code <= 0x03ff && code !== 0x0308);
      this._handleFailure(fatal ? fatal.message : msg, retry, code);
    };

    client.onclipboard = (stream, mimetype) => {
      if (mimetype !== 'text/plain') return;
      const reader = new Guacamole.StringReader(stream);
      let text = '';
      reader.ontext = (chunk) => { text += chunk; };
      reader.onend = () => { this._emit('clipboard', { text }); };
    };

    const display = client.getDisplay();
    display.onresize = (w, h) => {
      this._emit('resize', { width: w, height: h });
    };
    display.showCursor(true);
    this._emit('display', { display });

    client.connect(`ticket=${encodeURIComponent(ticketResp.ticket)}`);
  }

  _onControlInstruction(rawJson) {
    let msg;
    try { msg = JSON.parse(rawJson); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.serverNow === 'number') {
      this.clockOffset = msg.serverNow - Date.now();
    }
    switch (msg.t) {
      case 'welcome':
        if (msg.you && msg.you.id && msg.you.token && this.params) {
          saveIdentity(this.params, msg.you.id, msg.you.token);
        }
        this._emit('welcome', msg);
        break;
      case 'state':
        this.state = msg;
        if (msg.connectedAt) {
          this.connectedAt = msg.connectedAt;
        }
        if (msg.phase === 'connected' && this.status !== 'connected') {
          this._reconnectAttempt = 0;
          this.frozenDurationMs = null;
          this._setStatus('connected', '已连接');
        }
        this._emit('state', msg);
        break;
      case 'events':
        if (Array.isArray(msg.events)) this._emit('events', msg.events);
        break;
      case 'denied':
        this._emit('denied', msg);
        break;
      case 'fatal':
        this._lastFatal = msg;
        break;
      case 'ack':
        this._emit('ack', msg);
        break;
      default:
        break;
    }
  }

  _onUnexpectedClose(message, code) {
    if (this._manualDisconnect) return;
    const fatal = this._lastFatal;
    if (fatal) {
      this._handleFailure(fatal.message, fatal.retry, fatal.code);
      return;
    }
    const retry = !(code >= 0x0300 && code <= 0x03ff && code !== 0x0308);
    this._handleFailure(message || '连接已中断', retry, code || 0);
  }

  _handleFailure(message, retryable, code) {
    if (this.status === 'connected' && this.connectedAt) {
      this.frozenDurationMs = this.getSessionDurationMs();
    }
    this._teardownClient();
    if (!retryable || this._manualDisconnect) {
      this._setStatus('error', message, { code, retryable: false });
      return;
    }
    this._reconnectAttempt++;
    const base = Math.min(15000, 1000 * (1.6 ** Math.min(this._reconnectAttempt - 1, 6)));
    const delayMs = Math.round(base + Math.random() * 500);
    this._setStatus('reconnecting', `${message}，${Math.ceil(delayMs / 1000)}s 后重连`, {
      attempt: this._reconnectAttempt,
      delayMs,
      code,
      retryable: true,
    });
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (!this._manualDisconnect) this._open(true);
    }, delayMs);
  }

  destroy() {
    window.removeEventListener('online', this._onOnline);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.disconnect();
  }
}
