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
const PRIMARY_RECONNECT_GRACE_MS = parseInteger(
  process.env.PRIMARY_RECONNECT_GRACE_MS,
  24 * 60 * 60 * 1000,
  10 * 1000,
  30 * 24 * 60 * 60 * 1000,
);
const GUACAMOLE_MAX_INACTIVITY_MS = parseInteger(
  process.env.GUACAMOLE_MAX_INACTIVITY_MS,
  0,
  0,
  60 * 60 * 1000,
);
const MAX_VIEWERS = parseInteger(process.env.MAX_VIEWERS, 20, 1, 500);
const COLLABORATION_MESSAGE_ID = 0x0100;
const TOKEN_ENCRYPTION_KEY = loadEncryptionKey();

const sessions = new SessionManager({
  ttlMs: SESSION_TTL_MS,
  maxViewers: MAX_VIEWERS,
  pendingTtlMs: JOIN_TOKEN_TTL_MS,
  reconnectGraceMs: PRIMARY_RECONNECT_GRACE_MS,
});

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
    const connectionKey = createConnectionKey(rdp);
    const opened = sessions.openOrCreate(connectionKey, rdp);

    if (!opened.created) {
      if (opened.session.state === 'creating') {
        return res.status(409).json({ error: '主连接正在建立，请稍后重试', retryAfterMs: 500 });
      }
      if (opened.session.state === 'reconnecting') {
        const session = sessions.resumePrimaryByConnection(opened.session);
        session.connectionSettings = rdp;
        return res.json(createPrimaryResponse(session, rdp));
      }
      return res.json(createParticipantResponse(opened.session.roomId, req.body));
    }

    return res.status(201).json(createPrimaryResponse(opened.session, rdp));
  } catch (error) {
    return sendApiError(res, error);
  }
});

app.get('/api/sessions/:roomId', (req, res) => {
  try {
    const identity = readParticipantIdentity(req);
    const session = sessions.getPublic(
      req.params.roomId,
      identity.participantId,
      identity.participantSecret,
    );
    if (!session) return res.status(404).json({ error: '共享会话不存在或已结束' });
    return res.json(session);
  } catch (error) {
    return sendApiError(res, error);
  }
});

app.post('/api/sessions/:roomId/join', (req, res) => {
  try {
    return res.json(createParticipantResponse(req.params.roomId, req.body));
  } catch (error) {
    return sendApiError(res, error);
  }
});

app.post('/api/sessions/:roomId/resume', (req, res) => {
  try {
    const session = sessions.resumePrimary(
      req.params.roomId,
      req.get('x-owner-secret') || '',
    );
    const display = normalizeDisplaySettings(req.body);
    const rdp = { ...session.connectionSettings, ...display };
    session.connectionSettings = rdp;
    return res.json(createPrimaryResponse(session, rdp));
  } catch (error) {
    return sendApiError(res, error);
  }
});

app.post('/api/sessions/:roomId/control', (req, res) => {
  try {
    const identity = readParticipantIdentity(req, true);
    const state = sessions.takeControl(
      req.params.roomId,
      identity.participantId,
      identity.participantSecret,
    );
    broadcastSessionState(req.params.roomId);
    return res.json(state);
  } catch (error) {
    return sendApiError(res, error);
  }
});

app.delete('/api/sessions/:roomId/control', (req, res) => {
  try {
    const identity = readParticipantIdentity(req, true);
    const state = sessions.releaseControl(
      req.params.roomId,
      identity.participantId,
      identity.participantSecret,
    );
    broadcastSessionState(req.params.roomId);
    return res.json(state);
  } catch (error) {
    return sendApiError(res, error);
  }
});

app.delete('/api/sessions/:roomId', (req, res) => {
  try {
    sessions.end(req.params.roomId, req.get('x-owner-secret') || '');
    closeSessionConnections(req.params.roomId);
    return res.status(204).end();
  } catch (error) {
    return sendApiError(res, error);
  }
});

app.get('*', (req, res) => res.sendFile(path.join(publicPath, 'index.html')));

