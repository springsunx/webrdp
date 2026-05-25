/**
 * SessionShareServer - 会话共享服务器
 * 
 * 核心思路：
 * 1. 直接与 guacd 通信（Guacamole 协议）
 * 2. 维护单个 RDP 连接
 * 3. 多个 WebSocket 客户端共享这个连接
 * 4. 只有主控的指令转发给 guacd
 * 5. 画面数据广播给所有客户端
 */

const http = require('http');
const WebSocket = require('ws');
const net = require('net');
const crypto = require('crypto');

class SessionShareServer {
    constructor(httpServer, guacdOptions) {
        this.httpServer = httpServer;
        this.guacdHost = guacdOptions.host || 'localhost';
        this.guacdPort = guacdOptions.port || 4822;
        
        // 会话 Map: sessionKey -> Session
        this.sessions = new Map();
        
        // 客户端 Map: clientId -> ClientInfo
        this.clients = new Map();
        
        // WebSocket 服务器
        this.wss = new WebSocket.Server({ noServer: true });
        
        this.setupWebSocket();
        this.startCleanup();
        
        console.log('[SessionShare] 会话共享服务器已初始化');
    }

    /**
     * 设置 WebSocket 处理
     */
    setupWebSocket() {
        this.httpServer.on('upgrade', (request, socket, head) => {
            const url = new URL(request.url, `http://${request.headers.host}`);
            
            // 只处理 /ws/session 路径
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

    /**
     * 处理 WebSocket 连接
     */
    handleConnection(ws, req) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const clientId = url.searchParams.get('clientId') || this.generateId();
        const token = url.searchParams.get('token');
        const width = url.searchParams.get('width') || '1024';
        const height = url.searchParams.get('height') || '768';

        if (!token) {
            ws.close(4001, 'Missing token');
            return;
        }

        // 解析连接参数
        let connectionParams;
        try {
            connectionParams = this.decryptToken(token);
        } catch (e) {
            console.error('[SessionShare] Token 解密失败:', e.message);
            ws.close(4002, 'Invalid token');
            return;
        }

        // 生成会话标识
        const sessionKey = `${connectionParams.hostname}:${connectionParams.port}:${connectionParams.username}`;
        
        console.log(`[SessionShare] 客户端连接: ${clientId}, 会话: ${sessionKey}`);

        // 创建客户端信息
        const client = {
            id: clientId,
            sessionKey: sessionKey,
            ws: ws,
            mode: 'viewer',
            joinedAt: Date.now()
        };
        this.clients.set(clientId, client);

        // 获取或创建会话
        let session = this.sessions.get(sessionKey);
        if (!session) {
            session = this.createSession(sessionKey, connectionParams, width, height);
        }

        // 添加客户端到会话
        session.clients.add(clientId);

        // 如果没有主控，设置为自动主控模式（第一个客户端自动成为主控）
        if (!session.controllerId) {
            session.controllerId = clientId;
            client.mode = 'controller';
            console.log(`[SessionShare] 客户端 ${clientId} 成为主控`);
        }

        // 如果是主控且 guacd 未连接，建立连接
        if (client.mode === 'controller' && !session.guacdSocket) {
            this.connectToGuacd(sessionKey);
        }

        // 通知客户端状态
        this.notifyClientStatus(clientId);

        // 处理消息
        ws.on('message', (data) => {
            this.handleMessage(clientId, data);
        });

        ws.on('close', () => {
            this.handleDisconnect(clientId);
        });

        ws.on('error', (error) => {
            console.error(`[SessionShare] 客户端错误:`, error.message);
            this.handleDisconnect(clientId);
        });
    }

    /**
     * 创建会话
     */
    createSession(sessionKey, params, width, height) {
        const session = {
            key: sessionKey,
            params: params,
            width: width,
            height: height,
            clients: new Set(),
            controllerId: null,
            guacdSocket: null,
            state: 'pending',
            buffer: '',
            createdAt: Date.now(),
            lastActivity: Date.now()
        };
        this.sessions.set(sessionKey, session);
        console.log(`[SessionShare] 创建会话: ${sessionKey}`);
        return session;
    }

    /**
     * 连接到 guacd
     */
    connectToGuacd(sessionKey) {
        const session = this.sessions.get(sessionKey);
        if (!session || session.guacdSocket) return;

        console.log(`[SessionShare] 连接到 guacd: ${this.guacdHost}:${this.guacdPort}`);

        const socket = new net.Socket();
        socket.setEncoding('utf8');

        socket.on('connect', () => {
            console.log(`[SessionShare] guacd 连接成功`);
            session.guacdSocket = socket;
            session.state = 'connecting';
            session.buffer = '';
            
            // 开始 Guacamole 握手 - 发送 select 指令
            const selectCmd = '7.select,3.rdp;';
            console.log(`[SessionShare] 发送 select 指令: ${selectCmd}`);
            socket.write(selectCmd);
        });

        socket.on('data', (data) => {
            console.log(`[SessionShare] 收到 guacd 数据: ${data.substring(0, 100)}...`);
            this.handleGuacdData(sessionKey, data);
        });

        socket.on('close', () => {
            console.log(`[SessionShare] guacd 连接关闭`);
            session.guacdSocket = null;
            session.state = 'disconnected';
            this.broadcastToSession(sessionKey, { type: 'session-state', state: 'disconnected' });
        });

        socket.on('error', (error) => {
            console.error(`[SessionShare] guacd 错误:`, error.message);
            session.guacdSocket = null;
            this.broadcastToSession(sessionKey, { type: 'error', message: error.message });
        });

        socket.connect(this.guacdPort, this.guacdHost);
    }

    /**
     * 处理 guacd 数据
     */
    handleGuacdData(sessionKey, data) {
        const session = this.sessions.get(sessionKey);
        if (!session) return;

        session.buffer += data;
        session.lastActivity = Date.now();

        console.log(`[SessionShare] 当前缓冲区长度: ${session.buffer.length}`);

        // 解析并处理指令
        while (true) {
            const result = this.parseInstruction(session.buffer);
            if (!result) {
                console.log(`[SessionShare] 无法解析更多指令，剩余缓冲区: ${session.buffer.length}`);
                break;
            }

            console.log(`[SessionShare] 解析到指令: ${result.opcode}, 参数: ${JSON.stringify(result.args)}`);
            session.buffer = result.remaining;
            
            // 处理握手相关的指令
            this.handleHandshake(sessionKey, result.opcode, result.args);
            
            // 广播给所有客户端（除了 args 指令，因为它是内部处理的）
            if (result.opcode !== 'args') {
                const instruction = this.buildInstruction(result.opcode, result.args);
                console.log(`[SessionShare] 广播指令: ${instruction.substring(0, 100)}...`);
                this.broadcastToSession(sessionKey, instruction);
            }
        }
    }

    /**
     * 处理握手
     */
    handleHandshake(sessionKey, opcode, args) {
        const session = this.sessions.get(sessionKey);
        if (!session) return;

        console.log(`[SessionShare] 握手: ${opcode}`);

        switch (opcode) {
            case 'args':
                // guacd 请求连接参数
                this.sendGuacInstruction(session.guacdSocket, '',
                    session.params.hostname,
                    session.params.port || '3389',
                    session.width,
                    session.height,
                    session.params.dpi || '96',
                    session.params['ignore-cert'] || 'true',
                    session.params.username,
                    session.params.password
                );
                break;

            case 'ready':
                session.state = 'connected';
                console.log(`[SessionShare] RDP 连接就绪`);
                this.broadcastToSession(sessionKey, { type: 'session-state', state: 'connected' });
                break;

            case 'error':
                console.error(`[SessionShare] RDP 错误:`, args);
                session.state = 'error';
                this.broadcastToSession(sessionKey, { type: 'error', message: args[0] });
                break;

            case 'disconnect':
                session.state = 'disconnected';
                this.broadcastToSession(sessionKey, { type: 'session-state', state: 'disconnected' });
                break;
        }
    }

    /**
     * 处理客户端消息
     */
    handleMessage(clientId, data) {
        const client = this.clients.get(clientId);
        if (!client) return;

        const dataStr = data.toString();

        // 尝试解析为 JSON（控制消息）
        try {
            const message = JSON.parse(dataStr);
            
            if (message.type === 'request-control') {
                this.requestControl(clientId);
                return;
            }
            
            if (message.type === 'release-control') {
                this.releaseControl(clientId);
                return;
            }
            
            if (message.type === 'ping') {
                this.sendToClient(clientId, { type: 'pong' });
                return;
            }
            
            return;
        } catch (e) {
            // 不是 JSON，是 Guacamole 指令
        }

        // 只有主控可以发送指令到 guacd
        if (client.mode !== 'controller') return;

        const session = this.sessions.get(client.sessionKey);
        if (!session || !session.guacdSocket) return;

        try {
            session.guacdSocket.write(dataStr);
        } catch (e) {
            console.error(`[SessionShare] 转发指令失败:`, e.message);
        }
    }

    /**
     * 处理断开
     */
    handleDisconnect(clientId) {
        const client = this.clients.get(clientId);
        if (!client) return;

        console.log(`[SessionShare] 客户端断开: ${clientId}`);

        const session = this.sessions.get(client.sessionKey);
        if (session) {
            session.clients.delete(clientId);

            // 如果是主控断开
            if (session.controllerId === clientId) {
                session.controllerId = null;
                client.mode = 'viewer';

                // 转移主控权给其他客户端
                if (session.clients.size > 0) {
                    const newControllerId = session.clients.values().next().value;
                    session.controllerId = newControllerId;
                    const newController = this.clients.get(newControllerId);
                    if (newController) {
                        newController.mode = 'controller';
                        console.log(`[SessionShare] 主控权转移给: ${newControllerId}`);
                    }
                }

                this.broadcastToSession(client.sessionKey, {
                    type: 'control-status',
                    controllerId: session.controllerId
                });
            }

            // 如果没有客户端了，关闭 guacd 连接
            if (session.clients.size === 0) {
                this.closeSession(client.sessionKey);
            }
        }

        this.clients.delete(clientId);
    }

    /**
     * 请求主控权
     */
    requestControl(clientId) {
        const client = this.clients.get(clientId);
        if (!client) return;

        const session = this.sessions.get(client.sessionKey);
        if (!session) return;

        // 如果已有主控且不是自己，拒绝
        if (session.controllerId && session.controllerId !== clientId) {
            this.sendToClient(clientId, {
                type: 'control-denied',
                message: '已有其他客户端获得主控权'
            });
            return;
        }

        // 设置为主控
        session.controllerId = clientId;
        client.mode = 'controller';

        // 建立 guacd 连接（如果还没有）
        if (!session.guacdSocket) {
            this.connectToGuacd(client.sessionKey);
        }

        this.broadcastToSession(client.sessionKey, {
            type: 'control-status',
            controllerId: clientId
        });

        console.log(`[SessionShare] 客户端 ${clientId} 获取主控权`);
    }

    /**
     * 释放主控权
     */
    releaseControl(clientId) {
        const client = this.clients.get(clientId);
        if (!client) return;

        const session = this.sessions.get(client.sessionKey);
        if (!session || session.controllerId !== clientId) return;

        session.controllerId = null;
        client.mode = 'viewer';

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

        this.broadcastToSession(client.sessionKey, {
            type: 'control-status',
            controllerId: session.controllerId
        });

        console.log(`[SessionShare] 客户端 ${clientId} 释放主控权`);
    }

    /**
     * 广播数据给会话中的所有客户端
     */
    broadcastToSession(sessionKey, data) {
        const session = this.sessions.get(sessionKey);
        if (!session) return;

        // 如果数据是对象类型（如 JSON 消息），直接发送
        // 如果是字符串类型（Guacamole 指令），也直接发送
        const message = typeof data === 'string' ? data : JSON.stringify(data);

        let sentCount = 0;
        for (const clientId of session.clients) {
            const client = this.clients.get(clientId);
            if (client && client.ws.readyState === WebSocket.OPEN) {
                try {
                    client.ws.send(message);
                    sentCount++;
                } catch (e) {
                    console.error(`[SessionShare] 发送给 ${clientId} 失败:`, e.message);
                }
            }
        }
        
        if (sentCount > 0) {
            console.log(`[SessionShare] 广播给 ${sentCount} 个客户端`);
        }
    }

    /**
     * 发送数据给单个客户端
     */
    sendToClient(clientId, data) {
        const client = this.clients.get(clientId);
        if (client && client.ws.readyState === WebSocket.OPEN) {
            try {
                client.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
            } catch (e) {
                console.error(`[SessionShare] 发送失败:`, e.message);
            }
        }
    }

    /**
     * 通知客户端状态
     */
    notifyClientStatus(clientId) {
        const client = this.clients.get(clientId);
        if (!client) return;

        const session = this.sessions.get(client.sessionKey);
        if (!session) return;

        this.sendToClient(clientId, {
            type: 'session-status',
            sessionKey: client.sessionKey,
            mode: client.mode,
            controllerId: session.controllerId,
            clientCount: session.clients.size,
            state: session.state
        });
    }

    /**
     * 关闭会话
     */
    closeSession(sessionKey) {
        const session = this.sessions.get(sessionKey);
        if (session) {
            if (session.guacdSocket && !session.guacdSocket.destroyed) {
                session.guacdSocket.destroy();
            }
            this.sessions.delete(sessionKey);
            console.log(`[SessionShare] 关闭会话: ${sessionKey}`);
        }
    }

    /**
     * 发送 Guacamole 指令
     */
    sendGuacInstruction(socket, opcode, ...args) {
        if (!socket || socket.destroyed) return;

        let instruction = '';
        if (opcode) {
            instruction = `${opcode.length}.${opcode}`;
        }
        for (const arg of args) {
            instruction += `,${String(arg).length}.${arg}`;
        }
        instruction += ';';

        socket.write(instruction);
    }

    /**
     * 构建指令字符串
     */
    buildInstruction(opcode, args) {
        let instruction = `${opcode.length}.${opcode}`;
        for (const arg of args) {
            instruction += `,${arg.length}.${arg}`;
        }
        instruction += ';';
        return instruction;
    }

    /**
     * 解析下一个指令
     */
    parseInstruction(buffer) {
        if (!buffer || buffer.length === 0) return null;

        let pos = 0;

        try {
            // 读取 opcode 长度
            const opcodeLenEnd = buffer.indexOf('.', pos);
            if (opcodeLenEnd === -1) return null;

            const opcodeLen = parseInt(buffer.substring(pos, opcodeLenEnd), 10);
            pos = opcodeLenEnd + 1;

            if (buffer.length < pos + opcodeLen + 1) return null;

            // 读取 opcode
            const opcode = buffer.substring(pos, pos + opcodeLen);
            pos += opcodeLen;

            // 读取参数
            const args = [];
            while (pos < buffer.length && buffer[pos] === ',') {
                pos++;

                const argLenEnd = buffer.indexOf('.', pos);
                if (argLenEnd === -1) return null;

                const argLen = parseInt(buffer.substring(pos, argLenEnd), 10);
                pos = argLenEnd + 1;

                if (buffer.length < pos + argLen + 1) return null;

                args.push(buffer.substring(pos, pos + argLen));
                pos += argLen;
            }

            if (pos >= buffer.length || buffer[pos] !== ';') return null;
            pos++;

            return { opcode, args, remaining: buffer.substring(pos) };
        } catch (e) {
            return null;
        }
    }

    /**
     * 生成唯一 ID
     */
    generateId() {
        return crypto.randomBytes(8).toString('hex');
    }

    /**
     * 解密 token
     */
    decryptToken(token) {
        // 这里需要与主服务器的加密方式一致
        // 简化处理：假设 token 是 base64 编码的 JSON
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        const data = JSON.parse(decoded);
        return data.connection?.settings || data;
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
                    this.closeSession(key);
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

module.exports = SessionShareServer;
