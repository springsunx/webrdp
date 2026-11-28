'use strict';

function int(name, def, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number.parseInt(raw, 10);
  if (!Number.isFinite(v) || v < min || v > max) {
    throw new Error(`Invalid value for ${name}: "${raw}"`);
  }
  return v;
}

function str(name, def) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? def : raw;
}

function bool(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return /^(1|true|yes|on)$/i.test(raw);
}

/**
 * Build runtime configuration. All timeouts are in milliseconds internally,
 * but configured in seconds through the environment.
 */
function loadConfig(overrides = {}) {
  const cfg = {
    port: int('PORT', 3000, { min: 0, max: 65535 }),
    host: str('BIND_HOST', '0.0.0.0'),
    guacdHost: str('GUACD_HOST', 'localhost'),
    guacdPort: int('GUACD_PORT', 4822, { min: 1, max: 65535 }),
    /** How long the primary user's identity is reserved after disconnecting. */
    primaryGraceMs: int('PRIMARY_GRACE_SECONDS', 180, { min: 0 }) * 1000,
    /** How long an RDP session is kept alive with no browser attached. */
    sessionIdleMs: int('SESSION_IDLE_SECONDS', 120, { min: 0 }) * 1000,
    /** Max time to wait for guacd + RDP to become ready. */
    connectTimeoutMs: int('CONNECT_TIMEOUT_SECONDS', 30, { min: 1 }) * 1000,
    /** Lifetime of one-time join tickets. */
    ticketTtlMs: int('TICKET_TTL_SECONDS', 60, { min: 5 }) * 1000,
    maxSessions: int('MAX_SESSIONS', 50, { min: 1 }),
    maxParticipants: int('MAX_PARTICIPANTS', 20, { min: 1 }),
    /** Trust X-Forwarded-* headers (reverse proxy deployments). */
    trustProxy: bool('TRUST_PROXY', true),
    logLevel: str('LOG_LEVEL', 'info'),
    /** Optional comma separated allow-list of RDP hosts (empty = allow all). */
    allowedHosts: str('ALLOWED_HOSTS', '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    publicDir: str('PUBLIC_DIR', ''),
  };
  return Object.assign(cfg, overrides);
}

module.exports = { loadConfig };
