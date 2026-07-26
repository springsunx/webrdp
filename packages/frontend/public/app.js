class WebRDPLite {
    constructor() {
        this.guacClient = null;
        this.tunnel = null;
        this.keyboard = null;
        this.mouse = null;
        this.connectionStatus = 'disconnected';
        this.connectionParams = {};
        this.role = 'pending';
        this.hasControl = false;
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
        this.touchHint = document.getElementById('touch-hint');
        this.scrollHint = document.getElementById('scroll-hint');
        this.dualFingerCleanup = null;
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

        this.endShareBtn = document.getElementById('end-share-btn');
        this.viewerCount = document.getElementById('viewer-count');
        this.permissionBar = document.getElementById('permission-bar');
        this.controlState = document.getElementById('control-state');
        this.takeControlBtn = document.getElementById('take-control-btn');
        this.releaseControlBtn = document.getElementById('release-control-btn');
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
        this.endShareBtn.addEventListener('click', () => this.leaveSession(false));
        this.takeControlBtn.addEventListener('click', () => this.takeControl());
        this.releaseControlBtn.addEventListener('click', () => this.releaseControl());
        window.addEventListener('resize', () => this.adjustDisplaySize());
        window.addEventListener('beforeunload', () => this.handleBeforeUnload());
    }

    initialize() {
        const queryParams = new URLSearchParams(window.location.search);
        const fragmentParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
        const roomId = queryParams.get('room');
        const autoSize = this.calculateOptimalResolution();

        if (roomId) {
            this.role = 'viewer';
            this.session = { roomId };
            this.connectionParams = {
                host: '共享会话',
                port: '-',
                user: '协作参与者',
                width: String(autoSize.width),
                height: String(autoSize.height),
            };
            this.setTitle('WebRDP 协作会话');
            this.showDesktop();
            setTimeout(() => this.connect(), 50);
            return;
        }

        this.loadSavedParams();
        const source = fragmentParams.has('host') ? fragmentParams : queryParams;
        const host = source.get('host') || this.hostInput.value;
        const port = source.get('port') || this.portInput.value || '3389';
        const user = source.get('user') || this.userInput.value;
        const password = source.get('password') || '';
        const width = source.get('width') || String(autoSize.width);
        const height = source.get('height') || String(autoSize.height);
        const title = source.get('title') || 'WebRDP';

        this.hostInput.value = host;
        this.portInput.value = port;
        this.userInput.value = user;
        this.widthInput.value = width;
        this.heightInput.value = height;
        this.setTitle(title);

        if (host && user && password) {
            this.connectionParams = { host, port, user, password, width, height, title };
            this.clearSensitiveLocation();
            this.showDesktop();
            setTimeout(() => this.connect(), 50);
            return;
        }

        if (queryParams.has('password') || window.location.hash) this.clearSensitiveLocation();
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

        this.role = 'pending';
        this.hasControl = false;
        this.session = null;
        this.connectionParams = {
            host,
            port: this.portInput.value.trim() || '3389',
            user,
            password,
            width: this.widthInput.value.trim() || '1024',
            height: this.heightInput.value.trim() || '768',
            title: document.getElementById('page-title').textContent || 'WebRDP',
        };
        this.passwordInput.value = '';
        this.saveParams();
        this.clearSensitiveLocation();
        this.showDesktop();
        setTimeout(() => this.connect(), 50);
    }

    clearSensitiveLocation() {
        const safeUrl = new URL(window.location.href);
        safeUrl.searchParams.delete('password');
        safeUrl.hash = '';
        window.history.replaceState({}, '', safeUrl);
    }

    showDesktop() {
        this.loginContainer.style.display = 'none';
        this.desktopContainer.style.display = 'flex';
        this.footerHost.textContent = this.connectionParams.host || '-';
        this.footerPort.textContent = this.connectionParams.port || '-';
        this.footerUser.textContent = this.connectionParams.user || '-';
        this.footerWidth.value = this.connectionParams.width;
        this.footerHeight.value = this.connectionParams.height;
        this.permissionBar.style.display = 'flex';
        this.applyPermissionState();
    }

    async connect() {
        const credentialEntry = Boolean(
            this.connectionParams.host && this.connectionParams.user && this.connectionParams.password,
        );
        if (!credentialEntry && !this.session?.roomId) {
            this.updateStatus('error', '缺少连接参数');
            return;
        }

        this.disconnectTunnel();
        this.updateStatus('connecting', credentialEntry ? '正在加入或创建协作会话...' : '正在加入共享会话...');

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
            this.guacClient.onclipboard = (stream, mimetype) => this.handleClipboard(stream, mimetype);

            this.guacClient.connect('');
            this.setupInputListeners();
            this.applyPermissionState();
            this.startSessionPolling();
        } catch (error) {
            this.updateStatus('error', error.message || '连接失败');
        }
    }

    async getToken() {
        let data;
        const credentialEntry = Boolean(this.connectionParams.password);
        if (!credentialEntry && this.session?.roomId) {
            data = await this.fetchJson(`/api/sessions/${encodeURIComponent(this.session.roomId)}/join`, {
                method: 'POST',
                body: JSON.stringify({
                    width: Number(this.connectionParams.width),
                    height: Number(this.connectionParams.height),
                }),
            });
        } else {
            data = await this.openCredentialSession();
        }

        this.role = data.role;
        this.hasControl = Boolean(data.hasControl);
        this.session = {
            roomId: data.roomId,
            participantId: data.participantId,
            participantSecret: data.participantSecret,
            ownerSecret: data.ownerSecret,
            expiresAt: data.expiresAt,
        };
        this.viewerCount.textContent = '1 人在线';
        this.showDesktop();
        return data.token;
    }

    async openCredentialSession() {
        const body = JSON.stringify({
            host: this.connectionParams.host,
            port: Number(this.connectionParams.port),
            user: this.connectionParams.user,
            password: this.connectionParams.password,
            width: Number(this.connectionParams.width),
            height: Number(this.connectionParams.height),
        });
        for (let attempt = 0; attempt < 40; attempt += 1) {
            try {
                return await this.fetchJson('/api/sessions', { method: 'POST', body });
            } catch (error) {
                if (error.status !== 409 || !error.data?.retryAfterMs) throw error;
                await new Promise((resolve) => setTimeout(resolve, error.data.retryAfterMs));
            }
        }
        throw new Error('主连接建立超时，请重试');
    }

    async fetchJson(path, options = {}) {
        const response = await fetch(`${this.backendUrl}${path}`, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        });
        const data = response.status === 204 ? null : await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(data?.error || `请求失败 (${response.status})`);
            error.status = response.status;
            error.data = data;
            throw error;
        }
        return data;
    }

    identityHeaders() {
        if (!this.session?.participantId || !this.session?.participantSecret) return {};
        return {
            'x-participant-id': this.session.participantId,
            'x-participant-secret': this.session.participantSecret,
        };
    }

    handleStateChange(state) {
        const connectedMessage = this.hasControl ? '已连接 · 可操作' : '已连接 · 观看中';
        const states = {
            0: ['disconnected', '空闲'],
            1: ['connecting', '正在连接...'],
            2: ['connecting', '等待远程桌面...'],
            3: ['connected', connectedMessage],
            4: ['disconnected', '正在断开...'],
            5: ['disconnected', '已断开'],
        };
        const [status, message] = states[state] || ['error', '未知状态'];
        this.updateStatus(status, message);
        if (state === 3) {
            this.adjustDisplaySize();
            this.showTouchHint();
        }
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
        if (!this.guacClient || this.keyboard || this.mouse) return;
        const display = this.guacClient.getDisplay();
        const displayElement = display.getElement();
        displayElement.tabIndex = 0;
        display.showCursor(true);

        const cursorElement = display.getCursorLayer()?.getElement();
        if (cursorElement) cursorElement.style.zIndex = '1000';

        if (this.shouldUseTouchscreen()) {
            this.mouse = new Guacamole.Mouse.Touchscreen(displayElement);
        } else if (this.isMobile()) {
            this.mouse = new Guacamole.Mouse.Touchpad(displayElement);
            this.setupDualFingerScroll(displayElement);
        } else {
            this.mouse = new Guacamole.Mouse(displayElement);
        }

        this.mouse.onmousedown = this.mouse.onmouseup = this.mouse.onmousemove = (state) => {
            if (this.guacClient && this.hasControl) this.guacClient.sendMouseState(state);
        };
        this.keyboard = new Guacamole.Keyboard(displayElement);
        this.keyboard.onkeydown = (keysym) => {
            if (this.guacClient && this.hasControl) this.guacClient.sendKeyEvent(1, keysym);
        };
        this.keyboard.onkeyup = (keysym) => {
            if (this.guacClient && this.hasControl) this.guacClient.sendKeyEvent(0, keysym);
        };
        displayElement.addEventListener('keydown', (event) => {
            if (event.altKey || event.ctrlKey || event.metaKey) {
                event.preventDefault();
                event.stopPropagation();
            }
        }, true);
        displayElement.addEventListener('keyup', (event) => {
            if (event.altKey || event.ctrlKey || event.metaKey) {
                event.preventDefault();
                event.stopPropagation();
            }
        }, true);
        if (this.hasControl) displayElement.focus();
    }

    handleClipboard(stream, mimetype) {
        if (!this.hasControl || mimetype !== 'text/plain') return;
        const reader = new Guacamole.StringReader(stream);
        let text = '';
        reader.ontext = (chunk) => { text += chunk; };
        reader.onend = () => navigator.clipboard.writeText(text).catch(() => {});
    }

    applyPermissionState(data = null) {
        if (data) this.hasControl = Boolean(data.hasControl);
        const controlOwner = data?.controlOwner || (this.hasControl && this.role === 'controller' ? 'primary' : null);
        const isPrimary = this.role === 'controller';

        this.takeControlBtn.textContent = isPrimary ? '抢回控制权' : '接管操作';
        this.takeControlBtn.style.display = this.role !== 'pending' && !this.hasControl ? 'inline-block' : 'none';
        this.releaseControlBtn.style.display = !isPrimary && this.hasControl ? 'inline-block' : 'none';
        this.endShareBtn.style.display = isPrimary ? 'inline-block' : 'none';
        this.resolutionControls.style.display = this.hasControl ? 'flex' : 'none';
        this.permissionBar.classList.toggle('has-control', this.hasControl);

        if (this.role === 'pending') {
            this.controlState.textContent = '正在分配协作身份...';
        } else if (isPrimary && this.hasControl) {
            this.controlState.textContent = '主用户 · 当前可操作';
        } else if (isPrimary) {
            this.controlState.textContent = '临时用户正在操作 · 主用户输入已锁定';
        } else if (this.hasControl) {
            this.controlState.textContent = '临时控制中 · 结束后将自动归还主用户';
        } else if (controlOwner === 'participant') {
            this.controlState.textContent = '其他参与者正在操作 · 当前为观看模式';
        } else {
            this.controlState.textContent = '主用户正在操作 · 当前为观看模式';
        }

        const displayElement = this.guacClient?.getDisplay().getElement();
        if (displayElement) {
            displayElement.style.cursor = this.hasControl ? 'none' : 'not-allowed';
            if (this.hasControl) displayElement.focus();
        }
        if (this.connectionStatus === 'connected') {
            this.updateStatus('connected', this.hasControl ? '已连接 · 可操作' : '已连接 · 观看中');
        }
    }

    isMobile() {
        return window.innerWidth <= 768;
    }

    isTouchDevice() {
        return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    }

    shouldUseTouchscreen() {
        const isLargeScreen = window.innerWidth > 768;
        const isDesktopMode = window.outerWidth > window.innerWidth;
        return this.isTouchDevice() && (isLargeScreen || isDesktopMode);
    }

    showScrollHint(visible) {
        if (!this.scrollHint) return;
        this.scrollHint.classList.toggle('visible', visible);
        clearTimeout(this.scrollHintTimer);
        if (visible) {
            this.scrollHintTimer = setTimeout(() => {
                this.scrollHint.classList.remove('visible');
            }, 3000);
        }
    }

    showTouchHint() {
        if (!this.touchHint || !this.isMobile() || !this.hasControl) return;
        this.touchHint.classList.add('visible');
        clearTimeout(this.touchHintTimer);
        this.touchHintTimer = setTimeout(() => {
            this.touchHint.classList.remove('visible');
        }, 5000);
    }

    setupDualFingerScroll(displayElement) {
        this.dualFingerCleanup?.();
        const container = this.rdpContainer;
        let lastTouchX = 0;
        let lastTouchY = 0;
        const onTouchStart = (event) => {
            if (event.touches.length === 2) {
                lastTouchX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
                lastTouchY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
            }
        };
        const onTouchMove = (event) => {
            if (event.touches.length !== 2) return;
            const currentX = (event.touches[0].clientX + event.touches[1].clientX) / 2;
            const currentY = (event.touches[0].clientY + event.touches[1].clientY) / 2;
            container.scrollLeft -= currentX - lastTouchX;
            container.scrollTop -= currentY - lastTouchY;
            lastTouchX = currentX;
            lastTouchY = currentY;
        };
        displayElement.addEventListener('touchstart', onTouchStart, { passive: true });
        displayElement.addEventListener('touchmove', onTouchMove, { passive: true });
        this.dualFingerCleanup = () => {
            displayElement.removeEventListener('touchstart', onTouchStart);
            displayElement.removeEventListener('touchmove', onTouchMove);
            this.dualFingerCleanup = null;
        };
    }

    adjustDisplaySize() {
        if (!this.guacClient || this.connectionStatus !== 'connected') return;
        const container = this.rdpContainer;
        const maxWidth = Math.max(1, container.clientWidth - 40);
        const maxHeight = Math.max(1, container.clientHeight - 40);
        const width = Number(this.connectionParams.width) || 1024;
        const height = Number(this.connectionParams.height) || 768;
        const mobile = this.isMobile();
        let scale;

        if (mobile) {
            scale = Math.min(maxHeight / height, 1);
            if (width * scale <= maxWidth) {
                scale = Math.min(maxWidth / width, maxHeight / height, 1);
            }
        } else {
            scale = Math.min(maxWidth / width, maxHeight / height, 1);
        }

        const displayElement = this.guacClient.getDisplay().getElement();
        displayElement.style.width = `${width * scale}px`;
        displayElement.style.height = `${height * scale}px`;

        if (mobile && width * scale > maxWidth) {
            container.style.justifyContent = 'flex-start';
            this.showScrollHint(true);
        } else {
            container.style.justifyContent = 'center';
            this.showScrollHint(false);
        }
        if (this.hasControl) this.guacClient.sendSize(width, height);
    }

    resizeDisplay() {
        if (!this.guacClient || !this.hasControl) return;
        const width = Math.max(800, Number(this.footerWidth.value) || 1024);
        const height = Math.max(600, Number(this.footerHeight.value) || 768);
        this.connectionParams.width = String(width);
        this.connectionParams.height = String(height);
        this.adjustDisplaySize();
    }

    startSessionPolling() {
        clearInterval(this.sessionPollTimer);
        if (!this.session?.roomId) return;
        const poll = async () => {
            try {
                const data = await this.fetchJson(
                    `/api/sessions/${encodeURIComponent(this.session.roomId)}`,
                    { headers: this.identityHeaders() },
                );
                this.applyPermissionState(data);
                this.viewerCount.textContent = `${data.viewerCount + 1} 人在线`;
            } catch (error) {
                clearInterval(this.sessionPollTimer);
                if (this.connectionStatus === 'connected') {
                    this.disconnectTunnel();
                    this.updateStatus('error', '协作会话已结束或身份已失效');
                }
            }
        };
        this.sessionPollTimer = setInterval(poll, 1000);
        poll();
    }

    async takeControl() {
        if (!this.session?.roomId || this.hasControl) return;
        this.takeControlBtn.disabled = true;
        try {
            const data = await this.fetchJson(
                `/api/sessions/${encodeURIComponent(this.session.roomId)}/control`,
                { method: 'POST', headers: this.identityHeaders(), body: '{}' },
            );
            this.applyPermissionState(data);
            this.showTouchHint();
        } catch (error) {
            this.showError(error.message);
        } finally {
            this.takeControlBtn.disabled = false;
        }
    }

    async releaseControl(keepalive = false) {
        if (this.role === 'controller' || !this.session?.roomId || !this.hasControl) return;
        try {
            const response = await fetch(
                `${this.backendUrl}/api/sessions/${encodeURIComponent(this.session.roomId)}/control`,
                { method: 'DELETE', headers: this.identityHeaders(), keepalive },
            );
            if (!keepalive && response.ok) this.applyPermissionState(await response.json());
        } catch (error) {
            if (!keepalive) this.showError(error.message || '归还控制权失败');
        }
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
            console.warn('Failed to end collaborative session', error);
        }
    }

    handleBeforeUnload() {
        if (this.role === 'controller') this.endOwnedSession(true);
        else this.releaseControl(true);
    }

    async leaveSession(showLogin) {
        if (this.role === 'controller') await this.endOwnedSession();
        else await this.releaseControl();
        this.disconnectTunnel();
        if (showLogin) {
            this.role = 'pending';
            this.hasControl = false;
            this.session = null;
            this.connectionParams.password = '';
            this.loginContainer.style.display = 'flex';
            this.desktopContainer.style.display = 'none';
            window.history.replaceState({}, '', window.location.pathname);
        }
    }

    async reconnect() {
        if (this.role === 'controller') await this.endOwnedSession();
        else await this.releaseControl();
        this.disconnectTunnel();
        this.role = 'pending';
        this.hasControl = false;
        setTimeout(() => this.connect(), 100);
    }

    disconnectTunnel() {
        clearInterval(this.sessionPollTimer);
        this.sessionPollTimer = null;
        this.dualFingerCleanup?.();
        clearTimeout(this.scrollHintTimer);
        clearTimeout(this.touchHintTimer);
        this.scrollHint?.classList.remove('visible');
        this.touchHint?.classList.remove('visible');
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
