'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { SessionManager } = require('./session/manager');

const WS_HEARTBEAT_MS = 20000;

function resolvePublicDir(config) {
  const candidates = [
    config.publicDir,
    path.join(__dirname, '../public'), // Docker image layout (/app/src, /app/public)
    path.join(__dirname, '../../frontend/public'), // repository layout
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(path.join(p, 'index.html'))) || candidates[candidates.length - 1];
}

function resolveGuacamoleJs() {
  try {
    const pkg = path.dirname(require.resolve('guacamole-common-js/package.json'));
    const file = path.join(pkg, 'dist/cjs/guacamole-common.min.js');
    if (fs.existsSync(file)) return file;
  } catch { /* not installed */ }
  return null;
}

function createApp({ config, log, manager }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);

  // URLs may legitimately contain the RDP password (URL compatibility), so
  // never leak them through the Referer header.
  app.use((req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  // Same CORS behaviour as the original project (cors()).
  app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });
  app.use(express.json({ limit: '32kb' }));

  const issue = (body, res, legacy) => {
    try {
      const r = manager.issueTicket(body || {});
      res.json(legacy ? { token: r.ticket, ...r } : r);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) log.error('ticket error', { error: err.message });
      res.status(status).json({ error: err.message || '生成令牌失败' });
    }
  };

  app.post('/api/session', (req, res) => issue(req.body, res, false));
  // Legacy endpoints of the original project; return a one-time ticket that
  // the websocket endpoint accepts as `?token=`.
  app.post('/api/rdp/token', (req, res) => issue(req.body, res, true));
  app.get('/api/rdp/connect', (req, res) => issue(req.query, res, true));

  app.get('/healthz', async (req, res) => {
    const body = { ok: true, uptime: Math.round(process.uptime()), sessions: manager.sessions.size };
    if (req.query.deep) {
      body.guacd = await new Promise((resolve) => {
        const s = net.connect({ host: config.guacdHost, port: config.guacdPort });
        const done = (v) => { s.destroy(); resolve(v); };
        s.setTimeout(2000, () => done(false));
        s.on('connect', () => done(true));
        s.on('error', () => done(false));
      });
      body.ok = body.guacd;
    }
    res.status(body.ok ? 200 : 503).json(body);
  });

  const guacJs = resolveGuacamoleJs();
  if (guacJs) {
    app.get('/guacamole-common-js/dist/guacamole-common.min.js', (req, res) => {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(guacJs);
    });
  } else {
    log.warn('guacamole-common-js not found in node_modules; expecting it in the public dir');
  }

  const publicDir = resolvePublicDir(config);
  log.info(`static files: ${publicDir}`);
  app.use(express.static(publicDir, {
    index: false,
    setHeaders: (res, file) => {
      if (/\.(js|css|svg|png|webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  const sendIndex = (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(publicDir, 'index.html'));
  };
  app.get('*', sendIndex);
  return app;
}

function attachWebSocket({ server, manager, log }) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has('guacamole') ? 'guacamole' : false),
  });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { socket.destroy(); return; }
    const ticket = url.searchParams.get('ticket') || url.searchParams.get('token');
    if (!ticket) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      manager.attach(ws, ticket).catch((err) => {
        log.error('attach failed', { error: err.message });
        try { ws.close(1011); } catch { /* ignore */ }
      });
    });
  });

  // Detect dead browsers (sleeping phones, broken NAT) so that control is
  // released and the primary grace period starts in a timely manner.
  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, WS_HEARTBEAT_MS);
  hb.unref();
  wss.on('close', () => clearInterval(hb));
  return wss;
}

function createServer({ config, log }) {
  const manager = new SessionManager({ config, log });
  const app = createApp({ config, log, manager });
  const server = http.createServer(app);
  server.keepAliveTimeout = 65000;
  const wss = attachWebSocket({ server, manager, log });
  const shutdown = () => new Promise((resolve) => {
    manager.shutdown();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
  return { app, server, manager, wss, shutdown };
}

module.exports = { createServer, createApp };
