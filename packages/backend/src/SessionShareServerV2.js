/**
 * SessionShareServerV2 - 基于 GuacamoleLite 的会话共享
 * 
 * 核心思路：
 * 1. 使用 GuacamoleLite 处理 RDP 连接（保持兼容性）
 * 2. 添加会话管理功能
 * 3. 支持主控/观看者模式
 */

const WebSocket = require('ws');

class SessionShareServerV2 {
    constructor(httpServer, guacdOptions, clientOptions = {}) {
        this.httpServer = httpServer;
        this.guacdOptions = guacdOptions;
        this.clientOptions = clientOptions;
        
        // 会话 Map: sessionKey -> Session
        this.sessions = new Map();
        
        // 客户端 Map: clientId -> ClientInfo
        this.clients = new Map();
        
        // WebSocket 服务器（用于会话控制）
        this.controlWss = new WebSocket.Server({ 
            noServer: true,
            perMessageDeflate: false
        });
        
        this.setupControlWebSocket();
        this.startCleanup();
        
        console.log('[SessionShareV2] 会话共享服务器已初始化');
    }

    /**
     * 设置控制 WebSocket
     */
    setupControlWebSocket() {
        this.httpServer.on('upgrade', (request, socket, head) => {
            const url = new URL(request.url, `http://${request.headers.host}`);
            
            // 只处理 /ws/control 路径
            if (url.pathname !== '/ws/control') {
                return;
            }
            
            this.controlWss.handleUpgrade(request, socket, head, (ws) => {
                this.controlWss.emit('connection', ws, request);
            });
        });

        this.controlWss.on('connection', (ws, req) => {
            this.handleControlConnection(ws, req);
        });
    }

    /**
     * 处理控制 WebSocket 连接
     */
    handleControlConnection(ws, req) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const clientId = url.searchParams.get('clientId') || this.generateId();
        const sessionKey = url.searchParams.get('session');

        if (!sessionKey) {
            ws.close(4001, 'Missing session parameter');
            return;
        }

        console.log(`[SessionShareV2] 控制连接: ${clientId}, 会话: ${sessionKey}`);

        // 获取或创建会话
        let session = this.sessions.get(sessionKey);
        if (!session) {
            session = {
                key: sessionKey,
                clients: new Set(),
                controllerId: null,
                state: 'pending',
                lastActivity: Date.now()
            };
            this.sessions.set(sessionKey, session);
        }

        // 添加客户端
        session.clients.add(clientId);
        
        const clientInfo = {
            id: clientId,
            sessionKey: sessionKey,
            ws: ws,
            mode: 'viewer',
            joinedAt: Date.now()
        };
        this.clients.set(clientId, clientInfo);

        // 如果没有主控，设置为自动主控模式
        if (!session.controllerId) {
            session.controllerId = clientId;
            clientInfo.mode = 'controller';
        }

        // 通知客户端状态
        this.sendToClient(clientId, {
            type: 'session-status',
            sessionKey: sessionKey,
            mode: clientInfo.mode,
            controllerId: session.controllerId,
            clientCount: session.clients.size
        });

        // 处理消息
        ws.on('message', (data) => {
            this.handleControlMessage(clientId, data);
        });

        ws.on('close', () => {
            this.handleControlDisconnect(clientId);
        });

