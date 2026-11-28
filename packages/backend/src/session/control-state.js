'use strict';

/**
 * Pure control-ownership state machine for one shared session.
 *
 * Roles
 *   primary   – the first participant of a session. Has control by default,
 *               can reclaim control at any time. Identity is reserved for
 *               `primaryGraceMs` after the primary disconnects.
 *   viewer    – everyone else. Can take over control with a button.
 *
 * Invariants (checked by tests)
 *   - at most one controller
 *   - controller is always an ONLINE participant (or null)
 *   - at most one primary; primary is a participant (online or within grace)
 *
 * Rules
 *   R1  First participant becomes primary and gets control.
 *   R2  Later participants join as viewers without control.
 *   R3  Any online participant may take control at any time (viewer
 *       "takeover", primary "reclaim"). Takeover preempts the current holder.
 *   R4  A temporary operator that releases control, or disconnects, hands
 *       control back to the primary if online, otherwise to nobody.
 *   R5  When the primary disconnects its control (if any) goes to nobody and
 *       its identity is reserved for primaryGraceMs. Viewers may take over
 *       meanwhile (R3).
 *   R6  If the primary returns within the grace period it is primary again;
 *       if nobody is in control it gets control back immediately, otherwise
 *       the current operator keeps control and the primary may reclaim (R3).
 *   R7  If the grace period expires, the longest-connected online viewer is
 *       promoted to primary (and gets control if nobody has it). If nobody is
 *       online the primary slot is cleared and the next joiner becomes primary.
 *       A returning ex-primary after expiry joins as a viewer.
 */
class ControlState {
  constructor({ primaryGraceMs = 180000, now = Date.now } = {}) {
    this.primaryGraceMs = primaryGraceMs;
    this.now = now;
    /** @type {Map<string, {id:string,label:string,device:string,seq:number,online:boolean,joinedAt:number}>} */
    this.participants = new Map();
    this.primaryId = null;
    this.controllerId = null;
    this.primaryOfflineSince = null;
    this.rev = 0;
    this._seq = 0;
  }

  // ---------------------------------------------------------------- queries

  has(id) { return this.participants.has(id); }
  isOnline(id) { const p = this.participants.get(id); return !!(p && p.online); }
  isController(id) { return id !== null && this.controllerId === id; }
  isPrimary(id) { return id !== null && this.primaryId === id; }
  onlineCount() { let n = 0; for (const p of this.participants.values()) if (p.online) n++; return n; }

  /** Epoch ms when the reserved primary identity expires, or null. */
  nextDeadline() {
    if (this.primaryId && this.primaryOfflineSince !== null) {
      return this.primaryOfflineSince + this.primaryGraceMs;
    }
    return null;
  }

  // -------------------------------------------------------------- mutations

  /**
   * Add (or bring back) a participant. The caller is responsible for
   * authenticating `id` (resume token) and for making sure it is not online.
   * @returns {{role:'primary'|'viewer', events:object[]}}
   */
  join(id, { label = '', device = '' } = {}) {
    const events = [];
    const existing = this.participants.get(id);
    if (existing && existing.online) throw new Error(`participant ${id} already online`);

    if (existing) {
      // Only a reserved (offline) primary is kept around.
      existing.online = true;
      if (label) existing.label = label;
      if (device) existing.device = device;
      if (id === this.primaryId) {
        this.primaryOfflineSince = null;
        events.push({ type: 'primary_returned', id });
        if (this.controllerId === null) {
          this._setController(id, 'primary_returned', events);
        }
      }
    } else {
      const seq = ++this._seq;
      this.participants.set(id, {
        id,
        label: label || `用户${seq}`,
        device,
        seq,
        online: true,
        joinedAt: this.now(),
      });
      if (this.primaryId === null) {
        this.primaryId = id;
        events.push({ type: 'primary_assigned', id, reason: 'first' });
        if (this.controllerId === null) this._setController(id, 'initial', events);
      } else {
        events.push({ type: 'joined', id });
      }
    }
    this.rev++;
    return { role: id === this.primaryId ? 'primary' : 'viewer', events };
  }

