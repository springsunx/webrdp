'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const { Parser, encode, Status } = require('./protocol');

let seq = 0;

/**
 * One TCP connection to guacd, i.e. one Guacamole "user".
 *
 * Handles the Guacamole handshake:
 *   select -> args -> size/audio/video/image/timezone/name -> connect -> ready
 * and then emits every subsequent instruction batch via the `instructions`
 * event. `select` is either the protocol ("rdp") for the owner connection, or
 * an existing connection id ("$...") for users joining a shared connection.
 *
 * Events:
 *   ready(connectionId)
 *   instructions(Array<{opcode,args,raw}>)
 *   close({ code, message, remote })   always emitted exactly once
 */
class GuacdConnection extends EventEmitter {
  constructor(opts) {
    super();
    this.id = ++seq;
    this.opts = {
      host: 'localhost',
      port: 4822,
      timeoutMs: 15000,
      size: [1024, 768, 96],
      audio: [],
      video: [],
      image: ['image/png', 'image/jpeg', 'image/webp'],
      timezone: null,
      name: null,
      args: {},
      log: null,
      ...opts,
    };
    this.state = 'idle'; // idle | handshake | open | closed
    this.connectionId = null;
    this.protocolVersion = null;
    this.parser = new Parser();
    this.decoder = new StringDecoder('utf8');
    this.socket = null;
    this._closeInfo = null;
    this._timer = null;
  }

  connect() {
    if (this.state !== 'idle') throw new Error('already connected');
    this.state = 'handshake';
    const { host, port, timeoutMs } = this.opts;
    const socket = net.connect({ host, port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);

    this._timer = setTimeout(() => {
      this._fail(Status.UPSTREAM_TIMEOUT, 'guacd handshake timed out');
    }, timeoutMs);

    socket.on('connect', () => {
      this._send(encode('select', this.opts.select));
    });
    socket.on('data', (buf) => this._onData(this.decoder.write(buf)));
    socket.on('error', (err) => {
      const code = err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND'
        ? Status.UPSTREAM_NOT_FOUND
        : Status.UPSTREAM_ERROR;
      this._fail(code, `guacd connection error: ${err.code || err.message}`);
    });
    socket.on('close', () => {
      this._fail(Status.UPSTREAM_ERROR, 'guacd closed the connection', true);
    });
    return this;
  }

  _onData(text) {
    if (this.state === 'closed' || !text) return;
    let list;
    try {
      list = this.parser.push(text);
    } catch (err) {
      this._fail(Status.UPSTREAM_ERROR, `protocol error from guacd: ${err.message}`);
      return;
    }
    if (!list.length) return;
    if (this.state === 'handshake') {
      while (list.length && this.state === 'handshake') {
        this._handshakeStep(list.shift());
      }
      if (!list.length || this.state !== 'open') return;
    }
    this.emit('instructions', list);
  }

  _handshakeStep(ins) {
    if (ins.opcode === 'args') {
      this._sendHandshake(ins.args);
    } else if (ins.opcode === 'ready') {
      clearTimeout(this._timer);
      this.connectionId = ins.args[0] || null;
      this.state = 'open';
      this.emit('ready', this.connectionId);
    } else if (ins.opcode === 'error') {
      this._fail(Number(ins.args[1]) || Status.UPSTREAM_ERROR, ins.args[0] || 'guacd error');
    } else if (ins.opcode === 'disconnect') {
      this._fail(Status.UPSTREAM_ERROR, 'guacd refused the connection');
    }
    // Anything else during the handshake is ignored.
  }

  _sendHandshake(argNames) {
    const o = this.opts;
    let version = null;
    if (argNames.length && /^VERSION_\d+_\d+_\d+$/.test(argNames[0])) version = argNames[0];
    this.protocolVersion = version;
    const atLeast = (maj, min) => {
      if (!version) return false;
      const [, a, b] = version.split('_').map(Number);
      return a > maj || (a === maj && b >= min);
    };
    const [w, h, dpi] = o.size;
    let out = encode('size', w, h, dpi);
    out += encode('audio', ...o.audio);
    out += encode('video', ...o.video);
    out += encode('image', ...o.image);
    if (o.timezone && atLeast(1, 1)) out += encode('timezone', o.timezone);
    if (o.name && atLeast(1, 3)) out += encode('name', o.name);
    const values = argNames.map((name, i) => {
      if (i === 0 && version) return version;
      const v = o.args[name];
      return v === undefined || v === null ? '' : String(v);
    });
    out += encode('connect', ...values);
    this._send(out);
  }

  _send(data) {
    if (!this.socket || this.state === 'closed') return false;
    return this.socket.write(data);
  }

  /** Forward raw protocol text (already validated) to guacd. */
  write(raw) {
    if (this.state !== 'open') return false;
    return this._send(raw);
  }

  pause() { if (this.socket && this.state !== 'closed') this.socket.pause(); }
  resume() { if (this.socket && this.state !== 'closed') this.socket.resume(); }

  /** Gracefully end this guacd user. */
  close(message = 'closed') {
    if (this.state === 'closed') return;
    if (this.state === 'open') {
      try { this.socket.write(encode('disconnect')); } catch { /* ignore */ }
    }
    this._fail(Status.SUCCESS, message, false, true);
  }

  _fail(code, message, remote = false, local = false) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearTimeout(this._timer);
    this._closeInfo = { code, message, remote, local };
    if (this.socket) {
      this.socket.removeAllListeners('data');
      this.socket.on('error', () => {});
      if (local) this.socket.end();
      else this.socket.destroy();
      // Ensure we never leak a half-closed socket.
      const s = this.socket;
      setTimeout(() => s.destroy(), 2000).unref();
    }
    this.emit('close', this._closeInfo);
  }
}

module.exports = { GuacdConnection };
