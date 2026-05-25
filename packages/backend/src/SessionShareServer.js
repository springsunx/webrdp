/**
 * SessionShareServer v3 - 会话共享服务器
 * 
 * 核心思路：直接转发原始的 Guacamole 协议数据
 */

const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const crypto = require('crypto');

class SessionShareServer {
    constructor(httpServer, guacdOptions, clientOptions = {}) {
        this.httpServer = httpServer;
        this.guacdHost = guacdOptions.host || 'localhost';
        this.guacdPort = guacdOptions.port || 4822;
        this.clientOptions = clientOptions;
        
        this.sessions = new Map();
        this.clients = new Map();
        
        this.wss = new WebSocket.Server({ 
            noServer: true,
            perMessageDeflate: false
        });
        
        this.setupWebSocket();
        this.startCleanup();
        
        console.log('[SessionShare v3] 会话共享服务器已初始化');
    }

    setupWebSocket() {
        this.httpServer.on('upgrade', (request, socket, head) => {
            const url = new URL(request.url, `http://${request.headers.host}`);
            
            if (url.pathname !== '/ws/session') {
                return;
            }
            
            this.wss.handleUpgrade(request, socket, head, (ws) => {
                this.wss.emit('connection', ws, request);
            });
        });

        this.wss.on('connection', (ws, req) => {
            this.handleConnection(ws, req);
        });
    }

    handleConnection(ws, req) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const clientId = url.searchParams.get('clientId') || this.generateId();
        const token = url.searchParams.get('token');
        const width = (url.searchParams.get('width') || '1024').replace(/[^0-9]/g, '') || '1024';
        const height = (url.searchParams.get('height') || '768').replace(/[^0-9]/g, '') || '768';

        if (!token) {
            ws.close(4001, 'Missing token');
            return;
        }

        let connectionParams;
        try {
            connectionParams = this.decryptToken(token);
            if (!connectionParams.args) connectionParams.args = 'connect';
            console.log('[SessionShare v3] 连接参数:', JSON.stringify(connectionParams));
        } catch (e) {
            console.error('[SessionShare v3] Token 解密失败:', e.message);
            ws.close(4002, 'Invalid token');
            return;
        }

        const sessionKey = `${connectionParams.hostname}:${connectionParams.port}:${connectionParams.username}`;
        console.log(`[SessionShare v3] 客户端连接: ${clientId}, 会话: ${sessionKey}`);

        this.clients.set(clientId, {
            id: clientId, sessionKey, ws, mode: 'viewer', joinedAt: Date.now()
        });

        let session = this.sessions.get(sessionKey);
        if (!session) {
            session = {
                key: sessionKey, params: connectionParams, width, height,
                clients: new Set(), controllerId: null,
                guacdSocket: null, state: 'pending',
                handshakeComplete: false,
                createdAt: Date.now(), lastActivity: Date.now()
            };
            this.sessions.set(sessionKey, session);
        }

        session.clients.add(clientId);

        if (!session.controllerId) {
            session.controllerId = clientId;
            this.clients.get(clientId).mode = 'controller';
        }

        // 如果是主控且 guacd 未连接，建立连接
        if (this.clients.get(clientId).mode === 'controller' && !session.guacdSocket) {
            this.connectToGuacd(sessionKey);
        }
        
        // 如果会话已连接，通知新客户端
        if (session.handshakeComplete) {
            console.log(`[SessionShare v3] 新客户端加入已连接的会话`);
            
            // 重放最近的数据（用于初始化画面）
            if (session.recentData && session.recentData.length > 0) {
                const totalSize = session.recentData.join('').length;
                console.log(`[SessionShare v3] 重放 ${session.recentData.length} 条指令, 共 ${totalSize} bytes`);
                for (const data of session.recentData) {
                    this.sendToClient(clientId, data);
                }
            }
            
            // 发送 session-status 消息
            this.sendToClient(clientId, {
                type: 'session-status',
                sessionKey: sessionKey,
                mode: this.clients.get(clientId).mode,
                controllerId: session.controllerId,
                clientCount: session.clients.size,
                state: 'connected'
            });
        }

        this.notifyClientStatus(clientId);

        // 处理客户端消息
        ws.on('message', (data) => {
            this.handleMessage(clientId, data);
        });

        ws.on('close', (code, reason) => {
            console.log(`[SessionShare v3] WebSocket 关闭: ${clientId}, code=${code}`);
            this.handleDisconnect(clientId);
        });

