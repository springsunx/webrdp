const test = require('node:test');
const assert = require('node:assert/strict');
const { recordStalledJoin } = require('../src/stalled-session');

const idleMs = 60_000;
const start = 1_000_000;

function establishedSession() {
  return {
    state: 'active',
    anchor: { closed: false, hasReceivedSync: true, client: { lastActivity: start - idleMs } },
  };
}

test('requires two distinct silent joins before recovering a stale session', () => {
  const session = establishedSession();
  assert.equal(recordStalledJoin(session, 1, start, idleMs, false), false);
  assert.equal(recordStalledJoin(session, 1, start + 1, idleMs, false), false);
  assert.equal(recordStalledJoin(session, 2, start + 2, idleMs, false), true);
  assert.equal(session.lastStallRecoveryAt, start + 2);
});

test('does not infer failure from a quiet but not yet initialized session', () => {
  const session = establishedSession();
  session.anchor.hasReceivedSync = false;
  assert.equal(recordStalledJoin(session, 1, start, idleMs, false), false);
  assert.equal(recordStalledJoin(session, 2, start + 1, idleMs, false), false);
  assert.equal(session.stalledJoinEvidence, null);
});

test('does not interrupt a session when its anchor or another viewer is active', () => {
  const session = establishedSession();
  assert.equal(recordStalledJoin(session, 1, start, idleMs, false), false);
  assert.equal(recordStalledJoin(session, 2, start + 1, idleMs, true), false);
  assert.equal(session.stalledJoinEvidence, null);
  session.anchor.client.lastActivity = start;
  assert.equal(recordStalledJoin(session, 3, start + 2, idleMs, false), false);
  assert.equal(recordStalledJoin(session, 4, start + 3, idleMs, false), false);
});

test('old evidence and old anchors cannot trigger recovery', () => {
  const session = establishedSession();
  assert.equal(recordStalledJoin(session, 1, start, idleMs, false), false);
  assert.equal(recordStalledJoin(session, 2, start + 4 * idleMs + 1, idleMs, false), false);
  session.anchor = { closed: false, hasReceivedSync: true, client: { lastActivity: start } };
  assert.equal(recordStalledJoin(session, 3, start + 5 * idleMs, idleMs, false), false);
  assert.equal(recordStalledJoin(session, 4, start + 5 * idleMs + 1, idleMs, false), true);
});

test('recovery has a cooldown and never acts on closed sessions', () => {
  const session = establishedSession();
  session.lastStallRecoveryAt = start - 1000;
  assert.equal(recordStalledJoin(session, 1, start, idleMs, false), false);
  assert.equal(recordStalledJoin(session, 2, start + 1, idleMs, false), false);
  session.state = 'reconnecting';
  assert.equal(recordStalledJoin(session, 3, start + 400_000, idleMs, false), false);
  assert.equal(session.stalledJoinEvidence, null);
});
