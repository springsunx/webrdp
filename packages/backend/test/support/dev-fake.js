'use strict';

/**
 * Local development helper: starts the fake guacd and the WebRDP gateway
 * together so you can test the UI and multi-user control flow in a browser
 * without a Windows RDP host.
 *
 * Usage: npm run dev:fake
 */

const { FakeGuacd } = require('./fake-guacd');
const { createServer } = require('../../src/app');
const { loadConfig } = require('../../src/config');
const { createLogger } = require('../../src/logger');

(async () => {
  const fake = new FakeGuacd({ syncMs: 500, rdpDelayMs: 100 });
  const guacdPort = await fake.listen(0, '127.0.0.1');
  const config = loadConfig({
    guacdHost: '127.0.0.1',
    guacdPort,
    primaryGraceMs: Number(process.env.PRIMARY_GRACE_SECONDS || 30) * 1000,
  });
  const log = createLogger(config.logLevel);
  const { server, shutdown } = createServer({ config, log });
  server.listen(config.port, config.host, () => {
    log.info(`Fake guacd on 127.0.0.1:${guacdPort}`);
    log.info(`WebRDP ready at http://localhost:${config.port}/?host=demo&user=admin&password=demo`);
  });
  const stop = async () => { await shutdown(); await fake.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})();