        ws.on('error', (error) => {
            console.error(`[SessionShare v3] WebSocket 错误:`, error.message);
            this.handleDisconnect(clientId);
        });
    }

    connectToGuacd(sessionKey) {
        const session = this.sessions.get(sessionKey);
        if (!session || session.guacdSocket) return;

        console.log(`[SessionShare v3] 连接 guacd: ${this.guacdHost}:${this.guacdPort}`);

        const socket = new net.Socket();
        socket.setEncoding('utf8');

        socket.on('connect', () => {
            console.log(`[SessionShare v3] guacd 连接成功`);
            session.guacdSocket = socket;
            session.state = 'connecting';
            session.handshakeComplete = false;
            
            // 发送 select 指令
            socket.write('6.select,3.rdp;');
        });

        socket.on('data', (data) => {
            this.handleGuacdData(sessionKey, data);
        });

        socket.on('close', () => {
            console.log(`[SessionShare v3] guacd 连接关闭`);
            session.guacdSocket = null;
            session.state = 'disconnected';
            this.broadcastToSession(sessionKey, { type: 'session-state', state: 'disconnected' });
        });

        socket.on('error', (error) => {
            console.error(`[SessionShare v3] guacd 错误:`, error.message);
            session.guacdSocket = null;
            this.broadcastToSession(sessionKey, { type: 'error', message: error.message });
        });

        socket.connect(this.guacdPort, this.guacdHost);
    }

    handleGuacdData(sessionKey, data) {
        const session = this.sessions.get(sessionKey);
        if (!session) return;

        session.lastActivity = Date.now();

        if (!session.handshakeComplete) {
            // 握手阶段：处理 args 指令
            session.buffer += data;
            
            if (session.buffer.includes('4.args,')) {
                // 解析 args 中的参数名称
                const argsMatch = session.buffer.match(/4\.args,(.*?);/);
                if (!argsMatch) return;
                
                const argsRaw = argsMatch[1];
                const paramNames = [];
                let pos = 0;
                while (pos < argsRaw.length) {
                    const dotPos = argsRaw.indexOf('.', pos);
                    if (dotPos === -1) break;
                    const len = parseInt(argsRaw.substring(pos, dotPos), 10);
                    pos = dotPos + 1;
                    const val = argsRaw.substring(pos, pos + len);
                    pos += len;
                    paramNames.push(val);
                    if (pos < argsRaw.length && argsRaw[pos] === ',') pos++;
                }
                
                // 发送 size/audio/video/image（使用连接参数中的宽度/高度）
                const rdpWidth = session.params.width || session.width || '1024';
                const rdpHeight = session.params.height || session.height || '768';
                const sizeCmd = `4.size,${String(rdpWidth).length}.${rdpWidth},${String(rdpHeight).length}.${rdpHeight},2.96`;
                console.log(`[SessionShare v3] 发送 size: ${sizeCmd}`);
                session.guacdSocket.write(sizeCmd + ';');
                session.guacdSocket.write('5.audio;');
                session.guacdSocket.write('5.video;');
                session.guacdSocket.write('5.image;');
                
                // args 参数在 opcode 中，不在参数列表中
                // 需要手动添加 args 参数
                paramNames.unshift('args');
                
                // 构建连接参数值
                const paramValues = paramNames.map(name => {
                    const p = session.params;
                    switch (name) {
                        case 'args': return 'connect';
                        case 'hostname': return p.hostname;
                        case 'port': return p.port || '3389';
                        case 'username': return p.username;
                        case 'password': return p.password;
                        case 'width': return session.width;
                        case 'height': return session.height;
                        case 'dpi': return p.dpi || '96';
                        case 'security': return p.security || 'any';
                        case 'ignore-cert': return p['ignore-cert'] || 'true';
                        default: return null;
                    }
                });
                
                const argsStr = paramValues.map(v => v === null || v === undefined ? '0.' : `${String(v).length}.${v}`).join(',') + ';';
                console.log(`[SessionShare v3] 发送 ${paramValues.length} 个连接参数`);
                session.guacdSocket.write(argsStr);
                session.buffer = '';
            } else if (session.buffer.includes('5.ready,')) {
                // 收到 ready 指令，握手完成
                session.handshakeComplete = true;
                session.state = 'connected';
                // 将缓冲区数据转发给客户端
                this.broadcastToSession(sessionKey, session.buffer);
                session.buffer = '';
                console.log(`[SessionShare v3] 握手完成`);
            }
        } else {
            // 连接已就绪，直接转发
            this.broadcastToSession(sessionKey, data);
            
            // 存储最近的数据（用于新客户端同步）
            // 存储所有数据，保持完整的画面状态
            if (!session.recentData) session.recentData = [];
            session.recentData.push(data.toString());
            // 保留最近 200KB 的数据
            while (session.recentData.join('').length > 200000) {
                session.recentData.shift();
            }
        }
    }

    handleMessage(clientId, data) {
        const client = this.clients.get(clientId);
        if (!client) return;

        const dataStr = data.toString();

        try {
            const msg = JSON.parse(dataStr);
            if (msg.type === 'request-control') { this.requestControl(clientId); return; }
            if (msg.type === 'release-control') { this.releaseControl(clientId); return; }
            if (msg.type === 'ping') { this.sendToClient(clientId, { type: 'pong' }); return; }
            return;
        } catch (e) {}

        if (client.mode !== 'controller') return;
        const session = this.sessions.get(client.sessionKey);
        if (!session || !session.guacdSocket) return;
        try { session.guacdSocket.write(dataStr); } catch (e) {}
    }

    handleDisconnect(clientId) {
        const client = this.clients.get(clientId);
        if (!client) return;

        const session = this.sessions.get(client.sessionKey);
        if (session) {
            session.clients.delete(clientId);
            if (session.controllerId === clientId) {
                session.controllerId = null;
                if (session.clients.size > 0) {
                    const cid = session.clients.values().next().value;
                    session.controllerId = cid;
                    const c = this.clients.get(cid);
                    if (c) c.mode = 'controller';
                }
                this.broadcastToSession(client.sessionKey, {
                    type: 'control-status', controllerId: session.controllerId
                });
            }
            if (session.clients.size === 0) {
                if (session.guacdSocket) { session.guacdSocket.destroy(); }
                this.sessions.delete(client.sessionKey);
            }
        }
        this.clients.delete(clientId);
    }

    requestControl(clientId) {
        const client = this.clients.get(clientId);
        if (!client) return false;
        const session = this.sessions.get(client.sessionKey);
        if (!session) return false;
        if (session.controllerId && session.controllerId !== clientId) {
            this.sendToClient(clientId, { type: 'control-denied', message: '已有主控' });
            return false;
        }
        session.controllerId = clientId;
        client.mode = 'controller';
        this.broadcastToSession(client.sessionKey, { type: 'control-status', controllerId: clientId });
        return true;
    }

    releaseControl(clientId) {
        const client = this.clients.get(clientId);
        if (!client) return;
        const session = this.sessions.get(client.sessionKey);
        if (!session || session.controllerId !== clientId) return;
        session.controllerId = null;
        client.mode = 'viewer';
        if (session.clients.size > 0) {
            for (const cid of session.clients) {
                if (cid !== clientId) { session.controllerId = cid; this.clients.get(cid).mode = 'controller'; break; }
            }
        }
        this.broadcastToSession(client.sessionKey, { type: 'control-status', controllerId: session.controllerId });
    }

    broadcastToSession(sessionKey, data) {
        const session = this.sessions.get(sessionKey);
        if (!session) return;
        const message = typeof data === 'string' ? data : JSON.stringify(data);
        for (const cid of session.clients) {
            const c = this.clients.get(cid);
            if (c && c.ws && c.ws.readyState === WebSocket.OPEN) {
                try { c.ws.send(message); } catch (e) {}
            }
        }
    }

    sendToClient(clientId, data) {
        const c = this.clients.get(clientId);
        if (c && c.ws && c.ws.readyState === WebSocket.OPEN) {
            try { c.ws.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch (e) {}
        }
    }

    notifyClientStatus(clientId) {
        const c = this.clients.get(clientId);
        if (!c) return;
        const s = this.sessions.get(c.sessionKey);
        if (!s) return;
        this.sendToClient(clientId, {
            type: 'session-status', sessionKey: c.sessionKey,
            mode: c.mode, controllerId: s.controllerId,
            clientCount: s.clients.size, state: s.state
        });
    }

    decryptToken(token) {
        const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
        const iv = Buffer.from(decoded.iv, 'base64');
        const encrypted = Buffer.from(decoded.value, 'base64');
        const key = this.clientOptions.crypt?.key;
        const keyBuffer = Buffer.isBuffer(key) ? key : Buffer.from(key);
        const decipher = crypto.createDecipheriv('aes-256-cbc', keyBuffer.slice(0, 32), iv);
        let dt = decipher.update(encrypted, 'base64', 'utf8');
        dt += decipher.final('utf8');
        return JSON.parse(dt).connection?.settings || JSON.parse(dt);
    }

    generateId() { return crypto.randomBytes(8).toString('hex'); }

    startCleanup() {
        setInterval(() => {
            const timeout = 5 * 60 * 1000;
            for (const [key, s] of this.sessions) {
                if (s.clients.size === 0 || Date.now() - s.lastActivity > timeout) {
                    if (s.guacdSocket) s.guacdSocket.destroy();
                    this.sessions.delete(key);
                }
            }
        }, 30000);
    }

    getStats() {
        return { sessions: this.sessions.size, clients: this.clients.size };
    }
}

module.exports = SessionShareServer;
