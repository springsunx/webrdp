'use strict';

/**
 * Minimal fake guacd used by integration tests and by `npm run dev:fake`.
 *
 * Implements the parts of guacd that the gateway relies on:
 *  - handshake (select / args / size / audio / video / image / timezone / name / connect / ready)
 *  - connection sharing: `select $id` joins an existing connection
 *  - the connection lives as long as at least one user is connected
 *  - periodic `sync` frames, `size` of the default layer
 *  - authentication failure when password === 'bad'
 *  - "drawing" of mouse/key input so that a browser demo shows activity
 */

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const { Parser, encode } = require('../../src/guac/protocol');

const ARG_NAMES = [
  'VERSION_1_5_0', 'hostname', 'port', 'domain', 'username', 'password', 'width', 'height', 'dpi',
  'security', 'ignore-cert', 'resize-method', 'read-only', 'enable-font-smoothing', 'client-name',
  'server-layout', 'timezone',
];

class FakeConnection {
  constructor(server, settings) {
    this.server = server;
    this.id = `$${crypto.randomUUID()}`;
    this.settings = settings;
    this.users = new Set();
    this.width = Number(settings.width) || 1024;
    this.height = Number(settings.height) || 768;
    this.closed = false;
    this.syncTimer = setInterval(() => this.broadcast(encode('sync', Date.now())), server.syncMs);
  }

  broadcast(data, except = null) {
    for (const u of this.users) if (u !== except) u.send(data);
  }

  initialFrame() {
    const w = this.width; const h = this.height;
    let out = encode('size', 0, w, h);
    // "desktop" background + taskbar
    out += encode('rect', 0, 0, 0, w, h) + encode('cfill', 14, 0, 0, 90, 160, 255);
    out += encode('rect', 0, 0, h - 40, w, 40) + encode('cfill', 14, 0, 30, 30, 30, 255);
    out += encode('rect', 0, 40, 40, Math.round(w * 0.5), Math.round(h * 0.45)) + encode('cfill', 14, 0, 240, 240, 240, 255);
    out += encode('rect', 0, 40, 40, Math.round(w * 0.5), 28) + encode('cfill', 14, 0, 0, 120, 215, 255);
    out += encode('sync', Date.now());
    return out;
  }

  remove(user) {
    this.users.delete(user);
    if (this.users.size === 0) this.close();
  }

  /** Simulate the RDP server dropping the connection. */
  abort(message = 'RDP server closed connection', code = 0x0203) {
    this.broadcast(encode('error', message, code) + encode('disconnect'));
    for (const u of [...this.users]) u.end();
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.syncTimer);
    this.server.connections.delete(this.id);
    this.server.emit('connection-closed', this);
  }
}

class FakeUser {
  constructor(server, socket) {
    this.server = server;
    this.socket = socket;
    this.parser = new Parser();
    this.decoder = new StringDecoder('utf8');
    this.state = 'select';
    this.handshake = {};
    this.received = [];
    this.connection = null;
    this.owner = false;
    socket.on('data', (b) => this.onData(this.decoder.write(b)));
    socket.on('close', () => this.onClose());
    socket.on('error', () => {});
  }

  send(data) { if (!this.socket.destroyed) this.socket.write(data); }

  end() { this.socket.end(); }

  onData(text) {
    let list;
    try { list = this.parser.push(text); } catch (e) { this.socket.destroy(); return; }
    for (const ins of list) this.handle(ins);
  }

