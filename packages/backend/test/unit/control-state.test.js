'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ControlState } = require('../../src/session/control-state');

function make(graceMs = 1000) {
  let t = 0;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const s = new ControlState({ primaryGraceMs: graceMs, now: clock.now });
  return { s, clock };
}

test('R1/R2: first participant is primary with control, later ones are viewers', () => {
  const { s } = make();
  assert.equal(s.join('a').role, 'primary');
  assert.equal(s.join('b').role, 'viewer');
  assert.equal(s.controllerId, 'a');
  assert.equal(s.primaryId, 'a');
  s.assertInvariants();
});

test('R3: viewer takeover preempts, primary reclaims at any time', () => {
  const { s } = make();
  s.join('a'); s.join('b'); s.join('c');
  let r = s.requestControl('b');
  assert.equal(r.reason, 'takeover');
  assert.equal(s.controllerId, 'b');
  assert.deepEqual(r.events[0], { type: 'control', from: 'a', to: 'b', reason: 'takeover' });
  r = s.requestControl('c');
  assert.equal(s.controllerId, 'c');
  r = s.requestControl('a');
  assert.equal(r.reason, 'reclaim');
  assert.equal(s.controllerId, 'a');
  assert.equal(s.requestControl('a').reason, 'already');
  s.assertInvariants();
});

test('R4: release and disconnect of a temporary operator return control to the primary', () => {
  const { s } = make();
  s.join('a'); s.join('b');
  s.requestControl('b');
  assert.equal(s.releaseControl('b').ok, true);
  assert.equal(s.controllerId, 'a');
  assert.equal(s.releaseControl('b').ok, false); // not controller
  assert.equal(s.releaseControl('a').reason, 'primary_keeps');
  s.requestControl('b');
  const ev = s.leave('b');
  assert.equal(s.controllerId, 'a');
  assert.ok(ev.some((e) => e.type === 'control' && e.reason === 'operator_left' && e.to === 'a'));
  s.assertInvariants();
});

test('R5/R6: primary offline -> nobody controls; returns and gets control back if free', () => {
  const { s, clock } = make(1000);
  s.join('a'); s.join('b');
  const ev = s.leave('a');
  assert.equal(s.controllerId, null);
  assert.equal(s.isOnline('a'), false);
  assert.ok(ev.some((e) => e.type === 'primary_offline'));
  assert.equal(s.nextDeadline(), 1000);
  clock.advance(500);
  assert.deepEqual(s.tick(), []);
  const r = s.join('a');
  assert.equal(r.role, 'primary');
  assert.equal(s.controllerId, 'a');
  assert.equal(s.nextDeadline(), null);
  s.assertInvariants();
});

test('R6: returning primary does not interrupt an operator but may reclaim', () => {
  const { s } = make(1000);
  s.join('a'); s.join('b');
  s.leave('a');
  s.requestControl('b');
  s.join('a');
  assert.equal(s.controllerId, 'b');
  assert.equal(s.primaryId, 'a');
  s.requestControl('a');
  assert.equal(s.controllerId, 'a');
});

test('R4 while primary offline: operator release -> nobody', () => {
  const { s } = make(1000);
  s.join('a'); s.join('b');
  s.leave('a');
  s.requestControl('b');
  s.releaseControl('b');
  assert.equal(s.controllerId, null);
  s.assertInvariants();
});

test('R7: grace expiry promotes the longest-connected viewer', () => {
  const { s, clock } = make(1000);
  s.join('a'); s.join('b'); s.join('c');
  s.leave('a');
  clock.advance(1000);
  const ev = s.tick();
  assert.equal(s.primaryId, 'b');
  assert.equal(s.controllerId, 'b');
  assert.ok(ev.some((e) => e.type === 'primary_expired' && e.id === 'a'));
  assert.ok(ev.some((e) => e.type === 'primary_assigned' && e.id === 'b' && e.reason === 'promotion'));
  // ex-primary comes back as a brand new viewer
  assert.equal(s.join('a').role, 'viewer');
  s.assertInvariants();
});

test('R7: promotion keeps an active operator in control', () => {
  const { s, clock } = make(1000);
  s.join('a'); s.join('b'); s.join('c');
  s.leave('a');
  s.requestControl('c');
  clock.advance(1000);
  s.tick();
  assert.equal(s.primaryId, 'b');
  assert.equal(s.controllerId, 'c');
});

test('R7: grace expiry with nobody online clears the primary slot', () => {
  const { s, clock } = make(1000);
  s.join('a');
  s.leave('a');
  clock.advance(1000);
  s.tick();
  assert.equal(s.primaryId, null);
  assert.equal(s.join('z').role, 'primary');
  assert.equal(s.controllerId, 'z');
});

test('grace 0: primary leaving promotes immediately', () => {
  const { s } = make(0);
  s.join('a'); s.join('b');
  s.leave('a');
  assert.equal(s.primaryId, 'b');
  assert.equal(s.controllerId, 'b');
  s.assertInvariants();
});

test('joining an online id throws', () => {
  const { s } = make();
  s.join('a');
  assert.throws(() => s.join('a'));
});

test('offline participants cannot take control', () => {
  const { s } = make();
  s.join('a'); s.join('b');
  s.leave('a');
  assert.equal(s.requestControl('a').ok, false);
  assert.equal(s.requestControl('nobody').ok, false);
});

test('random operation sequences keep invariants', () => {
  for (let run = 0; run < 300; run++) {
    const { s, clock } = make(run % 3 === 0 ? 0 : 500);
    const ids = ['a', 'b', 'c', 'd', 'e'];
    let seed = run + 1;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let step = 0; step < 200; step++) {
      const id = ids[rnd(ids.length)];
      switch (rnd(6)) {
        case 0: if (!s.isOnline(id)) s.join(id); break;
        case 1: s.leave(id); break;
        case 2: s.requestControl(id); break;
        case 3: s.releaseControl(id); break;
        case 4: clock.advance(rnd(400)); s.tick(); break;
        default: clock.advance(600); s.tick(); break;
      }
      s.assertInvariants();
      // whenever the primary is online and nobody controls, someone must have released while primary offline
      const snap = s.snapshot();
      assert.ok(snap.participants.filter((p) => p.controller).length <= 1);
      assert.ok(snap.participants.filter((p) => p.primary).length <= 1);
    }
  }
});
