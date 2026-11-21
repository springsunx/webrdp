// Detect an already-established shared session that stopped responding to new
// joins. A quiet desktop alone is not evidence: two distinct joins must time
// out without any initial response while every existing connection is quiet.
function recordStalledJoin(session, connectionId, now, idleMs, hasRecentPeerActivity) {
  const anchor = session?.anchor;
  if (!session || session.state !== 'active' || !anchor || anchor.closed
    || !anchor.hasReceivedSync || !Number.isFinite(anchor.client?.lastActivity)
    || now - anchor.client.lastActivity < idleMs || hasRecentPeerActivity) {
    if (session) session.stalledJoinEvidence = null;
    return false;
  }

  // Bound evidence to this anchor and a short window; do not let repeated
  // callbacks from the same connection count as independent failures.
  let evidence = session.stalledJoinEvidence;
  if (!evidence || evidence.anchor !== anchor || now - evidence.firstAt > 4 * idleMs) {
    evidence = { anchor, firstAt: now, connections: new Set() };
    session.stalledJoinEvidence = evidence;
  }
  if (evidence.connections.size < 2) evidence.connections.add(connectionId);
  if (evidence.connections.size < 2) return false;

  // A broken upstream must not cause an endless reconnection loop.
  const cooldownMs = Math.max(5 * 60 * 1000, 2 * idleMs);
  if (session.lastStallRecoveryAt != null && now - session.lastStallRecoveryAt < cooldownMs) {
    return false;
  }
  session.stalledJoinEvidence = null;
  session.lastStallRecoveryAt = now;
  return true;
}

module.exports = { recordStalledJoin };