  /** A participant's connection went away. */
  leave(id) {
    const events = [];
    const p = this.participants.get(id);
    if (!p || !p.online) return events;
    if (id === this.primaryId && this.primaryGraceMs > 0) {
      p.online = false;
      this.primaryOfflineSince = this.now();
      events.push({ type: 'primary_offline', id, graceEndsAt: this.nextDeadline() });
      if (this.controllerId === id) this._setController(null, 'primary_offline', events);
    } else {
      this.participants.delete(id);
      events.push({ type: 'left', id });
      if (id === this.primaryId) {
        // grace disabled: promote immediately
        this.primaryId = null;
        this.primaryOfflineSince = null;
        if (this.controllerId === id) this._setController(null, 'primary_left', events);
        this._promote(events);
      } else if (this.controllerId === id) {
        this._setController(this._primaryIfOnline(), 'operator_left', events);
      }
    }
    this.rev++;
    return events;
  }

  /** Viewer takeover / primary reclaim. */
  requestControl(id) {
    const events = [];
    if (!this.isOnline(id)) return { ok: false, reason: 'not_online', events };
    if (this.controllerId === id) return { ok: true, reason: 'already', events };
    const reason = id === this.primaryId ? 'reclaim' : 'takeover';
    this._setController(id, reason, events);
    this.rev++;
    return { ok: true, reason, events };
  }

  /** Temporary operator gives control back. */
  releaseControl(id) {
    const events = [];
    if (this.controllerId !== id) return { ok: false, reason: 'not_controller', events };
    if (id === this.primaryId) return { ok: false, reason: 'primary_keeps', events };
    this._setController(this._primaryIfOnline(), 'release', events);
    this.rev++;
    return { ok: true, reason: 'release', events };
  }

  /** Apply time based transitions (primary grace expiry). */
  tick() {
    const events = [];
    const deadline = this.nextDeadline();
    if (deadline === null || this.now() < deadline) return events;
    const old = this.primaryId;
    this.participants.delete(old);
    this.primaryId = null;
    this.primaryOfflineSince = null;
    events.push({ type: 'primary_expired', id: old });
    this._promote(events);
    this.rev++;
    return events;
  }

  // -------------------------------------------------------------- internals

  _primaryIfOnline() {
    return this.primaryId && this.isOnline(this.primaryId) ? this.primaryId : null;
  }

  _promote(events) {
    let best = null;
    for (const p of this.participants.values()) {
      if (p.online && (!best || p.seq < best.seq)) best = p;
    }
    if (!best) return;
    this.primaryId = best.id;
    events.push({ type: 'primary_assigned', id: best.id, reason: 'promotion' });
    if (this.controllerId === null) this._setController(best.id, 'promotion', events);
  }

  _setController(id, reason, events) {
    const from = this.controllerId;
    if (from === id) return;
    this.controllerId = id;
    events.push({ type: 'control', from, to: id, reason });
  }

  // ---------------------------------------------------------------- export

  label(id) { const p = this.participants.get(id); return p ? p.label : null; }

  snapshot() {
    const parts = [...this.participants.values()]
      .sort((a, b) => a.seq - b.seq)
      .map((p) => ({
        id: p.id,
        label: p.label,
        device: p.device,
        online: p.online,
        primary: p.id === this.primaryId,
        controller: p.id === this.controllerId,
      }));
    return {
      rev: this.rev,
      primaryId: this.primaryId,
      primaryOnline: this.primaryId ? this.isOnline(this.primaryId) : false,
      primaryGraceEndsAt: this.nextDeadline(),
      controllerId: this.controllerId,
      participants: parts,
    };
  }

  /** Throws if an invariant is broken. Used by tests and in debug builds. */
  assertInvariants() {
    if (this.controllerId !== null && !this.isOnline(this.controllerId)) {
      throw new Error('controller must be online');
    }
    if (this.primaryId !== null && !this.participants.has(this.primaryId)) {
      throw new Error('primary must be a participant');
    }
    for (const p of this.participants.values()) {
      if (!p.online && p.id !== this.primaryId) throw new Error('only the primary may be offline');
    }
    if (this.primaryId && !this.isOnline(this.primaryId) && this.primaryOfflineSince === null) {
      throw new Error('offline primary needs a grace start');
    }
  }
}

module.exports = { ControlState };
