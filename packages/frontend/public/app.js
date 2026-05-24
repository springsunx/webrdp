// WebRDP - 前端应用
class WebRDPLite {
    constructor() {
        this.guacClient = null;
        this.keyboard = null;
        this.mouse = null;
        this.connectionStatus = 'disconnected';
        this.connectionParams = {};
        this.backendUrl = this.getBackendUrl();
        this.storageKey = 'webrdp-params';
        
        this.initElements();
        this.initEventListeners();
        this.checkUrlParams();
    }
    
    // 获取后端URL
    getBackendUrl() {
        // 合并部署时，后端和前端在同一端口
        return `${window.location.protocol}//${window.location.host}`;
    }
    
    // 获取WebSocket URL
    getWebSocketUrl() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.hostname;
        const port = window.location.port;
        
        // 如果是标准端口（80/443），不带端口；否则带端口
        if (port && port !== '80' && port !== '443') {
            return `${protocol}//${host}:${port}`;
        }
        return `${protocol}//${host}`;
    }
    
    // 初始化DOM元素
    initElements() {
        // 登录界面元素
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
        
        // 桌面界面元素
        this.desktopContainer = document.getElementById('desktop-container');
        this.rdpContainer = document.getElementById('rdp-container');
        this.touchHint = document.getElementById('touch-hint');
        this.statusElement = document.getElementById('status');
        this.disconnectBtn = document.getElementById('disconnect-btn');
        this.reconnectBtn = document.getElementById('reconnect-btn');
        this.fullscreenBtn = document.getElementById('fullscreen-btn');
        this.backBtn = document.getElementById('back-btn');
        this.rdpDisplay = document.getElementById('rdp-display');
        this.loadingElement = document.getElementById('loading');
        this.scrollHint = document.getElementById('scroll-hint');
        this.footerHost = document.getElementById('footer-host');
        this.footerPort = document.getElementById('footer-port');
        this.footerUser = document.getElementById('footer-user');
        this.footerWidth = document.getElementById('footer-width');
        this.footerHeight = document.getElementById('footer-height');
        this.resizeBtn = document.getElementById('resize-btn');
    }
    
    // 初始化事件监听器
    initEventListeners() {
        // 登录表单提交
        this.loginForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleLogin();
        });
        
        // 桌面界面按钮
        this.disconnectBtn.addEventListener('click', () => this.disconnect());
        this.reconnectBtn.addEventListener('click', () => this.reconnect());
        this.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
        this.backBtn.addEventListener('click', () => this.showLogin());
        this.resizeBtn.addEventListener('click', () => this.resizeDisplay());
        
        // 键盘事件
        document.addEventListener('keydown', (e) => this.handleKeyDown(e));
        document.addEventListener('keyup', (e) => this.handleKeyUp(e));
        
        // 窗口大小变化监听（横竖屏切换、窗口缩放）
        window.addEventListener('resize', () => {
            this.adjustDisplaySize();
        });
    }
    
    // 检查URL参数
    checkUrlParams() {
        const params = new URLSearchParams(window.location.search);
        
        const host = params.get('host');
        const port = params.get('port');
        const user = params.get('user');
        const password = params.get('password');
        let width = params.get('width');
        let height = params.get('height');
        const title = params.get('title');
        const auto = params.get('auto'); // 自动计算分辨率
        
        // 设置标题
        this.setTitle(title || 'WebRDP');
        
        // 如果没有指定分辨率或设置了auto参数，自动计算
        if (!width || !height || auto === 'true' || auto === '1') {
            const autoSize = this.calculateOptimalResolution();
            width = width || String(autoSize.width);
            height = height || String(autoSize.height);
        }
        
        // 如果有URL参数，自动连接
        if (host && user && password) {
            this.connectionParams = {
                host: host,
                port: port || '3389',
                user: user,
                password: password,
                width: width || '1024',
                height: height || '768',
                title: title || 'WebRDP'
            };
            
            // 填充表单
            this.fillForm();
            
            // 切换到桌面界面并连接
            this.showDesktop();
            setTimeout(() => this.connect(), 100);
        } else {
            // 没有URL参数，显示登录界面
            this.loadSavedParams();
            // 自动填充分辨率
            const autoSize = this.calculateOptimalResolution();
            this.widthInput.value = autoSize.width;
            this.heightInput.value = autoSize.height;
        }
    }
    
    // 计算最佳分辨率
    calculateOptimalResolution() {
        // 默认分辨率
        let width = 1024;
        let height = 768;
        
        const isMobile = this.isMobile();
        
        if (isMobile) {
            // 手机端：使用标准桌面分辨率（1024x768），让用户横向滚动查看
            // 如果屏幕非常小（<400px宽），用800x600保证可读性
            if (window.innerWidth < 400) {
                width = 800;
                height = 600;
            } else {
                width = 1024;
                height = 768;
            }
            console.log(`[Mobile] Using standard resolution: ${width}x${height}, scroll horizontally`);
            return { width, height };
        }
        
        // 获取容器的实际尺寸
        const container = this.rdpDisplay || document.getElementById('rdp-display');
        
        if (container) {
            const containerWidth = container.clientWidth || container.offsetWidth;
            const containerHeight = container.clientHeight || container.offsetHeight;
            
            // 如果容器尺寸有效（大于100），使用容器尺寸
            if (containerWidth > 100 && containerHeight > 100) {
                width = containerWidth;
                height = containerHeight;
                console.log(`Using container size: ${containerWidth}x${containerHeight}`);
            } else {
                // 否则使用屏幕尺寸
                const screenWidth = window.screen.width;
                const screenHeight = window.screen.height;
                const isPortrait = screenHeight > screenWidth;
                
                if (isPortrait) {
                    width = 800;
                    height = 600;
                } else {
                    width = 1024;
                    height = 768;
                }
                console.log(`Using screen size: ${screenWidth}x${screenHeight}, Resolution: ${width}x${height}`);
            }
        } else {
            // 如果容器不可用，使用屏幕尺寸
            const screenWidth = window.screen.width;
            const screenHeight = window.screen.height;
            const isPortrait = screenHeight > screenWidth;
            
            if (isPortrait) {
                width = 800;
                height = 600;
            } else {
                width = 1024;
                height = 768;
            }
            console.log(`No container, using screen size: ${screenWidth}x${screenHeight}, Resolution: ${width}x${height}`);
        }
        
        // 确保分辨率是8的倍数（RDP要求）
        width = Math.floor(width / 8) * 8;
        height = Math.floor(height / 8) * 8;
        
        // 确保最小分辨率
        width = Math.max(800, width);
        height = Math.max(600, height);
        
        console.log(`Final Resolution: ${width}x${height}`);
        
        return { width, height };
    }
    
    // 设置标题
    setTitle(title) {
        // 更新页面标题
        document.getElementById('page-title').textContent = title;
        document.getElementById('login-title').textContent = title;
        document.getElementById('desktop-title').textContent = title;
    }
    
    // 加载保存的参数
    loadSavedParams() {
        try {
            const saved = localStorage.getItem(this.storageKey);
            if (saved) {
                const params = JSON.parse(saved);
                this.hostInput.value = params.host || '';
                this.portInput.value = params.port || '3389';
                this.userInput.value = params.user || '';
                this.passwordInput.value = params.password || '';
                this.widthInput.value = params.width || '1024';
                this.heightInput.value = params.height || '768';
            }
        } catch (e) {
            console.error('Failed to load saved params:', e);
        }
    }
    
    // 保存参数
    saveParams() {
        if (this.rememberCheckbox.checked) {
            const params = {
                host: this.hostInput.value,
                port: this.portInput.value,
                user: this.userInput.value,
                password: this.passwordInput.value,
                width: this.widthInput.value,
                height: this.heightInput.value
            };
            localStorage.setItem(this.storageKey, JSON.stringify(params));
        }
    }
    
    // 填充表单
    fillForm() {
        this.hostInput.value = this.connectionParams.host;
        this.portInput.value = this.connectionParams.port;
        this.userInput.value = this.connectionParams.user;
        this.passwordInput.value = this.connectionParams.password;
        this.widthInput.value = this.connectionParams.width;
        this.heightInput.value = this.connectionParams.height;
    }
    
    // 处理登录
    handleLogin() {
        const host = this.hostInput.value.trim();
        const port = this.portInput.value.trim() || '3389';
        const user = this.userInput.value.trim();
        const password = this.passwordInput.value.trim();
        const width = this.widthInput.value.trim() || '1024';
        const height = this.heightInput.value.trim() || '768';
        
        // 验证必填字段
        if (!host) {
            this.showError('请输入主机地址');
            return;
        }
        
        if (!user) {
            this.showError('请输入用户名');
            return;
        }
        
        if (!password) {
            this.showError('请输入密码');
            return;
        }
        
        // 保存参数
        this.saveParams();
        
        // 设置连接参数
        this.connectionParams = {
            host: host,
            port: port,
            user: user,
            password: password,
            width: width,
            height: height
        };
        
        // 更新URL（可选）
        const url = new URL(window.location.href);
        url.searchParams.set('host', host);
        url.searchParams.set('port', port);
        url.searchParams.set('user', user);
        url.searchParams.set('password', password);
        url.searchParams.set('width', width);
        url.searchParams.set('height', height);
        window.history.replaceState({}, '', url.toString());
        
        // 切换到桌面界面并连接
        this.showDesktop();
        setTimeout(() => this.connect(), 100);
    }
    
    // 显示错误信息
    showError(message) {
        this.errorMessage.textContent = message;
        this.errorMessage.style.display = 'block';
        setTimeout(() => {
            this.errorMessage.style.display = 'none';
        }, 5000);
    }
    
    // 显示登录界面
    showLogin() {
        this.disconnect();
        this.loginContainer.style.display = 'flex';
        this.desktopContainer.style.display = 'none';
        
        // 清除URL参数
        window.history.replaceState({}, '', window.location.pathname);
    }
    
    // 显示桌面界面
    showDesktop() {
        this.loginContainer.style.display = 'none';
        this.desktopContainer.style.display = 'flex';
        
        // 更新底部信息
        this.footerHost.textContent = this.connectionParams.host;
        this.footerPort.textContent = this.connectionParams.port;
        this.footerUser.textContent = this.connectionParams.user;
        this.footerWidth.value = this.connectionParams.width;
        this.footerHeight.value = this.connectionParams.height;
    }
    
    // 更新状态显示
    updateStatus(status, message) {
        this.connectionStatus = status;
        this.statusElement.textContent = message || status;
        this.statusElement.className = `status ${status}`;
        
        // 更新按钮状态
        this.connectBtn.disabled = status === 'connected' || status === 'connecting';
        this.disconnectBtn.disabled = status !== 'connected';
        
        // 显示/隐藏加载动画
        if (status === 'connecting') {
            this.loadingElement.style.display = 'flex';
        } else {
            this.loadingElement.style.display = 'none';
        }
    }
    
    // 连接到RDP服务器
    async connect() {
        if (!this.connectionParams.host || !this.connectionParams.user || !this.connectionParams.password) {
            this.updateStatus('error', '缺少连接参数');
            return;
        }
        
        this.updateStatus('connecting', '正在连接...');
        
        try {
            // 清理之前的连接
            this.disconnect();
            
            // 获取令牌
            const token = await this.getToken();
            if (!token) {
                throw new Error('Failed to get connection token');
            }
            
            // 创建WebSocket隧道
            const wsBase = this.getWebSocketUrl();
            const tunnelUrl = `${wsBase}?token=${encodeURIComponent(token)}&width=${this.connectionParams.width}&height=${this.connectionParams.height}`;
            
            // @ts-ignore
            const tunnel = new Guacamole.WebSocketTunnel(tunnelUrl);
            
            // 设置隧道错误处理
            tunnel.onerror = (status) => {
                console.error('Tunnel error:', status);
                this.updateStatus('error', `隧道错误: ${status.message}`);
            };
            
            // 创建Guacamole客户端
            // @ts-ignore
            this.guacClient = new Guacamole.Client(tunnel);
            this.guacClient.keepAliveFrequency = 3000;
            
            // 将显示元素添加到DOM
            const displayElement = this.guacClient.getDisplay().getElement();
            this.rdpDisplay.appendChild(displayElement);
            
            // 设置状态变化监听
            this.guacClient.onstatechange = (state) => {
                this.handleStateChange(state);
            };
            
            // 设置错误监听
            this.guacClient.onerror = (status) => {
                console.error('Client error:', status);
                this.updateStatus('error', `客户端错误: ${status.message}`);
            };
            
            // 设置剪贴板监听
            this.guacClient.onclipboard = (stream, mimetype) => {
                this.handleClipboard(stream, mimetype);
            };
            
            // 连接
            this.guacClient.connect('');
            
            // 设置输入监听
            this.setupInputListeners();
            
        } catch (error) {
            console.error('Connection failed:', error);
            this.updateStatus('error', `连接失败: ${error.message}`);
        }
    }
    
    // 获取连接令牌
    async getToken() {
        try {
            const response = await fetch(`${this.backendUrl}/api/rdp/token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    host: this.connectionParams.host,
                    port: parseInt(this.connectionParams.port),
                    user: this.connectionParams.user,
                    password: this.connectionParams.password,
                    width: parseInt(this.connectionParams.width),
                    height: parseInt(this.connectionParams.height),
                }),
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            return data.token;
        } catch (error) {
            console.error('Failed to get token:', error);
            throw error;
        }
    }
    
    // 处理状态变化
    handleStateChange(state) {
        let statusText = '';
        let statusClass = 'disconnected';
        
        switch (state) {
            case 0: // IDLE
                statusText = '空闲';
                statusClass = 'disconnected';
                break;
            case 1: // CONNECTING
                statusText = '正在连接...';
                statusClass = 'connecting';
                break;
            case 2: // WAITING
                statusText = '等待中...';
                statusClass = 'connecting';
                break;
            case 3: // CONNECTED
                statusText = '已连接';
                statusClass = 'connected';
                this.adjustDisplaySize();
                this.showTouchHint();
                break;
            case 4: // DISCONNECTING
                statusText = '正在断开...';
                statusClass = 'disconnected';
                break;
            case 5: // DISCONNECTED
                statusText = '已断开';
                statusClass = 'disconnected';
                break;
        }
        
        this.updateStatus(statusClass, statusText);
    }
    
    // 设置输入监听
    setupInputListeners() {
        if (!this.guacClient) return;
        
        const displayElement = this.guacClient.getDisplay().getElement();
        displayElement.tabIndex = 0;
        displayElement.style.cursor = 'none';
        
        const display = this.guacClient.getDisplay();
        display.showCursor(true);
        
        // 设置光标层级
        const cursorLayer = display.getCursorLayer();
        if (cursorLayer) {
            const cursorElement = cursorLayer.getElement();
            if (cursorElement) {
                cursorElement.style.zIndex = '1000';
            }
        }
        
        // 根据设备类型选择鼠标模式
        const isMobile = this.isMobile();
        const isTouchDevice = this.isTouchDevice();
        const useTouchscreen = this.shouldUseTouchscreen();
        
        if (useTouchscreen) {
            // 触摸屏设备或桌面版网站：使用 Touchscreen 模式（直接点击）
            // @ts-ignore
            this.mouse = new Guacamole.Mouse.Touchscreen(displayElement);
            console.log('[WebRDP] 使用 Touchscreen 模式（触摸屏设备）');
        } else if (isMobile) {
            // 手机端：使用 Touchpad 模式
            // @ts-ignore
            this.mouse = new Guacamole.Mouse.Touchpad(displayElement);
            console.log('[WebRDP] 使用 Touchpad 模式（手机端）');
            
            // 添加双指滚动容器支持
            this.setupDualFingerScroll(displayElement);
        } else {
            // 桌面端：使用标准鼠标模式
            // @ts-ignore
            this.mouse = new Guacamole.Mouse(displayElement);
            console.log('[WebRDP] 使用 Mouse 模式（桌面端）');
        }
        
        // 鼠标事件处理
        this.mouse.onmousedown = this.mouse.onmouseup = this.mouse.onmousemove = (mouseState) => {
            if (this.guacClient) {
                this.guacClient.sendMouseState(mouseState);
            }
        };
        
        // 键盘事件 - 使用Guacamole.Keyboard处理
        // @ts-ignore
        this.keyboard = new Guacamole.Keyboard(displayElement);
        
        this.keyboard.onkeydown = (keysym) => {
            if (this.guacClient) {
                this.guacClient.sendKeyEvent(1, keysym);
            }
        };
        
        this.keyboard.onkeyup = (keysym) => {
            if (this.guacClient) {
                this.guacClient.sendKeyEvent(0, keysym);
            }
        };
        
        // 额外的键盘事件处理 - 拦截浏览器默认行为
        displayElement.addEventListener('keydown', (e) => {
            // 阻止浏览器拦截快捷键
            if (e.altKey || e.ctrlKey || e.metaKey) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);
        
        displayElement.addEventListener('keyup', (e) => {
            if (e.altKey || e.ctrlKey || e.metaKey) {
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);
        
        // 聚焦显示元素
        displayElement.focus();
    }
    
    // 处理键盘事件
    handleKeyDown(e) {
        if (e.target.tagName === 'INPUT') return;
        
        // 全屏快捷键
        if (e.key === 'F11') {
            e.preventDefault();
            this.toggleFullscreen();
        }
    }
    
    handleKeyUp(e) {
        if (e.target.tagName === 'INPUT') return;
    }
    
    // 处理剪贴板
    handleClipboard(stream, mimetype) {
        if (mimetype === 'text/plain') {
            // @ts-ignore
            const reader = new Guacamole.StringReader(stream);
            let text = '';
            
            reader.ontext = (chunk) => {
                text += chunk;
            };
            
            reader.onend = async () => {
                try {
                    await navigator.clipboard.writeText(text);
                    console.log('Clipboard updated from RDP');
                } catch (err) {
                    console.warn('Failed to update clipboard:', err);
                }
            };
        }
    }
    
    // 断开连接
    disconnect() {
        if (this.guacClient) {
            this.guacClient.disconnect();
            this.guacClient = null;
        }
        
        // 清理输入监听
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
        
        // 清理显示
        while (this.rdpDisplay.firstChild) {
            this.rdpDisplay.removeChild(this.rdpDisplay.firstChild);
        }
        
        // 重新添加加载动画
        this.rdpDisplay.appendChild(this.loadingElement);
        this.loadingElement.style.display = 'none';
        
        this.updateStatus('disconnected', '已断开');
    }
    
    // 重新连接
    reconnect() {
        this.disconnect();
        setTimeout(() => this.connect(), 100);
    }
    
    // 判断是否为移动端
    isMobile() {
        return window.innerWidth <= 768;
    }
    
    // 判断是否为触摸屏设备（支持触摸且可能是桌面模式）
    isTouchDevice() {
        return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    }
    
    // 判断是否应使用 Touchscreen 模式（触摸屏设备或桌面版网站）
    shouldUseTouchscreen() {
        // 如果是触摸屏设备且屏幕宽度大于手机宽度（可能是平板或触摸屏显示器）
        // 或者启用了桌面版网站模式
        const isLargeScreen = window.innerWidth > 768;
        const isTouch = this.isTouchDevice();
        
        // 检测是否启用了桌面版网站（通过检测 viewport 缩放）
        const isDesktopMode = window.outerWidth > window.innerWidth;
        
        return isTouch && (isLargeScreen || isDesktopMode);
    }
    
    // 显示/隐藏滚动提示
    showScrollHint(visible) {
        if (!this.scrollHint) return;
        if (visible) {
            this.scrollHint.classList.add('visible');
            // 3秒后自动隐藏
            clearTimeout(this._scrollHintTimer);
            this._scrollHintTimer = setTimeout(() => {
                this.scrollHint.classList.remove('visible');
            }, 3000);
        } else {
            this.scrollHint.classList.remove('visible');
        }
    }
    
    // 显示触摸操作提示（仅手机端）
    showTouchHint() {
        if (!this.touchHint || !this.isMobile()) return;
        this.touchHint.classList.add('visible');
        // 5秒后自动隐藏
        clearTimeout(this._touchHintTimer);
        this._touchHintTimer = setTimeout(() => {
            this.touchHint.classList.remove('visible');
        }, 5000);
    }
    
    // 设置双指滚动容器支持（仅手机端）
    setupDualFingerScroll(displayElement) {
        const container = this.rdpContainer;
        if (!container) return;
        
        let lastTouchX = 0;
        let lastTouchY = 0;
        
        // 拦截双指触摸事件，滚动外层容器
        displayElement.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                lastTouchX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                lastTouchY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
            }
        }, { passive: true });
        
        displayElement.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2) {
                const currentX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                const currentY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                
                const deltaX = currentX - lastTouchX;
                const deltaY = currentY - lastTouchY;
                
                // 滚动外层容器
                container.scrollLeft -= deltaX;
                container.scrollTop -= deltaY;
                
                lastTouchX = currentX;
                lastTouchY = currentY;
            }
        }, { passive: true });
    }
    
    // 调整显示大小
    adjustDisplaySize() {
        if (!this.guacClient || this.connectionStatus !== 'connected') return;
        
        const container = this.rdpContainer;
        if (!container) return;
        
        const maxWidth = container.clientWidth - 40;
        const maxHeight = container.clientHeight - 40;
        
        const width = parseInt(this.connectionParams.width);
        const height = parseInt(this.connectionParams.height);
        
        let scale;
        const isMobile = this.isMobile();
        
        if (isMobile) {
            // 手机端：高度自适应，宽度允许溢出，用横向滚动查看完整画面
            scale = Math.min(maxHeight / height, 1);
            // 如果宽度也能完全显示，就不需要滚动了
            if (width * scale <= maxWidth) {
                // 宽度足够显示，仍然可以居中，用等比缩放
                scale = Math.min(maxWidth / width, maxHeight / height, 1);
            }
        } else {
            // 桌面端：保持原样，双维度缩放适应容器
            scale = Math.min(maxWidth / width, maxHeight / height, 1);
        }
        
        const displayElement = this.guacClient.getDisplay().getElement();
        displayElement.style.width = `${width * scale}px`;
        displayElement.style.height = `${height * scale}px`;
        
        // 若是移动端且内容超出宽度，显示滚动提示
        if (isMobile) {
            const displayWidth = width * scale;
            if (displayWidth > maxWidth) {
                this.showScrollHint(true);
            } else {
                // 宽度可容纳，居中对齐
                container.style.justifyContent = 'center';
                this.showScrollHint(false);
            }
        } else {
            this.showScrollHint(false);
        }
        
        // 发送大小更新到RDP服务器
        this.guacClient.sendSize(width, height);
    }
    
    // 调整分辨率
    resizeDisplay() {
        const width = parseInt(this.footerWidth.value) || 1024;
        const height = parseInt(this.footerHeight.value) || 768;
        
        this.connectionParams.width = String(width);
        this.connectionParams.height = String(height);
        
        this.adjustDisplaySize();
        
        // 更新URL参数
        const url = new URL(window.location.href);
        url.searchParams.set('width', String(width));
        url.searchParams.set('height', String(height));
        window.history.replaceState({}, '', url.toString());
    }
    
    // 切换全屏
    toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(err => {
                console.error('Failed to enter fullscreen:', err);
            });
        } else {
            document.exitFullscreen();
        }
    }
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    window.webRdpLite = new WebRDPLite();
});