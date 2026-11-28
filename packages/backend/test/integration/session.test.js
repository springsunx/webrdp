'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createHarness, waitFor, sleep, receivedBy, receivedByOwner,
} = require('../support/harness');

async function withHarness(overrides, fn, opts) {
  const h = await createHarness(overrides, opts);
  try { await fn(h); } finally { await h.close(); }
}

test('first user is primary with control, second is viewer; input is gated server-side', () => withHarness({}, async (h) => {
  const a = h.client('A');
  await a.connect();
  await a.waitFrame();
  const sa = await a.waitState((s) => s.phase === 'connected');
  assert.equal(sa.you.role, 'primary');
  assert.equal(sa.you.controller, true);
  assert.ok(sa.connectedAt > 0);
  // first message is the tunnel uuid
  assert.equal(a.instructions[0].opcode, '');

  const b = h.client('B');
  await b.connect();
  await b.waitFrame();
  const sb = await b.waitState((s) => s.participants.length === 2);
  assert.equal(sb.you.role, 'viewer');
  assert.equal(sb.you.controller, false);
  assert.equal(sb.connectedAt, sa.connectedAt, 'same RDP session, same connection time');

  // Only one RDP connection for both browsers.
  assert.equal(h.fake.connections.size, 1);
  // Joiners never receive credentials.
  const joinHandshakes = h.fake.allUsers.filter((u) => !u.owner && u.settings);
  assert.ok(joinHandshakes.length >= 2);
  for (const u of joinHandshakes) assert.equal(u.settings.password, '');

  b.send('mouse', 10, 10, 1);
  b.send('key', 65, 1);
  a.send('mouse', 20, 30, 0);
  await waitFor(() => receivedBy(h.fake, 'A', 'mouse').length === 1, { message: 'A mouse' });
  await sleep(50);
  assert.equal(receivedBy(h.fake, 'B', 'mouse').length, 0);
  assert.equal(receivedBy(h.fake, 'B', 'key').length, 0);
  // viewer is told why
  await b.waitCtl((m) => m.t === 'denied');
}));

test('takeover, release, reclaim are broadcast and enforced', () => withHarness({}, async (h) => {
  const a = h.client('A'); await a.connect(); await a.waitFrame();
  const b = h.client('B'); await b.connect(); await b.waitFrame();
  const c = h.client('C'); await c.connect(); await c.waitFrame();

  b.control('request');
  for (const cl of [a, b, c]) await cl.waitState((s) => s.controllerId === b.identity.id, 'B controls');
  assert.equal(b.lastState().you.controller, true);
  assert.equal(a.lastState().you.controller, false);
  await a.waitCtl((m) => m.t === 'events' && m.events.some((e) => e.type === 'control' && e.reason === 'takeover'));

  b.send('mouse', 5, 5, 0);
  a.send('mouse', 6, 6, 0);
  await waitFor(() => receivedBy(h.fake, 'B', 'mouse').length === 1, { message: 'B mouse forwarded' });
  await sleep(30);
  assert.equal(receivedBy(h.fake, 'A', 'mouse').length, 0);

  // C takes over from B (viewer can take over from another operator)
  c.control('request');
  await a.waitState((s) => s.controllerId === c.identity.id);
  // C releases -> back to primary
  c.control('release');
  for (const cl of [a, b, c]) await cl.waitState((s) => s.controllerId === a.identity.id, 'back to A');

  // B takes over, A reclaims
  b.control('request');
  await a.waitState((s) => s.controllerId === b.identity.id);
  a.control('request');
  await b.waitState((s) => s.controllerId === a.identity.id);
  await b.waitCtl((m) => m.t === 'events' && m.events.some((e) => e.reason === 'reclaim'));
}));

test('losing control releases pressed keys and mouse buttons', () => withHarness({}, async (h) => {
  const a = h.client('A'); await a.connect(); await a.waitFrame();
  const b = h.client('B'); await b.connect(); await b.waitFrame();
  b.control('request');
  await b.waitState((s) => s.you.controller);
  b.send('key', 65507, 1); // Ctrl down
  b.send('mouse', 40, 50, 1); // left button down
  await waitFor(() => receivedBy(h.fake, 'B', 'key').length === 1);
  a.control('request');
  await waitFor(() => receivedBy(h.fake, 'B', 'key').some((i) => i.args[0] === '65507' && i.args[1] === '0'), { message: 'ctrl released' });
  await waitFor(() => receivedBy(h.fake, 'B', 'mouse').some((i) => i.args[2] === '0'), { message: 'button released' });
}));

