'use strict';

const WebSocket = require('ws');
const { Parser, encodeUtf16 } = require('../../src/guac/protocol');
const { FakeGuacd } = require('./fake-guacd');
const { createServer } = require('../../src/app');
const { loadConfig } = require('../../src/config');
const { createLogger } = require('../../src/logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 3000, interval = 10, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${message}`);
    await sleep(interval);
  }
}

/**
 * Emulates what the browser does with guacamole-common-js: UTF-16 length
 * units, `webrdp` control messages, internal ping.
 */
class TestClient {
  constructor(harness, name) {
    this.h = harness;
    this.name = name;
    this.instructions = [];
    this.ctl = [];
    this.identity = null;
    this.closed = false;
    this.closeInfo = null;
  }

  async connect(params = {}, { identity = this.identity, legacy = false } = {}) {
    const body = { ...this.h.target, name: this.name, ...params };
    if (identity) { body.clientId = identity.id; body.resumeToken = identity.token; }
    let ticket;
    if (legacy) {
      const qs = new URLSearchParams(body).toString();
      const r = await fetch(`${this.h.base}/api/rdp/connect?${qs}`);
      const j = await r.json();
      ticket = j.token;
    } else {
      const r = await fetch(`${this.h.base}/api/session`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status });
      ticket = j.ticket;
    }
    return this.open(legacy ? `/?token=${encodeURIComponent(ticket)}` : `/tunnel?ticket=${encodeURIComponent(ticket)}`);
  }

  open(path) {
    this.instructions = [];
    this.ctl = [];
    this.closed = false;
    this.parser = new Parser({ units: 'utf16' });
    this.ws = new WebSocket(`${this.h.wsBase}${path}`, 'guacamole');
    this.ws.on('message', (d) => {
      for (const ins of this.parser.push(d.toString())) {
        this.instructions.push(ins);
        if (ins.opcode === 'webrdp') {
          const m = JSON.parse(ins.args[0]);
          this.ctl.push(m);
          if (m.t === 'welcome') this.identity = { id: m.you.id, token: m.you.token };
        }
      }
    });
    this.ws.on('close', (code, reason) => { this.closed = true; this.closeInfo = { code, reason: reason.toString() }; });
    return new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  send(opcode, ...args) { this.ws.send(encodeUtf16(opcode, ...args)); }

  control(op) { this.send('webrdp', JSON.stringify({ op })); }

  lastState() {
    for (let i = this.ctl.length - 1; i >= 0; i--) if (this.ctl[i].t === 'state') return this.ctl[i];
    return null;
  }

  waitState(pred, message = 'state') {
    return waitFor(() => { const s = this.lastState(); return s && pred(s) ? s : null; }, { message: `${this.name}: ${message}` });
  }

  waitCtl(pred, message = 'ctl') {
    return waitFor(() => this.ctl.find(pred), { message: `${this.name}: ${message}` });
  }

  /** Wait until the joiner guacd connection is live (first frame received). */
  waitFrame() {
    return waitFor(() => this.instructions.some((i) => i.opcode === 'size'), { message: `${this.name}: first frame` });
  }

  close() {
    return new Promise((resolve) => {
      if (this.closed || this.ws.readyState === 3) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }

  /** Simulate a network drop (no close handshake). */
  kill() {
    this.ws.terminate();
  }
}

async function createHarness(overrides = {}, { fake: fakeOpts = {} } = {}) {
  const fake = new FakeGuacd(fakeOpts);
  const guacdPort = await fake.listen();
  const config = loadConfig({
    port: 0,
    host: '127.0.0.1',
    guacdHost: '127.0.0.1',
    guacdPort,
    primaryGraceMs: 60000,
    sessionIdleMs: 60000,
    connectTimeoutMs: 3000,
    ticketTtlMs: 60000,
    ...overrides,
  });
  const log = createLogger(process.env.TEST_LOG || 'silent');
  const srv = createServer({ config, log });
  await new Promise((r) => srv.server.listen(0, '127.0.0.1', r));
  const { port } = srv.server.address();
  const h = {
    fake,
    srv,
    config,
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    target: { host: 'win.example', port: 3389, user: 'alice', password: 'secret', width: 1280, height: 720 },
    clients: [],
    client(name) { const c = new TestClient(h, name); h.clients.push(c); return c; },
    session() { return [...srv.manager.sessions.values()][0] || null; },
    conn() { return [...fake.connections.values()][0] || null; },
    async close() {
      for (const c of h.clients) if (c.ws) c.ws.terminate();
      await srv.shutdown();
      await fake.close();
    },
  };
  return h;
}

/** Instructions of `opcode` that the fake guacd received from a named joiner. */
function receivedBy(fake, name, opcode) {
  const out = [];
  for (const u of fake.allUsers) {
    if (u.handshake.name && u.handshake.name[0] === name) {
      for (const i of u.received) if (!opcode || i.opcode === opcode) out.push(i);
    }
  }
  return out;
}

/** Instructions received by the guacd connection owner (gateway anchor). */
function receivedByOwner(fake, opcode) {
  const out = [];
  for (const u of fake.allUsers) {
    if (u.owner) for (const i of u.received) if (!opcode || i.opcode === opcode) out.push(i);
  }
  return out;
}

module.exports = { createHarness, TestClient, waitFor, sleep, receivedBy, receivedByOwner };