  handle(ins) {
    if (this.state === 'select') {
      if (ins.opcode !== 'select') return this.socket.destroy();
      this.select = ins.args[0];
      if (this.select.startsWith('$') && !this.server.connections.has(this.select)) {
        this.send(encode('error', 'No such connection.', 0x0204));
        return this.socket.end();
      }
      this.state = 'handshake';
      this.send(encode('args', ...ARG_NAMES));
      return undefined;
    }
    if (this.state === 'handshake') {
      if (ins.opcode !== 'connect') { this.handshake[ins.opcode] = ins.args; return undefined; }
      const settings = {};
      ARG_NAMES.forEach((n, i) => { settings[n] = ins.args[i]; });
      this.settings = settings;
      this.server.emit('handshake', { select: this.select, handshake: this.handshake, settings });
      return this.finishHandshake(settings);
    }
    // open
    this.received.push(ins);
    this.server.emit('instruction', this, ins);
    if (ins.opcode === 'disconnect') return this.socket.end();
    const c = this.connection;
    if (!c) return undefined;
    if (ins.opcode === 'mouse') {
      const [x, y, mask] = ins.args.map(Number);
      // Draw a dot where the controller clicks, show cursor position to others.
      if (mask & 1) c.broadcast(encode('rect', 0, x - 3, y - 3, 6, 6) + encode('cfill', 14, 0, 255, 80, 0, 255) + encode('sync', Date.now()));
      c.broadcast(encode('mouse', x, y), this);
    } else if (ins.opcode === 'size') {
      c.width = Number(ins.args[0]);
      c.height = Number(ins.args[1]);
      c.broadcast(c.initialFrame());
    }
    return undefined;
  }

  finishHandshake(settings) {
    if (this.select === 'rdp') {
      if (settings.password === 'bad') {
        setTimeout(() => {
          this.send(encode('ready', '$pending'));
          setTimeout(() => {
            this.send(encode('error', 'Authentication failure (invalid credentials?)', 0x0301) + encode('disconnect'));
            this.socket.end();
          }, this.server.rdpDelayMs);
        }, 5);
        return;
      }
      if (settings.hostname === 'unreachable.invalid') {
        this.send(encode('ready', '$pending'));
        setTimeout(() => {
          this.send(encode('error', 'Unable to connect to RDP server.', 0x0207) + encode('disconnect'));
          this.socket.end();
        }, this.server.rdpDelayMs);
        return;
      }
      const c = new FakeConnection(this.server, settings);
      this.server.connections.set(c.id, c);
      this.server.emit('connection-created', c);
      this.owner = true;
      this.attach(c);
      this.send(encode('ready', c.id));
      // RDP "connects" a little later, then the first frame arrives.
      setTimeout(() => { if (!c.closed) this.send(c.initialFrame()); }, this.server.rdpDelayMs);
    } else {
      const c = this.server.connections.get(this.select);
      if (!c) { this.send(encode('error', 'No such connection.', 0x0204)); this.socket.end(); return; }
      if (c.wedged) return; // simulate guacd joiner deadlock (never sends ready)
      this.attach(c);
      this.send(encode('ready', c.id));
      this.send(c.initialFrame());
    }
  }

  attach(c) {
    this.connection = c;
    this.state = 'open';
    c.users.add(this);
  }

  onClose() {
    this.server.users.delete(this);
    if (this.connection) this.connection.remove(this);
  }
}

class FakeGuacd extends EventEmitter {
  constructor({ syncMs = 200, rdpDelayMs = 30 } = {}) {
    super();
    this.syncMs = syncMs;
    this.rdpDelayMs = rdpDelayMs;
    this.connections = new Map();
    this.users = new Set();
    /** every user ever connected (kept after close, for assertions) */
    this.allUsers = [];
    this.server = net.createServer((s) => {
      const u = new FakeUser(this, s);
      this.users.add(u);
      this.allUsers.push(u);
    });
  }

  listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        this.port = this.server.address().port;
        resolve(this.port);
      });
    });
  }

  /** All user connections (excluding the gateway's anchor) of a connection. */
  joiners(conn) { return [...conn.users].filter((u) => !u.owner); }

  owner(conn) { return [...conn.users].find((u) => u.owner) || null; }

  close() {
    for (const c of [...this.connections.values()]) c.close();
    for (const u of this.users) u.socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

module.exports = { FakeGuacd, ARG_NAMES };