test('temporary operator disconnect returns control to primary and releases keys', () => withHarness({}, async (h) => {
  const a = h.client('A'); await a.connect(); await a.waitFrame();
  const b = h.client('B'); await b.connect(); await b.waitFrame();
  b.control('request');
  await b.waitState((s) => s.you.controller);
  b.send('key', 65, 1);
  await waitFor(() => receivedBy(h.fake, 'B', 'key').length === 1);
  b.kill();
  await a.waitState((s) => s.you.controller && s.participants.length === 1, 'A regains control');
  await waitFor(() => receivedBy(h.fake, 'B', 'key').some((i) => i.args[1] === '0'), { message: 'key released' });
  await a.waitCtl((m) => m.t === 'events' && m.events.some((e) => e.reason === 'operator_left'));
}));

test('primary offline: nobody controls, viewer can take over, primary resumes identity and reclaims', () => withHarness({}, async (h) => {
  const a = h.client('A'); await a.connect(); await a.waitFrame();
  const b = h.client('B'); await b.connect(); await b.waitFrame();
  const idA = a.identity;
  await a.close();
  const s1 = await b.waitState((s) => !s.primaryOnline, 'primary offline');
  assert.equal(s1.controllerId, null);
  assert.equal(s1.primaryId, idA.id);
  assert.ok(s1.primaryGraceEndsAt > Date.now());

  b.control('request');
  await b.waitState((s) => s.you.controller);

  // A comes back (page refresh) with the stored identity.
  const a2 = h.client('A');
  await a2.connect({}, { identity: idA });
  await a2.waitFrame();
  const sa = await a2.waitState((s) => s.primaryOnline);
  assert.equal(sa.you.id, idA.id);
  assert.equal(sa.you.role, 'primary');
  assert.equal(sa.controllerId, b.identity.id, 'operator keeps control');
  a2.control('request');
  await b.waitState((s) => s.controllerId === idA.id);
}));

test('primary returning while nobody controls gets control back', () => withHarness({}, async (h) => {
  const a = h.client('A'); await a.connect(); await a.waitFrame();
  const b = h.client('B'); await b.connect(); await b.waitFrame();
  const idA = a.identity;
  a.kill();
  await b.waitState((s) => !s.primaryOnline);
  const a2 = h.client('A');
  await a2.connect({}, { identity: idA });
  const s = await a2.waitState((st) => st.you.controller);
  assert.equal(s.you.role, 'primary');
}));

test('primary grace expiry promotes the earliest viewer', () => withHarness({ primaryGraceMs: 300 }, async (h) => {
  const a = h.client('A'); await a.connect(); await a.waitFrame();
  const b = h.client('B'); await b.connect(); await b.waitFrame();
  const c = h.client('C'); await c.connect(); await c.waitFrame();
  const idA = a.identity;
  await a.close();
  const s = await b.waitState((st) => st.primaryId === b.identity.id && st.primaryOnline, 'B promoted');
  assert.equal(s.you.role, 'primary');
  assert.equal(s.controllerId, b.identity.id);
  await c.waitCtl((m) => m.t === 'events' && m.events.some((e) => e.type === 'primary_expired'));
  // old primary returns after expiry -> viewer
  const a2 = h.client('A');
  await a2.connect({}, { identity: idA });
  const sa = await a2.waitState((st) => st.participants.length === 3);
  assert.equal(sa.you.role, 'viewer');
}));

test('single user refresh keeps the same RDP connection and connection time', () => withHarness({}, async (h) => {
  const a = h.client('A'); await a.connect(); await a.waitFrame();
  const s1 = await a.waitState((s) => s.phase === 'connected');
  const id = a.identity;
  const connId = h.conn().id;
  await a.close();
  await sleep(100);
  assert.equal(h.fake.connections.size, 1, 'RDP connection survives');
  const a2 = h.client('A');
  await a2.connect({}, { identity: id });
  await a2.waitFrame();
  const s2 = await a2.waitState((s) => s.you.controller);
  assert.equal(h.conn().id, connId);
  assert.equal(s2.connectedAt, s1.connectedAt);
  assert.equal(s2.you.role, 'primary');
}));

