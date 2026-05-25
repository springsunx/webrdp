/**
 * SessionShareServer v3 - 会话共享服务器
 * 直接转发原始 Guacamole 协议数据
 */

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
        
        this.wss = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
        
        this.setupWebSocket();
        this.startCleanup();
        console.log('[SessionShare v3] 初始化完成');
    }

    setupWebSocket() {
        this.httpServer.on('upgrade', (request, socket, head) => {
            const url = new URL(request.url, `http://${request.headers.host}`);
            if (url.pathname !== '/ws/session') return;
            this.wss.handleUpgrade(request, socket, head, (ws) => {
                this.wss.emit('connection', ws, request);
            });
        });

        this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    }

    handleConnection(ws, req) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const clientId = url.searchParams.get('clientId') || this.generateId();
        const token = url.searchParams.get('token');
        const width = url.searchParams.get('width')?.replace(/[^0-9]/g, '') || '1024';
        const height = url.searchParams.get('height')?.replace(/[^0-9]/g, '') || '768';

        if (!token) { ws.close(4001, 'Missing token'); return; }

        let params;
        try {
            params = this.decryptToken(token);
            if (!params.args) params.args = 'connect';
        } catch (e) {
            console.error('[SessionShare v3] Token 解密失败:', e.message);
            ws.close(4002, 'Invalid token');
            return;
        }

        const sessionKey = `${params.hostname}:${params.port}:${params.username}`;
        console.log(`[SessionShare v3] 客户端: ${clientId}, 会话: ${sessionKey}`);

        this.clients.set(clientId, { id: clientId, sessionKey, ws, mode: 'viewer' });

        let session = this.sessions.get(sessionKey);
        if (!session) {
            session = {
                key: sessionKey, params, width, height,
                clients: new Set(), controllerId: null,
                guacdSocket: null, state: 'pending',
                handshakeComplete: false, recentData: [],
                createdAt: Date.now(), lastActivity: Date.now()
            };
            this.sessions.set(sessionKey, session);
        }

        session.clients.add(clientId);

        if (!session.controllerId) {
            session.controllerId = clientId;
            this.clients.get(clientId).mode = 'controller';
        }

        if (this.clients.get(clientId).mode === 'controller' && !session.guacdSocket) {
            this.connectToGuacd(sessionKey);
        }

        if (session.handshakeComplete) {
            console.log(`[SessionShare v3] 新客户端加入`);
            
            // 发送 size 指令创建画布
            if (session.sizeCmd) {
                ws.send(session.sizeCmd);
            }
            
            // 重放最近的画面数据
            if (session.recentData.length > 0) {
                const all = session.recentData.join('');
                console.log(`[SessionShare v3] 重放 ${all.length} bytes`);
                ws.send(all);
            }
            
            ws.send(JSON.stringify({
                type: 'session-status', sessionKey,
                mode: this.clients.get(clientId).mode,
                controllerId: session.controllerId,
                clientCount: session.clients.size, state: 'connected'
            }));
        }

        this.notifyClientStatus(clientId);

        ws.on('message', (data) => this.handleMessage(clientId, data));
        ws.on('close', (code) => {
            console.log(`[SessionShare v3] 断开: ${clientId}, code=${code}`);
            this.handleDisconnect(clientId);
        });
        ws.on('error', (e) => {
            console.error(`[SessionShare v3] 错误:`, e.message);
            this.handleDisconnect(clientId);
        });
    }

    connectToGuacd(sessionKey) {
        const session = this.sessions.get(sessionKey);
        if (!session || session.guacdSocket) return;

        const socket = new net.Socket();
        socket.setEncoding('utf8');

        socket.on('connect', () => {
            session.guacdSocket = socket;
            session.state = 'connecting';
            session.handshakeComplete = false;
            session.recentData = [];
            socket.write('6.select,3.rdp;');
        });

        socket.on('data', (data) => this.handleGuacdData(sessionKey, data));

        socket.on('close', () => {
            session.guacdSocket = null;
            session.state = 'disconnected';
            this.broadcastToSession(sessionKey, { type: 'session-state', state: 'disconnected' });
        });

        socket.on('error', (error) => {
            session.guacdSocket = null;
            this.broadcastToSession(sessionKey, { type: 'error', message: error.message });
        });

        socket.connect(this.guacdPort, this.guacdHost);
    }

    handleGuacdData(sessionKey, data) {
        const session = this.sessions.get(sessionKey);
        if (!session) return;
        session.lastActivity = Date.now();

        const dataStr = data.toString();

        if (!session.handshakeComplete) {
            session.buffer = (session.buffer || '') + dataStr;

            // 处理 args 指令
            if (session.buffer.includes('4.args,')) {
                const match = session.buffer.match(/4\.args,(.*?);/);
                if (!match) return;

                // 解析参数名
                const raw = match[1];
                const names = [];
                let pos = 0;
                while (pos < raw.length) {
                    const dot = raw.indexOf('.', pos);
                    if (dot < 0) break;
                    const len = parseInt(raw.substring(pos, dot), 10);
                    pos = dot + 1;
                    names.push(raw.substring(pos, pos + len));
                    pos += len;
                    if (pos < raw.length && raw[pos] === ',') pos++;
                }

                // 发送握手指令
                const w = session.params.width || session.width || '1024';
                const h = session.params.height || session.height || '768';
                session.sizeCmd = `4.size,${w.length}.${w},${h.length}.${h},2.96;`;
                session.guacdSocket.write(session.sizeCmd);
                session.guacdSocket.write('5.audio;');
                session.guacdSocket.write('5.video;');
                session.guacdSocket.write('5.image;');

                // 构建连接参数
                names.unshift('args');
                const vals = names.map(n => {
                    const p = session.params;
                    switch (n) {
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
                session.guacdSocket.write(vals.map(v => v == null ? '0.' : `${v.length}.${v}`).join(',') + ';');
                session.buffer = '';
            }

            // 处理 ready 指令
            if (session.buffer && session.buffer.includes('5.ready,')) {
                session.handshakeComplete = true;
                session.state = 'connected';
                this.broadcastToSession(sessionKey, session.buffer);
                session.buffer = '';
            }
        } else {
            // 使用缓冲区组装完整指令
            session.buffer = (session.buffer || '') + dataStr;
            
            // 查找最后一个分号位置
            const lastSemi = session.buffer.lastIndexOf(';');
            if (lastSemi >= 0) {
                // 提取完整指令并转发
                const complete = session.buffer.substring(0, lastSemi + 1);
                session.buffer = session.buffer.substring(lastSemi + 1);
                
                this.broadcastToSession(sessionKey, complete);
                
                // 存储用于新客户端同步
                session.recentData.push(complete);
                let total = 0;
                for (let i = session.recentData.length - 1; i >= 0; i--) {
                    total += session.recentData[i].length;
                    if (total > 300000) {
                        session.recentData = session.recentData.slice(i + 1);
                        break;
                    }
                }
            }
        }
    }

    handleMessage(clientId, data) {
        const client = this.clients.get(clientId);
        if (!client) return;
        const str = data.toString();

        try {
            const msg = JSON.parse(str);
            if (msg.type === 'request-control') { this.requestControl(clientId); return; }
            if (msg.type === 'release-control') { this.releaseControl(clientId); return; }
            if (msg.type === 'ping') { this.sendToClient(clientId, { type: 'pong' }); return; }
            return;
        } catch (e) {}

        if (client.mode !== 'controller') return;
        const session = this.sessions.get(client.sessionKey);
        if (!session?.guacdSocket) return;
        try { session.guacdSocket.write(str); } catch (e) {}
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
                this.broadcastToSession(client.sessionKey, { type: 'control-status', controllerId: session.controllerId });
            }
            if (session.clients.size === 0) {
                if (session.guacdSocket) session.guacdSocket.destroy();
                this.sessions.delete(client.sessionKey);
            }
        }
        this.clients.delete(clientId);
    }

    requestControl(clientId) {
        const client = this.clients.get(clientId);
        const session = this.sessions.get(client?.sessionKey);
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
        const session = this.sessions.get(client?.sessionKey);
        if (!session || session.controllerId !== clientId) return;
        session.controllerId = null;
        client.mode = 'viewer';
        for (const cid of session.clients) {
            if (cid !== clientId) { session.controllerId = cid; this.clients.get(cid).mode = 'controller'; break; }
        }
        this.broadcastToSession(client.sessionKey, { type: 'control-status', controllerId: session.controllerId });
    }

    broadcastToSession(sessionKey, data) {
        const session = this.sessions.get(sessionKey);
        if (!session) return;
        const msg = typeof data === 'string' ? data : JSON.stringify(data);
        for (const cid of session.clients) {
            const c = this.clients.get(cid);
            if (c?.ws?.readyState === WebSocket.OPEN) {
                try { c.ws.send(msg); } catch (e) {}
            }
        }
    }

    sendToClient(clientId, data) {
        const c = this.clients.get(clientId);
        if (c?.ws?.readyState === WebSocket.OPEN) {
            try { c.ws.send(typeof data === 'string' ? data : JSON.stringify(data)); } catch (e) {}
        }
    }

    notifyClientStatus(clientId) {
        const c = this.clients.get(clientId);
        const s = this.sessions.get(c?.sessionKey);
        if (!s) return;
        this.sendToClient(clientId, {
            type: 'session-status', sessionKey: c.sessionKey,
            mode: c.mode, controllerId: s.controllerId,
            clientCount: s.clients.size, state: s.state
        });
    }

    decryptToken(token) {
        const d = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
        const key = this.clientOptions.crypt?.key;
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key).slice(0, 32), Buffer.from(d.iv, 'base64'));
        let t = decipher.update(Buffer.from(d.value, 'base64'), 'base64', 'utf8');
        t += decipher.final('utf8');
        return JSON.parse(t).connection?.settings || JSON.parse(t);
    }

    generateId() { return crypto.randomBytes(8).toString('hex'); }

    startCleanup() {
        setInterval(() => {
            for (const [k, s] of this.sessions) {
                if (s.clients.size === 0 || Date.now() - s.lastActivity > 300000) {
                    if (s.guacdSocket) s.guacdSocket.destroy();
                    this.sessions.delete(k);
                }
            }
        }, 30000);
    }

    getStats() { return { sessions: this.sessions.size, clients: this.clients.size }; }
}

module.exports = SessionShareServer;
