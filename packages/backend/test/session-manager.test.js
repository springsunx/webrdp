const assert = require('node:assert/strict');
const test = require('node:test');

const SessionManager = require('../src/session-manager');

function activate(manager, session) {
  manager.activate(
    session.roomId,
    '$connection-id',
    session.primaryParticipantId,
    session.primaryParticipantSecret,
  );
}

test('reuses a session for the same connection fingerprint', () => {
  const manager = new SessionManager({ ttlMs: 60_000, maxViewers: 2 });
  const first = manager.openOrCreate('same-rdp-connection');
  const second = manager.openOrCreate('same-rdp-connection');
  const different = manager.openOrCreate('different-rdp-connection');

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.session.roomId, first.session.roomId);
  assert.notEqual(different.session.roomId, first.session.roomId);
});

test('assigns primary control and transfers it to an authenticated participant', () => {
  const manager = new SessionManager({ ttlMs: 60_000, maxViewers: 2 });
  const session = manager.create('connection-key');
  activate(manager, session);
  const join = manager.createJoin(session.roomId);
  manager.viewerOpened(session.roomId, join.participantId, join.participantSecret);

  const primaryStatus = manager.getPublic(
    session.roomId,
    session.primaryParticipantId,
    session.primaryParticipantSecret,
  );
  const viewerStatus = manager.getPublic(
    session.roomId,
    join.participantId,
    join.participantSecret,
  );
  assert.equal(primaryStatus.hasControl, true);
  assert.equal(primaryStatus.isPrimary, true);
  assert.equal(viewerStatus.hasControl, false);

  const taken = manager.takeControl(session.roomId, join.participantId, join.participantSecret);
  assert.equal(taken.hasControl, true);
  assert.equal(manager.hasControl(session.roomId, session.primaryParticipantId), false);
  assert.throws(
    () => manager.takeControl(session.roomId, join.participantId, 'wrong-secret'),
    /Invalid participant credentials/,
  );

  const reclaimed = manager.takeControl(
    session.roomId,
    session.primaryParticipantId,
    session.primaryParticipantSecret,
  );
  assert.equal(reclaimed.hasControl, true);
  assert.equal(manager.hasControl(session.roomId, join.participantId), false);
  manager.takeControl(session.roomId, join.participantId, join.participantSecret);

  const released = manager.releaseControl(session.roomId, join.participantId, join.participantSecret);
  assert.equal(released.hasControl, false);
  assert.equal(manager.hasControl(session.roomId, session.primaryParticipantId), true);
});

test('returns control to the primary participant when a temporary controller closes', () => {
  const manager = new SessionManager({ ttlMs: 60_000, maxViewers: 1 });
  const session = manager.create();
  activate(manager, session);
  const join = manager.createJoin(session.roomId);
  manager.viewerOpened(session.roomId, join.participantId, join.participantSecret);
  manager.takeControl(session.roomId, join.participantId, join.participantSecret);
  manager.viewerClosed(session.roomId, join.participantId);

  assert.equal(manager.getPublic(session.roomId).viewerCount, 0);
  assert.equal(manager.hasControl(session.roomId, session.primaryParticipantId), true);
});

test('renews an active primary lease and allows reconnection within the grace period', () => {
  let now = 10_000;
  const manager = new SessionManager({
    ttlMs: 1_000,
    maxViewers: 1,
    reconnectGraceMs: 500,
    now: () => now,
  });
  const session = manager.create('long-lived', { hostname: '192.0.2.10' });
  activate(manager, session);

  now += 900;
  const renewed = manager.getPublic(
    session.roomId,
    session.primaryParticipantId,
    session.primaryParticipantSecret,
  );
  assert.equal(renewed.createdAt, 10_000);
  assert.equal(renewed.expiresAt, now + 1_000);
  now += 900;
  assert.equal(manager.hasControl(session.roomId, session.primaryParticipantId), true);
  assert.equal(session.expiresAt, now + 1_000);

  const oldSecret = session.primaryParticipantSecret;
  manager.controllerClosed(session.roomId, '$connection-id');
  assert.equal(session.state, 'reconnecting');
  assert.equal(session.reconnectUntil, now + 500);
  assert.equal(manager.findByConnectionKey('long-lived'), session);

  manager.resumePrimary(session.roomId, session.ownerSecret);
  assert.notEqual(session.primaryParticipantSecret, oldSecret);
  manager.activate(
    session.roomId,
    '$resumed-connection',
    session.primaryParticipantId,
    session.primaryParticipantSecret,
  );
  assert.equal(session.state, 'active');
  assert.equal(session.reconnectUntil, null);

  manager.controllerClosed(session.roomId, '$connection-id');
  assert.equal(session.state, 'active');
  manager.controllerClosed(session.roomId, '$resumed-connection');
  now += 501;
  assert.equal(manager.findByConnectionKey('long-lived'), null);
});

test('enforces viewer limits, owner authentication, and expiry', () => {
  let now = 5_000;
  const manager = new SessionManager({
    ttlMs: 1_000,
    maxViewers: 1,
    pendingTtlMs: 100,
    now: () => now,
  });
  const session = manager.create('expiring');
  activate(manager, session);
  manager.createJoin(session.roomId);
  assert.throws(() => manager.createJoin(session.roomId), /Viewer limit reached/);
  now += 101;
  assert.doesNotThrow(() => manager.createJoin(session.roomId));
  assert.throws(() => manager.end(session.roomId, 'wrong'), /Not authorized/);
  manager.end(session.roomId, session.ownerSecret);
  assert.equal(manager.getPublic(session.roomId), null);
  assert.equal(manager.cleanupExpired(), 1);
});