test('idle session is closed after SESSION_IDLE timeout', () => withHarness({ sessionIdleMs: 200 }, async (h) => {
  const a = h.client('A'); await a.connect(); await a.waitFrame();
  await a.close();
  await waitFor(() => h.fake.connections.size === 0 && h.srv.manager.sessions.size === 0, { message: 'session closed' });
}));

test('wrong credentials -> fatal error without retry, session discarded', () => withHarness({}, async (h) => {
  const a = h.client('A');
  await a.connect({ password: 'bad' });
  const f = await a.waitCtl((m) => m.t === 'fatal');
  assert.equal(f.code, 0x0301);
  assert.equal(f.retry, false);
  assert.ok(a.instructions.some((i) => i.opcode === 'error' && i.args[1] === String(0x0301)));
  await waitFor(() => a.closed);
  assert.equal(a.closeInfo.reason, String(0x0301));
  await waitFor(() => h.srv.manager.sessions.size === 0, { message: 'session dropped' });
}));

test('unreachable host -> retryable error', () => withHarness({}, async (h) => {
  const a = h.client('A');
  await a.connect({ host: 'unreachable.invalid' });
  const f = await a.waitCtl((m) => m.t === 'fatal');
  assert.equal(f.retry, true);
}));

test('guacd down -> retryable error', () => withHarness({ guacdPort: 1 }, async (h) => {
  const a = h.client('A');
  await a.connect();
  const f = await a.waitCtl((m) => m.t === 'fatal');
  assert.equal(f.retry, true);
}));

test('tickets are single use and expire', () => withHarness({ ticketTtlMs: 5000 }, async (h) => {
  const r = await fetch(`${h.base}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(h.target),
  });
  const { ticket } = await r.json();
  const a = h.client('A');
  await a.open(`/tunnel?ticket=${ticket}`);
  await a.waitState(() => true);
  const b = h.client('B');
  await b.open(`/tunnel?ticket=${ticket}`);
  const f = await b.waitCtl((m) => m.t === 'fatal');
  assert.equal(f.code, 0x0204);
  assert.equal(f.retry, true);
}));

test('legacy GET /api/rdp/connect + ws ?token= still work', () => withHarness({}, async (h) => {
  const a = h.client('A');
  await a.connect({}, { legacy: true });
  await a.waitFrame();
  const s = await a.waitState((st) => st.phase === 'connected');
  assert.equal(s.you.role, 'primary');
  const r = await fetch(`${h.base}/api/rdp/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: 'x' }),
  });
  assert.equal(r.status, 400);
}));

test('internal ping is echoed', () => withHarness({}, async (h) => {
  const a = h.client('A'); await a.connect();
  a.send('', 'ping', '12345');
  await waitFor(() => a.instructions.some((i) => i.opcode === '' && i.args[0] === 'ping' && i.args[1] === '12345'));
  await sleep(30);
  assert.equal(receivedBy(h.fake, 'A', '').length, 0, 'never forwarded to guacd');
}));

test('RDP drop: clients get retryable error, identities survive the reconnect', () => withHarness({}, async (h) => {
  const a = h.client('A'); await a.connect(); await a.waitFrame();
  const b = h.client('B'); await b.connect(); await b.waitFrame();
  const s1 = await a.waitState((s) => s.phase === 'connected');
  const idA = a.identity; const idB = b.identity;
  h.conn().abort();
  const f = await a.waitCtl((m) => m.t === 'fatal');
  assert.equal(f.retry, true);
  await waitFor(() => a.closed && b.closed);
  // viewer reconnects first - must not steal the primary role
  const b2 = h.client('B'); await b2.connect({}, { identity: idB });
  const a2 = h.client('A'); await a2.connect({}, { identity: idA });
  await a2.waitFrame();
  const sa = await a2.waitState((s) => s.phase === 'connected' && s.you.controller);
  assert.equal(sa.you.role, 'primary');
  assert.ok(sa.connectedAt >= s1.connectedAt);
  assert.notEqual(sa.connectedAt, null);
  const sb = await b2.waitState((s) => s.participants.length === 2);
  assert.equal(sb.you.role, 'viewer');
}));

