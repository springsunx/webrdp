const crypto = require('crypto');

class SessionManager {
  constructor({ ttlMs, maxViewers, pendingTtlMs = 60_000, now = () => Date.now() }) {
    this.ttlMs = ttlMs;
    this.maxViewers = maxViewers;
    this.pendingTtlMs = pendingTtlMs;
    this.now = now;
    this.sessions = new Map();
  }

  get activeCount() {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.state === 'active' && session.expiresAt > this.now()) count += 1;
    }
    return count;
  }

  create() {
    const now = this.now();
    const session = {
      roomId: crypto.randomBytes(16).toString('base64url'),
      ownerSecret: crypto.randomBytes(32).toString('base64url'),
      state: 'creating',
      guacdConnectionId: null,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      pendingViewers: new Map(),
      viewers: new Set(),
    };
    this.sessions.set(session.roomId, session);
    return session;
  }

  get(roomId) {
    return this.sessions.get(roomId);
  }

  getPublic(roomId) {
    const session = this.sessions.get(roomId);
    if (!session || session.expiresAt <= this.now() || session.state === 'closed') return null;
    return {
      roomId: session.roomId,
      state: session.state,
      viewerCount: session.viewers.size,
      maxViewers: this.maxViewers,
      expiresAt: session.expiresAt,
    };
  }

  activate(roomId, guacdConnectionId) {
    const session = this.require(roomId);
    if (!guacdConnectionId) throw this.error(500, 'guacd did not return a connection ID');
    session.guacdConnectionId = guacdConnectionId;
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
    session.pendingViewers.set(participantId, this.now() + this.pendingTtlMs);
    return {
      roomId,
      participantId,
      guacdConnectionId: session.guacdConnectionId,
      expiresAt: session.expiresAt,
    };
  }

  viewerOpened(roomId, participantId) {
    const session = this.requireActive(roomId);
    if (!participantId || !session.pendingViewers.delete(participantId)) {
      throw this.error(401, 'Invalid or already-used viewer token');
    }
    session.viewers.add(participantId);
  }

  viewerClosed(roomId, participantId) {
    const session = this.sessions.get(roomId);
    if (!session || !participantId) return;
    session.pendingViewers.delete(participantId);
    session.viewers.delete(participantId);
  }

  controllerClosed(roomId) {
    const session = this.sessions.get(roomId);
    if (!session) return;
    session.state = 'closed';
    session.guacdConnectionId = null;
    session.pendingViewers.clear();
  }

  end(roomId, ownerSecret) {
    const session = this.require(roomId);
    const supplied = Buffer.from(ownerSecret);
    const expected = Buffer.from(session.ownerSecret);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      throw this.error(403, 'Not authorized to end this shared session');
    }
    session.state = 'closed';
    session.guacdConnectionId = null;
    session.pendingViewers.clear();
  }

  prunePending(session) {
    const now = this.now();
    for (const [participantId, expiresAt] of session.pendingViewers.entries()) {
      if (expiresAt <= now) session.pendingViewers.delete(participantId);
    }
  }

  cleanupExpired() {
    const now = this.now();
    let removed = 0;
    for (const [roomId, session] of this.sessions.entries()) {
      this.prunePending(session);
      if (session.expiresAt <= now || session.state === 'closed') {
        this.sessions.delete(roomId);
        removed += 1;
      }
    }
    return removed;
  }

  require(roomId) {
    const session = this.sessions.get(roomId);
    if (!session || session.expiresAt <= this.now()) {
      throw this.error(404, 'Share session not found or expired');
    }
    return session;
  }

  requireActive(roomId) {
    const session = this.require(roomId);
    if (session.state !== 'active' || !session.guacdConnectionId) {
      throw this.error(409, 'Share session is not active');
    }
    return session;
  }

  error(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
  }
}

module.exports = SessionManager;
