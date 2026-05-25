const GuacamoleLite = require('guacamole-lite');
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');

// 会话共享组件
const SessionShareServerV2 = require('./SessionShareServerV2');

// 配置
const PORT = parseInt(process.env.PORT || '3000', 10);
const GUACD_HOST = process.env.GUACD_HOST || 'localhost';
const GUACD_PORT = parseInt(process.env.GUACD_PORT || '4822', 10);

// 调试信息
console.log(`[WebRDP] 配置信息:`);
console.log(`  PORT: ${PORT}`);
console.log(`  GUACD_HOST: ${GUACD_HOST}`);
console.log(`  GUACD_PORT: ${GUACD_PORT}`);

// 生成加密密钥
console.log('[WebRDP] 生成内存加密密钥...');
const ENCRYPTION_KEY = crypto.randomBytes(32);
console.log('[WebRDP] 加密密钥已生成。');

// Express 应用
const app = express();
app.use(express.json());
app.use(cors());

// 静态文件服务 - 提供前端文件
const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));
console.log(`[WebRDP] 静态文件目录: ${publicPath}`);

// 加密令牌函数
const encryptToken = (data) => {
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return Buffer.from(JSON.stringify({
      iv: iv.toString('base64'),
      value: encrypted
    })).toString('base64');
  } catch (e) {
    console.error('[WebRDP] 令牌加密失败:', e);
    throw new Error('令牌加密失败');
  }
};

// API: 生成 RDP 连接令牌
app.post('/api/rdp/token', (req, res) => {
  const { host, port, user, password, width, height, dpi, security, ignoreCert } = req.body;

  if (!host || !user || !password) {
    return res.status(400).json({ error: '缺少必需的参数 (host, user, password)' });
  }

  const settings = {
    hostname: host,
    port: String(port || 3389),
    username: user,
    password: password,
    width: String(width || 1024),
    height: String(height || 768),
    dpi: String(dpi || 96),
    security: security || 'any',
    'ignore-cert': String(ignoreCert || 'true'),
  };

  const connectionParams = {
    connection: {
      type: 'rdp',
      settings: settings
    }
  };

  try {
    const token = encryptToken(connectionParams);
    res.json({ token });
  } catch (error) {
    console.error('[WebRDP] 生成令牌失败:', error);
    res.status(500).json({ error: '生成令牌失败' });
  }
});

// API: 通过 URL 参数生成令牌
app.get('/api/rdp/connect', (req, res) => {
  const { host, port, user, password, width, height } = req.query;

  if (!host || !user || !password) {
    return res.status(400).json({ error: '缺少必需的参数 (host, user, password)' });
  }

  const settings = {
    hostname: host,
    port: String(port || 3389),
    username: user,
    password: password,
    width: String(width || 1024),
    height: String(height || 768),
    dpi: '96',
    security: 'any',
    'ignore-cert': 'true',
  };

  const connectionParams = {
    connection: {
      type: 'rdp',
      settings: settings
    }
  };

  try {
    const token = encryptToken(connectionParams);
    res.json({ token });
  } catch (error) {
    console.error('[WebRDP] 生成令牌失败:', error);
    res.status(500).json({ error: '生成令牌失败' });
  }
});

// 会话状态 API
app.get('/api/session/status', (req, res) => {
  const { session, clientId } = req.query;
  if (!session || !clientId) {
    return res.status(400).json({ error: '缺少参数' });
  }

  const sessionData = sessionShareServer.sessions.get(session);
  const clientData = sessionShareServer.clients.get(clientId);

  res.json({
    exists: !!sessionData,
    mode: clientData?.mode || 'viewer',
    controllerId: sessionData?.controllerId,
    clientCount: sessionData?.clients?.size || 0,
    state: sessionData?.state || 'pending'
  });
});

// 请求/释放主控
app.post('/api/session/control', (req, res) => {
  const { session, clientId, action } = req.body;
  if (!session || !clientId || !action) {
    return res.status(400).json({ error: '缺少参数' });
  }

  if (action === 'request') {
    sessionShareServer.requestControl(clientId);
  } else if (action === 'release') {
    sessionShareServer.releaseControl(clientId);
  }

  const sessionData = sessionShareServer.sessions.get(session);
  res.json({
    success: true,
    controllerId: sessionData?.controllerId
  });
});

// 心跳
app.post('/api/session/heartbeat', (req, res) => {
  const { session, clientId } = req.body;
  if (session && clientId) {
    const sessionData = sessionShareServer.sessions.get(session);
    if (sessionData) {
      sessionData.lastActivity = Date.now();
    }
  }
  res.json({ success: true });
});

// 统计信息
app.get('/api/session/stats', (req, res) => {
  res.json(sessionShareServer.getStats());
});

// 默认路由 - 返回前端页面
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// 创建 HTTP 服务器
const server = http.createServer(app);

// Guacamole Lite 配置 - 不指定端口，使用 server 参数
const guacdOptions = {
  host: GUACD_HOST,
  port: GUACD_PORT,
};

const clientOptions = {
  crypt: {
    key: ENCRYPTION_KEY,
    cypher: 'aes-256-cbc'
  },
};

// 初始化 Guacamole Lite 服务器 - 使用 httpServer 参数
try {
  console.log(`[WebRDP] 初始化 GuacamoleLite: Guacd=${guacdOptions.host}:${guacdOptions.port}`);
  const guacServer = new GuacamoleLite({ server }, guacdOptions, clientOptions);
  console.log('[WebRDP] GuacamoleLite 初始化成功。');

  guacServer.on('error', (error) => {
    console.error('[WebRDP] GuacamoleLite 服务器错误:', error);
  });

  guacServer.on('connection', (client) => {
    console.log(`[WebRDP] 新连接: 客户端 ID=${client.id}`);
  });
} catch (error) {
  console.error('[WebRDP] 初始化 GuacamoleLite 失败:', error);
  process.exit(1);
}

// 初始化会话共享服务器（只处理控制连接）
const sessionShareServer = new SessionShareServerV2(server, guacdOptions, clientOptions);
console.log('[WebRDP] 会话共享服务器初始化成功');

// 启动 HTTP 服务器
server.listen(PORT, () => {
  console.log(`[WebRDP] 服务器运行在端口 ${PORT}`);
  console.log(`[WebRDP] 访问地址: http://localhost:${PORT}`);
});

// 优雅关闭
const gracefulShutdown = (signal) => {
  console.log(`[WebRDP] 收到 ${signal} 信号，正在关闭...`);

  server.close(() => {
    console.log('[WebRDP] 服务器已关闭');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[WebRDP] 关闭超时，强制退出');
    process.exit(1);
  }, 10000);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));