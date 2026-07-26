const crypto = require('crypto');

class SessionManager {
  constructor({ ttlMs, maxViewers, pendingTtlMs = 60_000, now = () => Date.now() }) {
    this.ttlMs = ttlMs;
    this.maxViewers = maxViewers;
    this.pendingTtlMs = pendingTtlMs;
    this.now = now;
    this.sessions = new Map();
    this.connectionIndex = new Map();
  }

  get activeCount() {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.state === 'active' && session.expiresAt > this.now()) count += 1;
    }
    return count;
  }

  openOrCreate(connectionKey) {
    const existing = this.findByConnectionKey(connectionKey);
    if (existing) return { session: existing, created: false };
    return { session: this.create(connectionKey), created: true };
  }

  create(connectionKey = null) {
    const now = this.now();
    const session = {
      roomId: crypto.randomBytes(16).toString('base64url'),
      ownerSecret: crypto.randomBytes(32).toString('base64url'),
      connectionKey,
      state: 'creating',
      guacdConnectionId: null,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      primaryParticipantId: crypto.randomBytes(16).toString('base64url'),
      primaryParticipantSecret: crypto.randomBytes(32).toString('base64url'),
      primaryConnected: false,
      pendingViewers: new Map(),
      viewers: new Map(),
      controlHolderId: null,
      controlVersion: 0,
    };
    session.controlHolderId = session.primaryParticipantId;
    this.sessions.set(session.roomId, session);
    if (connectionKey) this.connectionIndex.set(connectionKey, session.roomId);
    return session;
  }

  findByConnectionKey(connectionKey) {
    const roomId = this.connectionIndex.get(connectionKey);
    if (!roomId) return null;
    const session = this.sessions.get(roomId);
    const creationExpired = session?.state === 'creating'
      && session.createdAt + this.pendingTtlMs <= this.now();
    if (!session || session.state === 'closed' || session.expiresAt <= this.now() || creationExpired) {
      this.connectionIndex.delete(connectionKey);
      if (session) this.sessions.delete(roomId);
      return null;
    }
    return session;
  }

  get(roomId) {
    return this.sessions.get(roomId);
  }

  getPublic(roomId, participantId = null, participantSecret = null) {
    const session = this.sessions.get(roomId);
    if (!session || session.expiresAt <= this.now() || session.state === 'closed') return null;
    let identity = null;
    if (participantId || participantSecret) {
      identity = this.authenticate(session, participantId, participantSecret);
    }
    return {
      roomId: session.roomId,
      state: session.state,
      viewerCount: session.viewers.size,
      maxViewers: this.maxViewers,
      expiresAt: session.expiresAt,
      controlVersion: session.controlVersion,
      controlOwner: session.controlHolderId === session.primaryParticipantId ? 'primary' : 'participant',
      isPrimary: identity?.isPrimary || false,
      hasControl: identity?.participantId === session.controlHolderId,
    };
  }

  activate(roomId, guacdConnectionId, participantId, participantSecret) {
    const session = this.require(roomId);
    this.authenticatePrimary(session, participantId, participantSecret);
    if (!guacdConnectionId) throw this.error(500, 'guacd did not return a connection ID');
    session.guacdConnectionId = guacdConnectionId;
    session.primaryConnected = true;
    session.state = 'active';
    return session;
  }

  createJoin(roomId) {
    const session = this.requireActive(roomId);
    this.prunePending(session);
    if (session.viewers.size + session.pendingViewers.size >= this.maxViewers) {
      throw this.error(429, 'Viewer limit reached');
    }
    const participantId = crypto.randomBytes(16).toString('base64url');
    const participantSecret = crypto.randomBytes(32).toString('base64url');
    session.pendingViewers.set(participantId, {
      participantSecret,
      expiresAt: this.now() + this.pendingTtlMs,
    });
    return {
      roomId,
      participantId,
      participantSecret,
      guacdConnectionId: session.guacdConnectionId,
      expiresAt: session.expiresAt,
    };
  }

  viewerOpened(roomId, participantId, participantSecret) {
    const session = this.requireActive(roomId);
    const pending = session.pendingViewers.get(participantId);
    if (!pending || pending.expiresAt <= this.now()
      || !this.safeEqual(pending.participantSecret, participantSecret)) {
      throw this.error(401, 'Invalid or already-used participant token');
    }
    session.pendingViewers.delete(participantId);
    session.viewers.set(participantId, {
      participantSecret,
      connectedAt: this.now(),
    });
  }

  viewerClosed(roomId, participantId) {
    const session = this.sessions.get(roomId);
    if (!session || !participantId) return;
    session.pendingViewers.delete(participantId);
    session.viewers.delete(participantId);
    if (session.controlHolderId === participantId) this.restorePrimaryControl(session);
  }

  controllerClosed(roomId) {
    const session = this.sessions.get(roomId);
    if (!session) return;
    session.state = 'closed';
    session.guacdConnectionId = null;
    session.primaryConnected = false;
    session.pendingViewers.clear();
    session.viewers.clear();
    this.removeConnectionIndex(session);
  }

  takeControl(roomId, participantId, participantSecret) {
    const session = this.requireActive(roomId);
    const identity = this.authenticate(session, participantId, participantSecret);
    if (session.controlHolderId !== identity.participantId) {
      session.controlHolderId = identity.participantId;
      session.controlVersion += 1;
    }
    return this.getPublic(roomId, participantId, participantSecret);
  }

  releaseControl(roomId, participantId, participantSecret) {
    const session = this.requireActive(roomId);
    const identity = this.authenticate(session, participantId, participantSecret);
    if (!identity.isPrimary && session.controlHolderId === identity.participantId) {
      this.restorePrimaryControl(session);
    }
    return this.getPublic(roomId, participantId, participantSecret);
  }

  hasControl(roomId, participantId) {
    const session = this.sessions.get(roomId);
    return Boolean(
      session
      && session.state === 'active'
      && session.controlHolderId === participantId,
    );
  }

  end(roomId, ownerSecret) {
    const session = this.require(roomId);
    if (!this.safeEqual(session.ownerSecret, ownerSecret)) {
      throw this.error(403, 'Not authorized to end this shared session');
    }
    session.state = 'closed';
    session.guacdConnectionId = null;
    session.primaryConnected = false;
    session.pendingViewers.clear();
    session.viewers.clear();
    this.removeConnectionIndex(session);
  }

  authenticate(session, participantId, participantSecret) {
    if (participantId === session.primaryParticipantId) {
      this.authenticatePrimary(session, participantId, participantSecret);
      if (!session.primaryConnected && session.state === 'active') {
        throw this.error(401, 'Primary participant is not connected');
      }
      return { participantId, isPrimary: true };
    }
    const viewer = session.viewers.get(participantId);
    if (!viewer || !this.safeEqual(viewer.participantSecret, participantSecret)) {
      throw this.error(401, 'Invalid participant credentials');
    }
    return { participantId, isPrimary: false };
  }

  authenticatePrimary(session, participantId, participantSecret) {
    if (participantId !== session.primaryParticipantId
      || !this.safeEqual(session.primaryParticipantSecret, participantSecret)) {
      throw this.error(401, 'Invalid primary participant credentials');
    }
  }

  restorePrimaryControl(session) {
    if (session.controlHolderId !== session.primaryParticipantId) {
      session.controlHolderId = session.primaryParticipantId;
      session.controlVersion += 1;
    }
  }

  prunePending(session) {
    const now = this.now();
    for (const [participantId, pending] of session.pendingViewers.entries()) {
      if (pending.expiresAt <= now) session.pendingViewers.delete(participantId);
    }
  }

  cleanupExpired() {
    const now = this.now();
    let removed = 0;
    for (const [roomId, session] of this.sessions.entries()) {
      this.prunePending(session);
      const creationExpired = session.state === 'creating'
        && session.createdAt + this.pendingTtlMs <= now;
      if (session.expiresAt <= now || session.state === 'closed' || creationExpired) {
        this.removeConnectionIndex(session);
        this.sessions.delete(roomId);
        removed += 1;
      }
    }
    return removed;
  }

  require(roomId) {
    const session = this.sessions.get(roomId);
    if (!session || session.expiresAt <= this.now() || session.state === 'closed') {
      throw this.error(404, 'Shared session not found or expired');
    }
    return session;
  }

  requireActive(roomId) {
    const session = this.require(roomId);
    if (session.state !== 'active' || !session.guacdConnectionId) {
      throw this.error(409, 'Shared session is not active');
    }
    return session;
  }

  removeConnectionIndex(session) {
    if (session.connectionKey && this.connectionIndex.get(session.connectionKey) === session.roomId) {
      this.connectionIndex.delete(session.connectionKey);
    }
  }

  safeEqual(expectedValue, suppliedValue) {
    if (typeof expectedValue !== 'string' || typeof suppliedValue !== 'string') return false;
    const expected = Buffer.from(expectedValue);
    const supplied = Buffer.from(suppliedValue);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

  error(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
  }
}

module.exports = SessionManager;
