const assert = require('node:assert/strict');
const test = require('node:test');

const SessionManager = require('../src/session-manager');

test('creates and activates a share session', () => {
  let now = 1_000;
  const manager = new SessionManager({ ttlMs: 60_000, maxViewers: 2, now: () => now });
  const created = manager.create();
  assert.equal(created.state, 'creating');
  assert.equal(manager.getPublic(created.roomId).viewerCount, 0);
  manager.activate(created.roomId, '$connection-id');
  assert.equal(manager.get(created.roomId).state, 'active');
  assert.equal(manager.activeCount, 1);
  now += 1_000;
  assert.equal(manager.getPublic(created.roomId).state, 'active');
});

test('tracks viewers and enforces the viewer limit', () => {
  const manager = new SessionManager({ ttlMs: 60_000, maxViewers: 1 });
  const session = manager.create();
  manager.activate(session.roomId, '$connection-id');
  const join = manager.createJoin(session.roomId);
  assert.throws(() => manager.createJoin(session.roomId), /Viewer limit reached/);
  manager.viewerOpened(session.roomId, join.participantId);
  assert.equal(manager.getPublic(session.roomId).viewerCount, 1);
  manager.viewerClosed(session.roomId, join.participantId);
  assert.equal(manager.getPublic(session.roomId).viewerCount, 0);
});

test('requires the owner secret and expires sessions', () => {
  let now = 5_000;
  const manager = new SessionManager({ ttlMs: 1_000, maxViewers: 2, now: () => now });
  const session = manager.create();
  assert.throws(() => manager.end(session.roomId, 'wrong'), /Not authorized/);
  manager.end(session.roomId, session.ownerSecret);
  assert.equal(manager.getPublic(session.roomId), null);
  assert.equal(manager.cleanupExpired(), 1);
  const expiring = manager.create();
  now += 1_001;
  assert.equal(manager.getPublic(expiring.roomId), null);
  assert.equal(manager.cleanupExpired(), 1);
});