const server = http.createServer(app);
const guacdOptions = { host: GUACD_HOST, port: GUACD_PORT };
const clientOptions = {
  maxInactivityTime: GUACAMOLE_MAX_INACTIVITY_MS,
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
    if (metadata.role === 'primary') {
      sessions.activate(
        metadata.sessionId,
        clientConnection.guacamoleConnectionId,
        metadata.participantId,
        metadata.participantSecret,
      );
      console.log(`[WebRDP] 主会话已激活: ${metadata.sessionId}`);
    } else if (metadata.role === 'participant') {
      sessions.viewerOpened(
        metadata.sessionId,
        metadata.participantId,
        metadata.participantSecret,
      );
      console.log(`[WebRDP] 协作参与者已加入: ${metadata.sessionId}`);
    }
    installInputGuard(clientConnection, metadata);
    broadcastSessionState(metadata.sessionId);
  } catch (error) {
    console.error('[WebRDP] 更新会话打开状态失败:', error);
    clientConnection.close(error);
  }
});

guacServer.on('close', (clientConnection) => {
  const metadata = getConnectionMetadata(clientConnection);
  if (!metadata.sessionId || !metadata.role) return;
  if (metadata.role === 'primary') {
    sessions.controllerClosed(metadata.sessionId, clientConnection.guacamoleConnectionId);
    console.log(`[WebRDP] 主连接已关闭: ${metadata.sessionId}`);
  } else if (metadata.role === 'participant') {
    sessions.viewerClosed(metadata.sessionId, metadata.participantId);
    broadcastSessionState(metadata.sessionId);
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
  console.log(`[WebRDP] 最大协作人数: ${MAX_VIEWERS + 1}`);
  console.log(`[WebRDP] 主连接重连宽限: ${PRIMARY_RECONNECT_GRACE_MS}ms`);
});

function createPrimaryResponse(session, rdp) {
  const token = encryptToken({
    expiration: Date.now() + JOIN_TOKEN_TTL_MS,
    sessionId: session.roomId,
    participantId: session.primaryParticipantId,
    participantSecret: session.primaryParticipantSecret,
    role: 'primary',
    connection: { type: 'rdp', settings: rdp },
  });
  return {
    roomId: session.roomId,
    participantId: session.primaryParticipantId,
    participantSecret: session.primaryParticipantSecret,
    ownerSecret: session.ownerSecret,
    role: 'controller',
    hasControl: true,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    reconnectGraceMs: PRIMARY_RECONNECT_GRACE_MS,
    token,
  };
}

function createParticipantResponse(roomId, displaySettings) {
  const join = sessions.createJoin(roomId);
  const display = normalizeDisplaySettings(displaySettings);
  const token = encryptToken({
    expiration: Date.now() + JOIN_TOKEN_TTL_MS,
    sessionId: join.roomId,
    participantId: join.participantId,
    participantSecret: join.participantSecret,
    role: 'participant',
    connection: {
      join: join.guacdConnectionId,
      settings: { ...display, 'read-only': false },
    },
  });
  return {
    roomId: join.roomId,
    participantId: join.participantId,
    participantSecret: join.participantSecret,
    role: 'viewer',
    hasControl: false,
    createdAt: join.createdAt,
    expiresAt: join.expiresAt,
    token,
  };
}

function closeSessionConnections(roomId) {
  for (const connection of guacServer.activeConnections.values()) {
    if (getConnectionMetadata(connection).sessionId === roomId) connection.close();
  }
}

function broadcastSessionState(roomId) {
  for (const connection of guacServer.activeConnections.values()) {
    const metadata = getConnectionMetadata(connection);
    if (metadata.sessionId !== roomId) continue;
    try {
      const state = sessions.getPublic(
        roomId,
        metadata.participantId,
        metadata.participantSecret,
      );
      if (!state) continue;
      connection.send(encodeInstruction([
        'msg',
        COLLABORATION_MESSAGE_ID,
        state.controlVersion,
        state.controlOwner,
        state.hasControl,
        state.viewerCount,
      ]));
    } catch (error) {
      console.warn('[WebRDP] Failed to push collaboration state', error);
    }
  }
}

function encodeInstruction(parts) {
  return `${parts.map((part) => `${String(part).length}.${part}`).join(',')};`;
}

function installInputGuard(clientConnection, metadata) {
  const forwardToGuacd = clientConnection.sendMessageToGuacd.bind(clientConnection);
  clientConnection.sendMessageToGuacd = (message) => {
    if (sessions.hasControl(metadata.sessionId, metadata.participantId)
      || isPassiveClientMessage(message)) {
      forwardToGuacd(message);
    }
  };
}

function isPassiveClientMessage(message) {
  const opcodes = parseInstructionOpcodes(message);
  return opcodes.length > 0
    && opcodes.every((opcode) => ['ack', 'disconnect', 'nop', 'sync'].includes(opcode));
}

function parseInstructionOpcodes(message) {
  const text = Buffer.isBuffer(message) ? message.toString('utf8') : String(message);
  const opcodes = [];
  let position = 0;
  while (position < text.length) {
    const dot = text.indexOf('.', position);
    if (dot < 0) return [];
    const elementLength = Number.parseInt(text.slice(position, dot), 10);
    if (!Number.isInteger(elementLength) || elementLength < 0) return [];
    const opcodeStart = dot + 1;
    const opcodeEnd = opcodeStart + elementLength;
    if (opcodeEnd > text.length) return [];
    opcodes.push(text.slice(opcodeStart, opcodeEnd));
    const instructionEnd = text.indexOf(';', opcodeEnd);
    if (instructionEnd < 0) return [];
    position = instructionEnd + 1;
  }
  return opcodes;
}

function validateConnectionToken(settings) {
  if (!settings || !Number.isFinite(Number(settings.expiration))) {
    throw apiError(401, '连接令牌缺少有效期');
  }
  if (Date.now() > Number(settings.expiration)) throw apiError(401, '连接令牌已过期');

  const sessionId = settings.sessionId;
  const role = settings.role;
  if (!sessionId || !['primary', 'participant'].includes(role)) {
    throw apiError(401, '连接令牌缺少会话身份');
  }

  const session = sessions.get(sessionId);
  if (!session || session.state === 'closed' || session.expiresAt <= Date.now()) {
    throw apiError(404, '共享会话不存在或已结束');
  }
  if (role === 'primary') {
    if (!['creating', 'reconnecting'].includes(session.state)) {
      throw apiError(409, '主会话已经连接');
    }
    sessions.authenticatePrimary(
      session,
      settings.participantId,
      settings.participantSecret,
    );
  }
  if (role === 'participant') {
    if (session.state !== 'active') throw apiError(409, '共享会话尚未就绪');
    const pending = session.pendingViewers.get(settings.participantId);
    if (!pending || !sessions.safeEqual(pending.participantSecret, settings.participantSecret)) {
      throw apiError(401, '参与者令牌无效或已被使用');
    }
    if (!settings.connection || settings.connection.join !== session.guacdConnectionId
      || [true, 'true'].includes(settings.connection?.['read-only'])) {
      throw apiError(403, '参与者必须加入现有 Guacamole 会话');
    }
  }
}

function getConnectionMetadata(clientConnection) {
  const settings = clientConnection?.connectionSettings || {};
  return {
    sessionId: settings.sessionId,
    participantId: settings.participantId,
    participantSecret: settings.participantSecret,
    role: settings.role,
  };
}

function readParticipantIdentity(req, required = false) {
  const identity = {
    participantId: req.get('x-participant-id') || '',
    participantSecret: req.get('x-participant-secret') || '',
  };
  if (required && (!identity.participantId || !identity.participantSecret)) {
    throw apiError(401, '缺少参与者身份');
  }
  return identity;
}

function createConnectionKey(rdp) {
  const identity = JSON.stringify([
    rdp.hostname,
    rdp.port,
    rdp.username,
    rdp.password,
  ]);
  return crypto.createHmac('sha256', TOKEN_ENCRYPTION_KEY)
    .update(identity)
    .digest('base64url');
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
  return res.status(status).json({ error: error.message || '服务器内部错误' });
}

function gracefulShutdown(signal) {
  console.log(`[WebRDP] 收到 ${signal}，正在关闭...`);
  clearInterval(cleanupTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = { app, server, sessions, isPassiveClientMessage, parseInstructionOpcodes };
