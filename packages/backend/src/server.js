'use strict';

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createServer } = require('./app');

const config = loadConfig();
const log = createLogger(config.logLevel);

log.info('[WebRDP] starting', {
  port: config.port,
  guacd: `${config.guacdHost}:${config.guacdPort}`,
  primaryGraceSeconds: config.primaryGraceMs / 1000,
  sessionIdleSeconds: config.sessionIdleMs / 1000,
});

const { server, shutdown } = createServer({ config, log });

server.listen(config.port, config.host, () => {
  log.info(`[WebRDP] listening on http://${config.host}:${config.port}`);
});

let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  log.info(`[WebRDP] ${signal} received, shutting down`);
  const force = setTimeout(() => {
    log.error('[WebRDP] shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000);
  force.unref();
  shutdown().then(() => process.exit(0));
};

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('unhandled rejection', { error: String((err && err.stack) || err) }));
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { error: String((err && err.stack) || err) });
  // Keep serving other sessions; a crash would drop every shared session.
});
