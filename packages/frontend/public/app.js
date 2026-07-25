class WebRDPLite {
    constructor() {
        this.guacClient = null;
        this.tunnel = null;
        this.keyboard = null;
        this.mouse = null;
        this.connectionStatus = 'disconnected';
        this.connectionParams = {};
        this.role = 'controller';
        this.session = null;
        this.sessionPollTimer = null;
        this.storageKey = 'webrdp-params';
        this.backendUrl = `${window.location.protocol}//${window.location.host}`;

        this.initElements();
        this.initEventListeners();
        this.initialize();
    }

    initElements() {
        this.loginContainer = document.getElementById('login-container');
        this.loginForm = document.getElementById('login-form');
        this.errorMessage = document.getElementById('error-message');
        this.hostInput = document.getElementById('host');
        this.portInput = document.getElementById('port');
        this.userInput = document.getElementById('user');
        this.passwordInput = document.getElementById('password');
        this.widthInput = document.getElementById('width');
        this.heightInput = document.getElementById('height');
        this.rememberCheckbox = document.getElementById('remember');
        this.connectBtn = document.getElementById('connect-btn');

        this.desktopContainer = document.getElementById('desktop-container');
        this.rdpContainer = document.getElementById('rdp-container');
        this.statusElement = document.getElementById('status');
        this.disconnectBtn = document.getElementById('disconnect-btn');
        this.reconnectBtn = document.getElementById('reconnect-btn');
        this.fullscreenBtn = document.getElementById('fullscreen-btn');
        this.backBtn = document.getElementById('back-btn');
        this.rdpDisplay = document.getElementById('rdp-display');
        this.loadingElement = document.getElementById('loading');
        this.footerHost = document.getElementById('footer-host');
        this.footerPort = document.getElementById('footer-port');
        this.footerUser = document.getElementById('footer-user');
        this.footerWidth = document.getElementById('footer-width');
        this.footerHeight = document.getElementById('footer-height');
        this.resizeBtn = document.getElementById('resize-btn');
        this.resolutionControls = document.querySelector('.resolution-controls');

        this.shareBar = document.getElementById('share-bar');
        this.shareLinkInput = document.getElementById('share-link');
        this.copyShareBtn = document.getElementById('copy-share-btn');
        this.endShareBtn = document.getElementById('end-share-btn');
        this.viewerCount = document.getElementById('viewer-count');
        this.viewerBanner = document.getElementById('viewer-banner');
    }

    initEventListeners() {
        this.loginForm.addEventListener('submit', (event) => {
            event.preventDefault();
            this.handleLogin();
        });
        this.disconnectBtn.addEventListener('click', () => this.leaveSession(false));
        this.reconnectBtn.addEventListener('click', () => this.reconnect());
        this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
        this.backBtn.addEventListener('click', () => this.leaveSession(true));
        this.resizeBtn.addEventListener('click', () => this.resizeDisplay());
        this.copyShareBtn.addEventListener('click', () => this.copyShareLink());
        this.endShareBtn.addEventListener('click', () => this.leaveSession(false));
        window.addEventListener('resize', () => this.adjustDisplaySize());
        window.addEventListener('beforeunload', () => this.endOwnedSession(true));
    }

    initialize() {
        const params = new URLSearchParams(window.location.search);
        const roomId = params.get('room');
        const autoSize = this.calculateOptimalResolution();

        if (roomId) {
            this.role = 'viewer';
            this.session = { roomId };
            this.connectionParams = {
                host: '共享会话',
                port: '-',
                user: '只读观看者',
                width: String(autoSize.width),
                height: String(autoSize.height),
            };
            this.setTitle('WebRDP 共享观看');
            this.showDesktop();
            setTimeout(() => this.connect(), 50);
            return;
        }

        this.loadSavedParams();
        this.hostInput.value = params.get('host') || this.hostInput.value;
        this.portInput.value = params.get('port') || this.portInput.value || '3389';
        this.userInput.value = params.get('user') || this.userInput.value;
        this.widthInput.value = params.get('width') || String(autoSize.width);
        this.heightInput.value = params.get('height') || String(autoSize.height);
        this.setTitle(params.get('title') || 'WebRDP');

        if (params.has('password')) {
            params.delete('password');
            const safeUrl = `${window.location.pathname}${params.toString() ? `?${params}` : ''}`;
            window.history.replaceState({}, '', safeUrl);
        }
    }

    getWebSocketUrl() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.host}`;
    }

    calculateOptimalResolution() {
        const width = Math.max(800, Math.floor(Math.min(window.screen.width, 1920) / 8) * 8);
        const height = Math.max(600, Math.floor(Math.min(window.screen.height, 1080) / 8) * 8);
        return { width, height };
    }

    setTitle(title) {
        document.getElementById('page-title').textContent = title;
        document.getElementById('login-title').textContent = title;
        document.getElementById('desktop-title').textContent = title;
    }

    loadSavedParams() {
        try {
            const saved = JSON.parse(localStorage.getItem(this.storageKey) || '{}');
            if (Object.prototype.hasOwnProperty.call(saved, 'password')) {
                delete saved.password;
                localStorage.setItem(this.storageKey, JSON.stringify(saved));
            }
            this.hostInput.value = saved.host || '';
            this.portInput.value = saved.port || '3389';
            this.userInput.value = saved.user || '';
            this.widthInput.value = saved.width || '1024';
            this.heightInput.value = saved.height || '768';
        } catch (error) {
            localStorage.removeItem(this.storageKey);
        }
    }

    saveParams() {
        if (!this.rememberCheckbox.checked) {
            localStorage.removeItem(this.storageKey);
            return;
        }
        localStorage.setItem(this.storageKey, JSON.stringify({
            host: this.hostInput.value.trim(),
            port: this.portInput.value.trim(),
            user: this.userInput.value.trim(),
            width: this.widthInput.value.trim(),
            height: this.heightInput.value.trim(),
        }));
    }

    handleLogin() {
        const host = this.hostInput.value.trim();
        const user = this.userInput.value.trim();
        const password = this.passwordInput.value;
        if (!host || !user || !password) {
            this.showError('请输入主机地址、用户名和密码');
            return;
        }

        this.role = 'controller';
        this.session = null;
        this.connectionParams = {
            host,
            port: this.portInput.value.trim() || '3389',
            user,
            password,
            width: this.widthInput.value.trim() || '1024',
            height: this.heightInput.value.trim() || '768',
        };
        this.saveParams();

        const safeUrl = new URL(window.location.href);
        safeUrl.search = '';
        safeUrl.searchParams.set('host', host);
        safeUrl.searchParams.set('port', this.connectionParams.port);
        safeUrl.searchParams.set('user', user);
        safeUrl.searchParams.set('width', this.connectionParams.width);
        safeUrl.searchParams.set('height', this.connectionParams.height);
        window.history.replaceState({}, '', safeUrl);

        this.showDesktop();
        setTimeout(() => this.connect(), 50);
    }

    showDesktop() {
        this.loginContainer.style.display = 'none';
        this.desktopContainer.style.display = 'flex';
        this.footerHost.textContent = this.connectionParams.host || '-';
        this.footerPort.textContent = this.connectionParams.port || '-';
        this.footerUser.textContent = this.connectionParams.user || '-';
        this.footerWidth.value = this.connectionParams.width;
        this.footerHeight.value = this.connectionParams.height;
        this.shareBar.style.display = this.role === 'controller' ? 'flex' : 'none';
        this.viewerBanner.style.display = this.role === 'viewer' ? 'block' : 'none';
        this.resolutionControls.style.display = this.role === 'controller' ? 'flex' : 'none';
    }

    async connect() {
        if (this.role === 'controller' &&
            (!this.connectionParams.host || !this.connectionParams.user || !this.connectionParams.password)) {
            this.updateStatus('error', '缺少连接参数');
            return;
        }

        this.disconnectTunnel();
        this.updateStatus('connecting', this.role === 'viewer' ? '正在加入共享会话...' : '正在连接...');

        try {
            const token = await this.getToken();
            this.clearDisplay();
            const tunnelUrl = `${this.getWebSocketUrl()}?token=${encodeURIComponent(token)}`;
            this.tunnel = new Guacamole.WebSocketTunnel(tunnelUrl);
            this.tunnel.onerror = (status) => {
                this.updateStatus('error', status.message || '远程隧道错误');
            };

            this.guacClient = new Guacamole.Client(this.tunnel);
            this.guacClient.keepAliveFrequency = 3000;
            const displayElement = this.guacClient.getDisplay().getElement();
            this.rdpDisplay.appendChild(displayElement);

            this.guacClient.onstatechange = (state) => this.handleStateChange(state);
            this.guacClient.onerror = (status) => {
                this.updateStatus('error', status.message || '远程连接错误');
            };
            if (this.role === 'controller') {
                this.guacClient.onclipboard = (stream, mimetype) => this.handleClipboard(stream, mimetype);
            }

            this.guacClient.connect('');
            if (this.role === 'controller') {
                this.setupInputListeners();
            } else {
                displayElement.style.cursor = 'default';
            }
            this.startSessionPolling();
        } catch (error) {
            this.updateStatus('error', error.message || '连接失败');
        }
    }

    async getToken() {
        if (this.role === 'viewer') {
            const data = await this.fetchJson(`/api/sessions/${encodeURIComponent(this.session.roomId)}/join`, {
                method: 'POST',
                body: JSON.stringify({
                    width: Number(this.connectionParams.width),
                    height: Number(this.connectionParams.height),
                }),
            });
            this.session.participantId = data.participantId;
            return data.token;
        }

        const data = await this.fetchJson('/api/sessions', {
            method: 'POST',
            body: JSON.stringify({
                host: this.connectionParams.host,
                port: Number(this.connectionParams.port),
                user: this.connectionParams.user,
                password: this.connectionParams.password,
                width: Number(this.connectionParams.width),
                height: Number(this.connectionParams.height),
            }),
        });
        this.session = {
            roomId: data.roomId,
            ownerSecret: data.ownerSecret,
            expiresAt: data.expiresAt,
        };
        const shareUrl = new URL(window.location.origin + window.location.pathname);
        shareUrl.searchParams.set('room', data.roomId);
        this.shareLinkInput.value = shareUrl.toString();
        this.viewerCount.textContent = '0 位观看者';
        return data.token;
    }

    async fetchJson(path, options = {}) {
        const response = await fetch(`${this.backendUrl}${path}`, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        });
        const data = response.status === 204 ? null : await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || `请求失败 (${response.status})`);
        return data;
    }

    handleStateChange(state) {
        const states = {
            0: ['disconnected', '空闲'],
            1: ['connecting', '正在连接...'],
            2: ['connecting', '等待远程桌面...'],
            3: ['connected', this.role === 'viewer' ? '只读观看中' : '已连接'],
            4: ['disconnected', '正在断开...'],
            5: ['disconnected', '已断开'],
        };
        const [status, message] = states[state] || ['error', '未知状态'];
        this.updateStatus(status, message);
        if (state === 3) this.adjustDisplaySize();
    }

    updateStatus(status, message) {
        this.connectionStatus = status;
        this.statusElement.textContent = message;
        this.statusElement.className = `status ${status}`;
        this.connectBtn.disabled = status === 'connected' || status === 'connecting';
        this.disconnectBtn.disabled = status !== 'connected';
        this.loadingElement.style.display = status === 'connecting' ? 'flex' : 'none';
    }

    setupInputListeners() {
        if (!this.guacClient || this.role !== 'controller') return;
        const displayElement = this.guacClient.getDisplay().getElement();
        displayElement.tabIndex = 0;
        const useTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        this.mouse = useTouch
            ? new Guacamole.Mouse.Touchscreen(displayElement)
            : new Guacamole.Mouse(displayElement);
        this.mouse.onmousedown = this.mouse.onmouseup = this.mouse.onmousemove = (state) => {
            if (this.guacClient && this.role === 'controller') this.guacClient.sendMouseState(state);
        };
        this.keyboard = new Guacamole.Keyboard(displayElement);
        this.keyboard.onkeydown = (keysym) => {
            if (this.guacClient && this.role === 'controller') this.guacClient.sendKeyEvent(1, keysym);
        };
        this.keyboard.onkeyup = (keysym) => {
            if (this.guacClient && this.role === 'controller') this.guacClient.sendKeyEvent(0, keysym);
        };
        displayElement.focus();
    }

    handleClipboard(stream, mimetype) {
        if (this.role !== 'controller' || mimetype !== 'text/plain') return;
        const reader = new Guacamole.StringReader(stream);
        let text = '';
        reader.ontext = (chunk) => { text += chunk; };
        reader.onend = () => navigator.clipboard.writeText(text).catch(() => {});
    }

    adjustDisplaySize() {
        if (!this.guacClient) return;
        const width = Number(this.connectionParams.width) || 1024;
        const height = Number(this.connectionParams.height) || 768;
        const maxWidth = Math.max(1, this.rdpContainer.clientWidth - 16);
        const maxHeight = Math.max(1, this.rdpContainer.clientHeight - 16);
        const scale = Math.min(maxWidth / width, maxHeight / height, 1);
        this.guacClient.getDisplay().scale(scale);
    }

    resizeDisplay() {
        if (!this.guacClient || this.role !== 'controller') return;
        const width = Math.max(800, Number(this.footerWidth.value) || 1024);
        const height = Math.max(600, Number(this.footerHeight.value) || 768);
        this.connectionParams.width = String(width);
        this.connectionParams.height = String(height);
        this.guacClient.sendSize(width, height);
        this.adjustDisplaySize();
    }

    startSessionPolling() {
        clearInterval(this.sessionPollTimer);
        if (!this.session?.roomId) return;
        const poll = async () => {
            try {
                const data = await this.fetchJson(`/api/sessions/${encodeURIComponent(this.session.roomId)}`);
                if (this.role === 'controller') {
                    this.viewerCount.textContent = `${data.viewerCount} / ${data.maxViewers} 位观看者`;
                }
            } catch (error) {
                clearInterval(this.sessionPollTimer);
                if (this.role === 'viewer' && this.connectionStatus === 'connected') {
                    this.disconnectTunnel();
                    this.updateStatus('error', '共享会话已结束');
                }
            }
        };
        this.sessionPollTimer = setInterval(poll, 3000);
        poll();
    }

    async copyShareLink() {
        if (!this.shareLinkInput.value) return;
        await navigator.clipboard.writeText(this.shareLinkInput.value);
        const original = this.copyShareBtn.textContent;
        this.copyShareBtn.textContent = '已复制';
        setTimeout(() => { this.copyShareBtn.textContent = original; }, 1500);
    }

    async endOwnedSession(keepalive = false) {
        if (this.role !== 'controller' || !this.session?.roomId || !this.session.ownerSecret) return;
        const { roomId, ownerSecret } = this.session;
        this.session = null;
        try {
            await fetch(`${this.backendUrl}/api/sessions/${encodeURIComponent(roomId)}`, {
                method: 'DELETE',
                headers: { 'x-owner-secret': ownerSecret },
                keepalive,
            });
        } catch (error) {
            console.warn('Failed to end shared session', error);
        }
    }

    async leaveSession(showLogin) {
        await this.endOwnedSession();
        this.disconnectTunnel();
        if (showLogin) {
            this.role = 'controller';
            this.session = null;
            this.loginContainer.style.display = 'flex';
            this.desktopContainer.style.display = 'none';
            window.history.replaceState({}, '', window.location.pathname);
        }
    }

    async reconnect() {
        if (this.role === 'controller') await this.endOwnedSession();
        this.disconnectTunnel();
        setTimeout(() => this.connect(), 100);
    }

    disconnectTunnel() {
        clearInterval(this.sessionPollTimer);
        this.sessionPollTimer = null;
        if (this.keyboard) {
            this.keyboard.onkeydown = null;
            this.keyboard.onkeyup = null;
            this.keyboard = null;
        }
        if (this.mouse) {
            this.mouse.onmousedown = null;
            this.mouse.onmouseup = null;
            this.mouse.onmousemove = null;
            this.mouse = null;
        }
        if (this.guacClient) {
            try { this.guacClient.disconnect(); } catch (error) {}
            this.guacClient = null;
        }
        this.tunnel = null;
        this.clearDisplay();
        this.updateStatus('disconnected', '已断开');
    }

    clearDisplay() {
        for (const child of Array.from(this.rdpDisplay.children)) {
            if (child !== this.loadingElement) child.remove();
        }
        if (!this.loadingElement.isConnected) this.rdpDisplay.appendChild(this.loadingElement);
    }

    showError(message) {
        this.errorMessage.textContent = message;
        this.errorMessage.style.display = 'block';
        setTimeout(() => { this.errorMessage.style.display = 'none'; }, 5000);
    }

    toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => {});
        } else {
            document.exitFullscreen();
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.webRdpLite = new WebRDPLite();
});