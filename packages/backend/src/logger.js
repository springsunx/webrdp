'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Redact anything that looks like a credential before it reaches the log. */
function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (/pass|secret|token|ticket|resume/i.test(k)) out[k] = v ? '***' : v;
    else if (v && typeof v === 'object') out[k] = redact(v);
    else out[k] = v;
  }
  return out;
}

function createLogger(level = 'info', sink = console) {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, fn) => (msg, meta) => {
    if (LEVELS[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}`;
    if (meta !== undefined) fn.call(sink, line, JSON.stringify(redact(meta)));
    else fn.call(sink, line);
  };
  return {
    debug: emit('debug', sink.log),
    info: emit('info', sink.log),
    warn: emit('warn', sink.warn),
    error: emit('error', sink.error),
  };
}

module.exports = { createLogger, redact };
