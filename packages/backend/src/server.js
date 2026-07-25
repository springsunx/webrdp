const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const express = require('express');
const GuacamoleLite = require('guacamole-lite');

const SessionManager = require('./session-manager');

const PORT = parseInteger(process.env.PORT, 3000, 1, 65535);
const GUACD_HOST = process.env.GUACD_HOST || 'localhost';
const GUACD_PORT = parseInteger(process.env.GUACD_PORT, 4822, 1, 65535);
const SESSION_TTL_MS = parseInteger(
  process.env.SESSION_TTL_MS,
  8 * 60 * 60 * 1000,
  60 * 1000,
  7 * 24 * 60 * 60 * 1000,
);
const JOIN_TOKEN_TTL_MS = parseInteger(
  process.env.JOIN_TOKEN_TTL_MS,
  60 * 1000,
  10 * 1000,
  5 * 60 * 1000,
);
const MAX_VIEWERS = parseInteger(process.env.MAX_VIEWERS, 20, 1, 500);
const TOKEN_ENCRYPTION_KEY = loadEncryptionKey();

const sessions = new SessionManager({ ttlMs: SESSION_TTL_MS, maxViewers: MAX_VIEWERS });

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

const bundledPublicPath = path.join(__dirname, '../public');
const sourcePublicPath = path.join(__dirname, '../../frontend/public');
const publicPath = fs.existsSync(bundledPublicPath) ? bundledPublicPath : sourcePublicPath;
app.use(express.static(publicPath));
app.use(
  '/guacamole-common-js/dist',
  express.static(path.join(__dirname, '../node_modules/guacamole-common-js/dist/cjs')),
);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    activeSessions: sessions.activeCount,
    guacd: `${GUACD_HOST}:${GUACD_PORT}`,
  });
});