        ws.on('error', (error) => {
            console.error(`[SessionShareV2] 控制连接错误:`, error.message);
            this.handleControlDisconnect(clientId);
        });
    }

    /**
     * 处理控制消息
     */
    handleControlMessage(clientId, data) {
        const clientInfo = this.clients.get(clientId);
        if (!clientInfo) return;

        try {
            const message = JSON.parse(data.toString());
            
            if (message.type === 'request-control') {
                this.requestControl(clientId);
            } else if (message.type === 'release-control') {
                this.releaseControl(clientId);
            } else if (message.type === 'ping') {
                this.sendToClient(clientId, { type: 'pong' });
            }
        } catch (e) {
            console.error(`[SessionShareV2] 解析消息失败:`, e.message);
        }
    }

    /**
     * 处理控制连接断开
     */
    handleControlDisconnect(clientId) {
        const clientInfo = this.clients.get(clientId);
        if (!clientInfo) return;

        const session = this.sessions.get(clientInfo.sessionKey);
        if (session) {
            session.clients.delete(clientId);
            
            // 如果是主控断开
            if (session.controllerId === clientId) {
                session.controllerId = null;
                
                // 转移主控权
                if (session.clients.size > 0) {
                    const newControllerId = session.clients.values().next().value;
                    session.controllerId = newControllerId;
                    const newController = this.clients.get(newControllerId);
                    if (newController) {
                        newController.mode = 'controller';
                    }
                }
                
                // 广播主控变更
                this.broadcastToSession(clientInfo.sessionKey, {
                    type: 'control-status',
                    controllerId: session.controllerId
                });
            }
            
            // 如果没有客户端了，清理会话
            if (session.clients.size === 0) {
                this.sessions.delete(clientInfo.sessionKey);
            }
        }

        this.clients.delete(clientId);
        console.log(`[SessionShareV2] 控制连接断开: ${clientId}`);
    }

    /**
     * 请求主控权
     */
    requestControl(clientId) {
        const clientInfo = this.clients.get(clientId);
        if (!clientInfo) return false;

        const session = this.sessions.get(clientInfo.sessionKey);
        if (!session) return false;

        // 如果已有主控且不是自己，拒绝
        if (session.controllerId && session.controllerId !== clientId) {
            this.sendToClient(clientId, {
                type: 'control-denied',
                message: '已有其他客户端获得主控权'
            });
            return false;
        }

        // 设置为主控
        session.controllerId = clientId;
        clientInfo.mode = 'controller';

        // 广播主控变更
        this.broadcastToSession(clientInfo.sessionKey, {
            type: 'control-status',
            controllerId: clientId
        });

        console.log(`[SessionShareV2] 客户端 ${clientId} 获取主控权`);
        return true;
    }

    /**
     * 释放主控权
     */
    releaseControl(clientId) {
        const clientInfo = this.clients.get(clientId);
        if (!clientInfo) return;

        const session = this.sessions.get(clientInfo.sessionKey);
        if (!session || session.controllerId !== clientId) return;

        session.controllerId = null;
        clientInfo.mode = 'viewer';

        // 转移主控权
        if (session.clients.size > 0) {
            for (const cid of session.clients) {
                if (cid !== clientId) {
                    session.controllerId = cid;
                    const otherClient = this.clients.get(cid);
                    if (otherClient) {
                        otherClient.mode = 'controller';
                    }
                    break;
                }
            }
        }

        // 广播主控变更
        this.broadcastToSession(clientInfo.sessionKey, {
            type: 'control-status',
            controllerId: session.controllerId
        });

        console.log(`[SessionShareV2] 客户端 ${clientId} 释放主控权`);
    }

    /**
     * 检查是否是主控
     */
    isController(clientId) {
        const clientInfo = this.clients.get(clientId);
        if (!clientInfo) return false;
        
        const session = this.sessions.get(clientInfo.sessionKey);
        return session && session.controllerId === clientId;
    }

    /**
     * 广播数据给会话中的所有客户端
     */
    broadcastToSession(sessionKey, data) {
        const session = this.sessions.get(sessionKey);
        if (!session) return;

        const message = typeof data === 'string' ? data : JSON.stringify(data);

        for (const clientId of session.clients) {
            const clientInfo = this.clients.get(clientId);
            if (clientInfo && clientInfo.ws.readyState === WebSocket.OPEN) {
                try {
                    clientInfo.ws.send(message);
                } catch (e) {
                    console.error(`[SessionShareV2] 发送失败:`, e.message);
                }
            }
        }
    }

    /**
     * 发送数据给单个客户端
     */
    sendToClient(clientId, data) {
        const clientInfo = this.clients.get(clientId);
        if (clientInfo && clientInfo.ws.readyState === WebSocket.OPEN) {
            try {
                clientInfo.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
            } catch (e) {
                console.error(`[SessionShareV2] 发送失败:`, e.message);
            }
        }
    }

    /**
     * 生成唯一 ID
     */
    generateId() {
        return 'client_' + Math.random().toString(36).substr(2, 12);
    }

    /**
     * 清理过期会话
     */
    startCleanup() {
        setInterval(() => {
            const now = Date.now();
            const timeout = 5 * 60 * 1000; // 5分钟

            for (const [key, session] of this.sessions) {
                if (session.clients.size === 0 || (now - session.lastActivity > timeout)) {
                    this.sessions.delete(key);
                    console.log(`[SessionShareV2] 清理会话: ${key}`);
                }
            }
        }, 30000);
    }

    /**
     * 获取统计信息
     */
    getStats() {
        return {
            sessions: this.sessions.size,
            clients: this.clients.size
        };
    }
}

module.exports = SessionShareServerV2;