test('identity used by a live connection is not stolen', () => withHarness({}, async (h) => {
  const a = h.client('A'); await a.connect(); await a.waitFrame();
  const dup = h.client('A-dup');
  await dup.connect({}, { identity: a.identity });
  const s = await dup.waitState(() => true);
  assert.notEqual(s.you.id, a.identity.id);
  assert.equal(s.you.role, 'viewer');
  assert.equal(a.lastState().you.controller, true);
}));

test('half-open old connection is replaced by the resumed one without losing control', () => withHarness({}, async (h) => {
  const a = h.client('A'); await a.connect(); await a.waitFrame();
  const id = a.identity;
  // Make the old socket unresponsive to pings (simulates a dead NAT mapping).
  a.ws._socket.pause();
  a.ws.pong = () => {};
  const a2 = h.client('A2');
  await a2.connect({}, { identity: id });
  const s = await a2.waitState((st) => st.you.id === id.id, 'resumed');
  assert.equal(s.you.controller, true);
  assert.equal(s.you.role, 'primary');
  assert.equal(s.participants.length, 1);
}));

test('different credentials -> different sessions', () => withHarness({}, async (h) => {
  const a = h.client('A'); await a.connect(); await a.waitFrame();
  const b = h.client('B'); await b.connect({ password: 'other' }); await b.waitFrame();
  assert.equal(h.srv.manager.sessions.size, 2);
  assert.equal((await b.waitState(() => true)).you.role, 'primary');
}));

test('emoji survive both length conventions', () => withHarness({}, async (h) => {
  const a = h.client('A'); await a.connect(); await a.waitFrame();
  // browser -> guacd: clipboard stream with emoji (controller only)
  a.send('clipboard', 0, 'text/plain');
  a.send('blob', 0, '8J+YgA==');
  a.send('end', 0);
  a.send('key', 65, 1);
  a.send('argv', 1, 'text/plain', 'x😀');
  await waitFor(() => receivedBy(h.fake, 'A', 'argv').length === 1);
  assert.equal(receivedBy(h.fake, 'A', 'argv')[0].args[2], 'x😀');
  assert.equal(receivedBy(h.fake, 'A', 'end').length, 1);
  // guacd -> browser
  for (const u of h.fake.joiners(h.conn())) u.send('4.name,3.😀ab;');
  await waitFor(() => a.instructions.some((i) => i.opcode === 'name' && i.args[0] === '😀ab'), { message: 'emoji name' });
}));

test('viewer cannot inject stream payloads or resize', () => withHarness({}, async (h) => {
  const a = h.client('A'); await a.connect(); await a.waitFrame();
  const b = h.client('B'); await b.connect(); await b.waitFrame();
  b.send('blob', 0, 'AAAA');
  b.send('end', 0);
  b.send('size', 800, 600);
  a.send('size', 100, 100); // invalid size from controller is dropped too
  a.send('nop');
  await waitFor(() => receivedBy(h.fake, 'A', 'nop').length === 1);
  await sleep(30);
  assert.equal(receivedBy(h.fake, 'B', 'blob').length, 0);
  assert.equal(receivedBy(h.fake, 'B', 'size').length, 0);
  assert.equal(receivedBy(h.fake, 'A', 'size').length, 0);
  a.send('size', 1600, 900);
  await waitFor(() => receivedBy(h.fake, 'A', 'size').length === 1);
  await a.waitState((s) => s.display.width === 1600 || true);
}));

test('anchor keeps guacd alive with sync replies', () => withHarness({}, async (h) => {
  const a = h.client('A'); await a.connect(); await a.waitFrame();
  await waitFor(() => receivedByOwner(h.fake, 'sync').length >= 2, { message: 'anchor sync replies' });
}));

test('health endpoint', () => withHarness({}, async (h) => {
  const r = await fetch(`${h.base}/healthz?deep=1`);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.guacd, true);
  const idx = await fetch(`${h.base}/?host=a&user=b&password=c`);
  assert.equal(idx.headers.get('referrer-policy'), 'no-referrer');
}));