app.post('/api/sessions', (req, res) => {
  try {
    const rdp = normalizeRdpSettings(req.body);
    const session = sessions.create();
    const token = encryptToken({
      expiration: Date.now() + JOIN_TOKEN_TTL_MS,
      sessionId: session.roomId,
      role: 'controller',
      connection: { type: 'rdp', settings: rdp },
    });
    res.status(201).json({
      roomId: session.roomId,
      ownerSecret: session.ownerSecret,
      expiresAt: session.expiresAt,
      token,
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

app.get('/api/sessions/:roomId', (req, res) => {
  const session = sessions.getPublic(req.params.roomId);
  if (!session) return res.status(404).json({ error: '共享会话不存在或已结束' });
  return res.json(session);
});

app.post('/api/sessions/:roomId/join', (req, res) => {
  try {
    const join = sessions.createJoin(req.params.roomId);
    const display = normalizeDisplaySettings(req.body);
    const token = encryptToken({
      expiration: Date.now() + JOIN_TOKEN_TTL_MS,
      sessionId: join.roomId,
      participantId: join.participantId,
      role: 'viewer',
      connection: {
        join: join.guacdConnectionId,
        settings: { ...display, 'read-only': true },
      },
    });
    res.json({
      roomId: join.roomId,
      participantId: join.participantId,
      expiresAt: join.expiresAt,
      token,
    });
  } catch (error) {
    sendApiError(res, error);
  }
});

app.delete('/api/sessions/:roomId', (req, res) => {
  try {
    sessions.end(req.params.roomId, req.get('x-owner-secret') || '');
    closeSessionConnections(req.params.roomId);
    res.status(204).end();
  } catch (error) {
    sendApiError(res, error);
  }
});

app.get('*', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));

const server = http.createServer(app);
const guacdOptions = { host: GUACD_HOST, port: GUACD_PORT };
const clientOptions = {
  crypt: { key: TOKEN_ENCRYPTION_KEY, cypher: 'aes-256-cbc' },
  connectionDefaultSettings: {
    join: {
      width: 1024,
      height: 768,
      dpi: 96,
      audio: ['audio/L16'],
      video: null,
      image: ['image/png', 'image/jpeg'],
      timezone: null,
    },
  },
  log: { level: process.env.GUACAMOLE_LOG_LEVEL || 'NORMAL' },
};
const callbacks = {
  processConnectionSettings: (settings, callback) => {
    try {
      validateConnectionToken(settings);
      callback(null, settings);
    } catch (error) {
      callback(error);
    }
  },
  sessionRegistry: new Map(),
};

const guacServer = new GuacamoleLite({ server }, guacdOptions, clientOptions, callbacks);

guacServer.on('open', (clientConnection) => {
  const metadata = getConnectionMetadata(clientConnection);
  if (!metadata.sessionId || !metadata.role) return;
  try {
    if (metadata.role === 'controller') {
      sessions.activate(metadata.sessionId, clientConnection.guacamoleConnectionId);
      console.log(`[WebRDP] 共享会话已激活: ${metadata.sessionId}`);
    } else if (metadata.role === 'viewer') {
      sessions.viewerOpened(metadata.sessionId, metadata.participantId);
      console.log(`[WebRDP] 观看者已加入: ${metadata.sessionId}`);
    }
  } catch (error) {
    console.error('[WebRDP] 更新会话打开状态失败:', error);
  }
});

guacServer.on('close', (clientConnection) => {
  const metadata = getConnectionMetadata(clientConnection);
  if (!metadata.sessionId || !metadata.role) return;
  if (metadata.role === 'controller') {
    sessions.controllerClosed(metadata.sessionId);
    console.log(`[WebRDP] 主连接已关闭: ${metadata.sessionId}`);
  } else if (metadata.role === 'viewer') {
    sessions.viewerClosed(metadata.sessionId, metadata.participantId);
  }
});

guacServer.on('error', (clientConnection, error) => {
  const metadata = getConnectionMetadata(clientConnection);
  console.error(
    `[WebRDP] Guacamole 连接错误${metadata.sessionId ? ` (${metadata.sessionId})` : ''}:`,
    error,
  );
});

const cleanupTimer = setInterval(() => {
  const removed = sessions.cleanupExpired();
  if (removed > 0) console.log(`[WebRDP] 已清理 ${removed} 个过期共享会话`);
}, 60 * 1000);
cleanupTimer.unref();

server.listen(PORT, () => {
  console.log(`[WebRDP] 服务运行在 http://localhost:${PORT}`);
  console.log(`[WebRDP] guacd: ${GUACD_HOST}:${GUACD_PORT}`);
  console.log(`[WebRDP] 最大观看人数: ${MAX_VIEWERS}`);
});

function closeSessionConnections(roomId) {
  for (const connection of guacServer.activeConnections.values()) {
    if (getConnectionMetadata(connection).sessionId === roomId) connection.close();
  }
}
function validateConnectionToken(settings) {
  if (!settings || !Number.isFinite(Number(settings.expiration))) {
    throw apiError(401, '连接令牌缺少有效期');
  }
  if (Date.now() > Number(settings.expiration)) throw apiError(401, '连接令牌已过期');

  const sessionId = settings.sessionId;
  const role = settings.role;
  if (!sessionId || !['controller', 'viewer'].includes(role)) {
    throw apiError(401, '连接令牌缺少会话身份');
  }

  const session = sessions.get(sessionId);
  if (!session || session.state === 'closed' || session.expiresAt <= Date.now()) {
    throw apiError(404, '共享会话不存在或已结束');
  }
  if (role === 'controller' && session.state !== 'creating') {
    throw apiError(409, '主会话已经连接');
  }
  if (role === 'viewer') {
    if (session.state !== 'active') throw apiError(409, '共享会话尚未就绪');
    if (!settings.participantId || !session.pendingViewers.has(settings.participantId)) {
      throw apiError(401, '观看令牌无效或已被使用');
    }
    if (
      !settings.connection ||
      settings.connection.join !== session.guacdConnectionId ||
      settings.connection?.['read-only'] !== true
    ) {
      throw apiError(403, '观看连接必须为只读 Join 会话');
    }
  }
}

function getConnectionMetadata(clientConnection) {
  const settings = clientConnection?.connectionSettings || {};
  return {
    sessionId: settings.sessionId,
    participantId: settings.participantId,
    role: settings.role,
  };
}

function normalizeRdpSettings(input = {}) {
  const hostname = cleanString(input.host, 255);
  const username = cleanString(input.user, 255);
  const password = typeof input.password === 'string' ? input.password : '';
  if (!hostname || !username || !password) {
    throw apiError(400, '缺少必需参数：host、user、password');
  }
  return {
    hostname,
    port: String(parseInteger(input.port, 3389, 1, 65535)),
    username,
    password,
    ...normalizeDisplaySettings(input),
    security: ['any', 'nla', 'tls', 'rdp'].includes(input.security) ? input.security : 'any',
    'ignore-cert': input.ignoreCert === false ? 'false' : 'true',
    'disable-upload': 'true',
    'disable-download': 'true',
  };
}

function normalizeDisplaySettings(input = {}) {
  return {
    width: String(parseInteger(input.width, 1024, 320, 7680)),
    height: String(parseInteger(input.height, 768, 240, 4320)),
    dpi: String(parseInteger(input.dpi, 96, 48, 480)),
    audio: ['audio/L16'],
    video: null,
    image: ['image/png', 'image/jpeg'],
  };
}

function cleanString(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function parseInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function loadEncryptionKey() {
  const configured = process.env.TOKEN_ENCRYPTION_KEY;
  if (configured) {
    const key = Buffer.from(configured, 'base64');
    if (key.length !== 32) {
      throw new Error('TOKEN_ENCRYPTION_KEY 必须是 32 字节密钥的 Base64 编码');
    }
    return key;
  }
  console.warn(
    '[WebRDP] 未配置 TOKEN_ENCRYPTION_KEY，正在使用临时密钥。生产环境和多实例部署必须配置持久密钥。',
  );
  return crypto.randomBytes(32);
}

function encryptToken(data) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', TOKEN_ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return Buffer.from(JSON.stringify({ iv: iv.toString('base64'), value: encrypted })).toString(
    'base64',
  );
}

function apiError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sendApiError(res, error) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) console.error('[WebRDP] API 错误:', error);
  res.status(status).json({ error: error.message || '服务器内部错误' });
}

function gracefulShutdown(signal) {
  console.log(`[WebRDP] 收到 ${signal}，正在关闭...`);
  clearInterval(cleanupTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = { app, server, sessions };