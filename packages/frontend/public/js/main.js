/**
 * WebRDP main application controller.
 *
 * Keeps the toolbar compact (single row even on small phones, never wrapping
 * into a multi-line banner on control handoff), respects safe-area insets and
 * visualViewport (soft keyboard), preserves URL password compatibility, and
 * keeps every control button strictly synchronized with server state.
 */

import {
  parseLocation, hasCredentials, isAuto, buildUrl, stripConnectionParams, optimalResolution,
} from './params.js';
import { Viewport } from './viewport.js';
import { SessionClient } from './session-client.js';
import { InputController, KEYSYMS } from './input.js';

const STORAGE_KEY = 'webrdp-params';

function $(id) { return document.getElementById(id); }

function formatDuration(ms) {
  if (ms === null || ms === undefined || ms < 0) return '--:--';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

class WebRDPApp {
  constructor() {
    this.urlSource = 'query';
    this.params = {};
    this.displayEl = null;
    this.isCoarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    this.viewport = new Viewport({ maxFitScale: this.isCoarse ? Infinity : 1 });
    this.client = new SessionClient();
    this.input = null;
    this._toastTimer = null;
    this._durationTimer = null;
    this._drawerOpen = false;
    this._rosterOpen = false;
    this._kbBarOpen = false;

    this._initDom();
    this._bindLogin();
    this._bindToolbar();
    this._bindClient();
    this._bindResize();
    this._boot();
  }

  _initDom() {
    this.el = {
      loginView: $('login-view'),
      loginForm: $('login-form'),
      loginError: $('login-error'),
      loginTitle: $('login-title'),
      host: $('host'),
      port: $('port'),
      user: $('user'),
      password: $('password'),
      width: $('width'),
      height: $('height'),
      domain: $('domain'),
      displayName: $('display-name'),
      remember: $('remember'),
      connectBtn: $('connect-btn'),

      desktopView: $('desktop-view'),
      desktopTitle: $('desktop-title'),
      statusDot: $('status-dot'),
      duration: $('session-duration'),
      rosterBtn: $('roster-btn'),
      rosterCount: $('roster-count'),
      rosterPopover: $('roster-popover'),
      rosterList: $('roster-list'),
      rosterMeta: $('roster-meta'),

      controlBtn: $('control-btn'),
      controlBadge: $('control-badge'),
      kbBtn: $('kb-btn'),
      moreBtn: $('more-btn'),
      drawer: $('more-drawer'),
      drawerBackdrop: $('drawer-backdrop'),

      stage: $('stage'),
      canvasHost: $('canvas-host'),
      overlay: $('stage-overlay'),
      overlayText: $('overlay-text'),
      overlaySpinner: $('overlay-spinner'),
      overlayActions: $('overlay-actions'),
      overlayRetry: $('overlay-retry'),
      overlayBack: $('overlay-back'),
      banner: $('status-banner'),
      bannerText: $('banner-text'),
      bannerBtn: $('banner-btn'),
      toast: $('toast'),

      kbBar: $('kb-bar'),
      imeInput: $('ime-input'),

      // Drawer controls
      modeTouchpad: $('mode-touchpad'),
      modeTouch: $('mode-touch'),
      scrollLock: $('scroll-lock'),
      zoomFit: $('zoom-fit'),
      zoomHeight: $('zoom-height'),
      zoom100: $('zoom-100'),
      resWidth: $('res-width'),
      resHeight: $('res-height'),
      resApply: $('res-apply'),
      infoTarget: $('info-target'),
      btnFullscreen: $('btn-fullscreen'),
      btnReconnect: $('btn-reconnect'),
      btnDisconnect: $('btn-disconnect'),
      btnBack: $('btn-back'),
      btnCad: $('btn-cad'),
      btnPaste: $('btn-paste'),
    };

    this.input = new InputController({
      stage: this.el.stage,
      viewport: this.viewport,
      client: this.client,
      imeInput: this.el.imeInput,
      onViewportChange: () => this._renderTransform(),
      onToggleKeyboard: () => this._toggleKeyboard(),
    });
    this.input.onStickyChange = () => this._syncStickyKeys();
    this._syncModeButtons();
  }

  // --------------------------------------------------------------- boot

  _boot() {
    const { params, source } = parseLocation(window.location);
    this.urlSource = source === 'hash' ? 'hash' : 'query';
    const title = params.title || 'WebRDP';
    this._setTitle(title);

    if (params.mode === 'touch' || params.mode === 'touchpad') {
      this.input.setTouchMode(params.mode);
      this._syncModeButtons();
    }

    if (hasCredentials(params)) {
      let { width, height } = params;
      if (!width || !height || isAuto(params)) {
        const auto = this._calcResolution();
        width = width || String(auto.width);
        height = height || String(auto.height);
      }
      this.params = {
        ...params,
        port: params.port || '3389',
        width: String(width),
        height: String(height),
        title,
      };
      this._fillForm(this.params);
      this._showDesktop();
      this._connect();
    } else {
      this._loadSaved();
      const auto = this._calcResolution();
      if (!this.el.width.value) this.el.width.value = String(auto.width);
      if (!this.el.height.value) this.el.height.value = String(auto.height);
      this._showLogin(false);
    }
  }

  _calcResolution() {
    const mobile = window.innerWidth <= 768;
    const rect = this.el.stage.getBoundingClientRect();
    return optimalResolution({
      innerWidth: window.innerWidth,
      containerWidth: rect.width,
      containerHeight: rect.height,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      mobile,
    });
  }

  _setTitle(title) {
    document.title = title;
    this.el.loginTitle.textContent = title;
    this.el.desktopTitle.textContent = title;
  }

  // --------------------------------------------------------------- login

  _bindLogin() {
    this.el.loginForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const host = this.el.host.value.trim();
      const port = this.el.port.value.trim() || '3389';
      const user = this.el.user.value.trim();
      const password = this.el.password.value;
      const width = this.el.width.value.trim() || '1024';
      const height = this.el.height.value.trim() || '768';
      const domain = this.el.domain.value.trim();
      const name = this.el.displayName.value.trim();

      if (!host || !user || !password) {
        this._showLoginError('请填写主机地址、用户名和密码');
        return;
      }
      this._hideLoginError();
      this.params = {
        ...this.params,
        host,
        port,
        user,
        password,
        width,
        height,
        domain,
        name,
        title: this.params.title || 'WebRDP',
      };
      if (this.el.remember.checked) this._saveParams();
      // Preserve URL parameter behavior (including password) for refresh/share.
      const nextUrl = buildUrl(window.location.href, {
        host, port, user, password, width, height,
        ...(domain ? { domain } : {}),
        ...(name ? { name } : {}),
      }, this.urlSource);
      window.history.replaceState({}, '', nextUrl);
      this._showDesktop();
      this._connect();
    });
  }

  _showLoginError(msg) {
    this.el.loginError.textContent = msg;
    this.el.loginError.hidden = false;
  }

  _hideLoginError() {
    this.el.loginError.hidden = true;
  }

  _loadSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      this._fillForm(p);
    } catch { /* ignore */ }
  }

  _saveParams() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        host: this.params.host,
        port: this.params.port,
        user: this.params.user,
        password: this.params.password,
        width: this.params.width,
        height: this.params.height,
        domain: this.params.domain || '',
        name: this.params.name || '',
      }));
    } catch { /* ignore */ }
  }

  _fillForm(p) {
    if (p.host) this.el.host.value = p.host;
    if (p.port) this.el.port.value = p.port;
    if (p.user) this.el.user.value = p.user;
    if (p.password) this.el.password.value = p.password;
    if (p.width) this.el.width.value = p.width;
    if (p.height) this.el.height.value = p.height;
    if (p.domain) this.el.domain.value = p.domain;
    if (p.name) this.el.displayName.value = p.name;
  }

  _showLogin(clearUrl = true) {
    this._closeAllPopups();
    this._setKeyboardOpen(false);
    this.client.disconnect();
    this._stopDurationTimer();
    this.el.desktopView.hidden = true;
    this.el.loginView.hidden = false;
    if (clearUrl) {
      window.history.replaceState({}, '', stripConnectionParams(window.location.href));
    }
  }

  _showDesktop() {
    this.el.loginView.hidden = true;
    this.el.desktopView.hidden = false;
    this.el.infoTarget.textContent = `${this.params.user}@${this.params.host}:${this.params.port}`;
    this.el.resWidth.value = this.params.width;
    this.el.resHeight.value = this.params.height;
    this._measureStage();
    // On narrow mobile screens, default to height-fit (matching original UX) unless zoom preset specified.
    const defaultZoom = this.params.zoom || (window.innerWidth <= 768 ? 'height' : 'fit');
    this.viewport.applyPreset(defaultZoom);
    this._startDurationTimer();
  }

  _connect() {
    this._showOverlay('正在连接远程桌面...', { spinner: true, actions: false });
    this._hideBanner();
    this.client.connect(this.params);
  }

  // ------------------------------------------------------------- toolbar

  _bindToolbar() {
    this.el.controlBtn.addEventListener('click', () => {
      const st = this.client.state;
      if (!st || !st.you) return;
      if (st.you.controller && st.you.role !== 'primary') {
        this.client.releaseControl();
      } else if (!st.you.controller) {
        this.client.requestControl();
      }
    });

    this.el.rosterBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._setDrawer(false);
      this._setRoster(!this._rosterOpen);
    });

    this.el.kbBtn.addEventListener('click', () => this._toggleKeyboard());

    this.el.moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._setRoster(false);
      this._setDrawer(!this._drawerOpen);
    });

    this.el.drawerBackdrop.addEventListener('click', () => this._closeAllPopups());
    document.addEventListener('click', (e) => {
      if (this._rosterOpen && !this.el.rosterPopover.contains(e.target) && !this.el.rosterBtn.contains(e.target)) {
        this._setRoster(false);
      }
    });

    // Touch mode
    this.el.modeTouchpad.addEventListener('click', () => {
      this.input.setTouchMode('touchpad');
      this._syncModeButtons();
      this._toast('已切换为触控板模式');
    });
    this.el.modeTouch.addEventListener('click', () => {
      this.input.setTouchMode('touch');
      this._syncModeButtons();
      this._toast('已切换为直接触控模式');
    });
    this.el.scrollLock.addEventListener('change', (e) => {
      this.input.setScrollLock(e.target.checked);
    });

    // Zoom presets
    this.el.zoomFit.addEventListener('click', () => { this.viewport.applyPreset('fit'); this._renderTransform(); this._setDrawer(false); });
    this.el.zoomHeight.addEventListener('click', () => { this.viewport.applyPreset('height'); this._renderTransform(); this._setDrawer(false); });
    this.el.zoom100.addEventListener('click', () => { this.viewport.applyPreset('1'); this._renderTransform(); this._setDrawer(false); });

    // Resolution
    this.el.resApply.addEventListener('click', () => {
      if (!this.client.isController) {
        this._toast('需要控制权才能调整分辨率');
        return;
      }
      const w = Math.max(640, Math.min(3840, Number.parseInt(this.el.resWidth.value, 10) || 1024));
      const h = Math.max(480, Math.min(2160, Number.parseInt(this.el.resHeight.value, 10) || 768));
      this.params.width = String(w);
      this.params.height = String(h);
      this.client.sendSize(w, h);
      const nextUrl = buildUrl(window.location.href, { width: w, height: h }, this.urlSource);
      window.history.replaceState({}, '', nextUrl);
      this._setDrawer(false);
    });

    // Actions
    this.el.btnCad.addEventListener('click', () => {
      this.input.sendKeyCombo([KEYSYMS.Control, KEYSYMS.Alt, KEYSYMS.Delete]);
      this._setDrawer(false);
    });
    this.el.btnPaste.addEventListener('click', async () => {
      if (!this.client.isController) { this._toast('当前为观看模式'); return; }
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          this.client.sendClipboard(text);
          this.input.sendKeyCombo([KEYSYMS.Control, 0x76]); // Ctrl+V
          this._toast('已发送剪贴板文本');
        }
      } catch {
        this._toast('浏览器不允许读取剪贴板');
      }
      this._setDrawer(false);
    });
    this.el.btnFullscreen.addEventListener('click', () => { this._toggleFullscreen(); this._setDrawer(false); });
    this.el.btnReconnect.addEventListener('click', () => { this._setDrawer(false); this.client.reconnectNow(); });
    this.el.btnDisconnect.addEventListener('click', () => { this._setDrawer(false); this.client.disconnect(); });
    this.el.btnBack.addEventListener('click', () => this._showLogin(true));

    this.el.overlayRetry.addEventListener('click', () => this.client.reconnectNow());
    this.el.overlayBack.addEventListener('click', () => this._showLogin(true));
    this.el.bannerBtn.addEventListener('click', () => this.client.reconnectNow());

    // Extra keys bar
    this.el.kbBar.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-key], button[data-action]');
      if (!btn) return;
      e.preventDefault();
      if (btn.dataset.action === 'close') { this._setKeyboardOpen(false); return; }
      if (btn.dataset.action === 'cad') { this.input.sendKeyCombo([KEYSYMS.Control, KEYSYMS.Alt, KEYSYMS.Delete]); return; }
      if (btn.dataset.action === 'rclick') {
        this.input._sendMouse(this.input.cursor.x, this.input.cursor.y, 4);
        this.input._sendMouse(this.input.cursor.x, this.input.cursor.y, 0);
        return;
      }
      const keyName = btn.dataset.key;
      const ks = KEYSYMS[keyName];
      if (!ks) return;
      if (btn.dataset.sticky === '1') {
        this.input.toggleStickyModifier(ks);
        this._syncStickyKeys();
      } else {
        this.input.sendTapKey(ks);
      }
      if (this._kbBarOpen && this.el.imeInput) this.el.imeInput.focus({ preventScroll: true });
    });

    document.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.key === 'F11') { e.preventDefault(); this._toggleFullscreen(); }
    });
  }

  _syncModeButtons() {
    this.el.modeTouchpad.classList.toggle('active', this.input.touchMode === 'touchpad');
    this.el.modeTouch.classList.toggle('active', this.input.touchMode === 'touch');
  }

  _syncStickyKeys() {
    this.el.kbBar.querySelectorAll('button[data-sticky="1"]').forEach((b) => {
      const ks = KEYSYMS[b.dataset.key];
      b.classList.toggle('active', this.input.stickyMods.has(ks));
    });
  }

  _toggleKeyboard() {
    this._setKeyboardOpen(!this._kbBarOpen);
  }

  _setKeyboardOpen(open) {
    this._kbBarOpen = open;
    this.el.kbBar.hidden = !open;
    this.el.kbBtn.classList.toggle('active', open);
    if (open) this.input.openKeyboard();
    else this.input.closeKeyboard();
    this._measureStage();
  }

  _setDrawer(open) {
    this._drawerOpen = open;
    this.el.drawer.hidden = !open;
    this.el.drawerBackdrop.hidden = !open;
  }

  _setRoster(open) {
    this._rosterOpen = open;
    this.el.rosterPopover.hidden = !open;
  }

  _closeAllPopups() {
    this._setDrawer(false);
    this._setRoster(false);
  }

  _toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  // ------------------------------------------------------- client events

  _bindClient() {
    this.client.addEventListener('display', (e) => {
      const display = e.detail.display;
      const el = display.getElement();
      if (this.displayEl !== el) {
        this.el.canvasHost.replaceChildren(el);
        this.displayEl = el;
      }
      const w = display.getWidth();
      const h = display.getHeight();
      if (w > 0 && h > 0) this._onRemoteResize(w, h);
    });

    this.client.addEventListener('resize', (e) => {
      this._onRemoteResize(e.detail.width, e.detail.height);
    });

    this.client.addEventListener('status', (e) => {
      const { status, message, retryable } = e.detail;
      this.el.statusDot.dataset.status = status;
      this.el.statusDot.title = message || status;
      this._updateDuration();

      if (status === 'connected') {
        this._hideOverlay();
        this._hideBanner();
        this._syncControlUI();
      } else if (status === 'connecting') {
        this._showOverlay(message || '正在连接...', { spinner: true, actions: false });
        this._hideBanner();
      } else if (status === 'reconnecting') {
        this.input.releaseAll();
        if (this.displayEl && this.viewport.rw > 0) {
          // Keep the last frame visible, show a compact non-blocking banner.
          this._hideOverlay();
          this._showBanner(message || '正在重连...', '立即重连');
        } else {
          this._showOverlay(message || '正在重连...', { spinner: true, actions: true });
        }
        this._syncControlUI();
      } else if (status === 'error') {
        this.input.releaseAll();
        this._hideBanner();
        this._showOverlay(message || '连接失败', { spinner: false, actions: true, retryable });
        this._syncControlUI();
      } else if (status === 'disconnected') {
        this.input.releaseAll();
        this._hideOverlay();
        this._showBanner('已断开连接', '重新连接');
        this._syncControlUI();
      }
    });

    this.client.addEventListener('unstable', (e) => {
      if (e.detail.unstable && this.client.status === 'connected') {
        this._showBanner('网络不稳定...', null);
      } else if (!e.detail.unstable && this.client.status === 'connected') {
        this._hideBanner();
      }
    });

    this.client.addEventListener('state', (e) => {
      const st = e.detail;
      if (st.display && st.display.width && st.display.height && !this.viewport.rw) {
        this._onRemoteResize(st.display.width, st.display.height);
      }
      this._syncControlUI();
      this._syncRoster(st);
      this._updateDuration();
    });

    this.client.addEventListener('events', (e) => {
      const me = this.client.state && this.client.state.you && this.client.state.you.id;
      for (const ev of e.detail) {
        if (ev.type === 'control') {
          if (ev.to === me) {
            if (ev.reason === 'reclaim') this._toast('已抢回控制权');
            else if (ev.reason === 'takeover') this._toast('已接管控制权');
            else if (ev.reason === 'operator_left') this._toast('临时操作者离开，控制权已自动归还');
            else if (ev.reason === 'release') this._toast('对方已归还控制权');
            else if (ev.reason === 'primary_returned') this._toast('已恢复主控身份与控制权');
            else if (ev.reason === 'promotion') this._toast('原主用户超时离线，你已成为主用户');
          } else if (ev.from === me) {
            this.input.releaseAll();
            if (ev.reason === 'reclaim') this._toast('主用户已抢回控制权');
            else if (ev.reason === 'takeover') this._toast(`${ev.toLabel || '其他用户'} 已接管控制权`);
            else if (ev.reason === 'release') this._toast('已归还控制权');
          } else if (ev.to) {
            this._toast(`${ev.toLabel || '其他用户'} 正在操作`);
          }
        } else if (ev.type === 'primary_offline' && ev.id !== me) {
          this._toast('主用户已离线，可点击“接管”进行操作');
        } else if (ev.type === 'primary_returned' && ev.id !== me) {
          this._toast('主用户已重新连入');
        } else if (ev.type === 'primary_expired' && ev.id !== me) {
          this._toast('主用户离线超时，已自动移交主控身份');
        }
      }
    });

    this.client.addEventListener('denied', () => {
      this._toast('当前为观看模式，点击“接管”后可操作');
    });

    this.client.addEventListener('clipboard', async (e) => {
      try { await navigator.clipboard.writeText(e.detail.text); } catch { /* ignore */ }
    });
  }

  _syncControlUI() {
    const st = this.client.state;
    const connected = this.client.status === 'connected';
    const btn = this.el.controlBtn;
    const badge = this.el.controlBadge;

    if (!st || !st.you || !connected) {
      btn.hidden = true;
      badge.hidden = true;
      this.el.stage.classList.remove('is-controller', 'is-viewer');
      return;
    }

    const isPrimary = st.you.role === 'primary';
    const isCtl = st.you.controller;
    this.el.stage.classList.toggle('is-controller', isCtl);
    this.el.stage.classList.toggle('is-viewer', !isCtl);

    if (isPrimary && isCtl) {
      // Primary currently in control: show compact status pill, no redundant button.
      btn.hidden = true;
      badge.hidden = false;
      badge.textContent = '主控';
      badge.dataset.kind = 'primary';
    } else if (isPrimary && !isCtl) {
      // Primary viewing while a viewer took over: one-tap reclaim.
      badge.hidden = true;
      btn.hidden = false;
      btn.textContent = '抢回';
      btn.dataset.kind = 'reclaim';
    } else if (!isPrimary && isCtl) {
      // Temporary operator: one-tap release.
      badge.hidden = true;
      btn.hidden = false;
      btn.textContent = '归还';
      btn.dataset.kind = 'release';
    } else {
      // Viewer watching: one-tap takeover.
      badge.hidden = true;
      btn.hidden = false;
      btn.textContent = '接管';
      btn.dataset.kind = 'takeover';
    }
  }

  _syncRoster(st) {
    const online = st.participants.filter((p) => p.online);
    this.el.rosterCount.textContent = String(online.length);
    this.el.rosterBtn.classList.toggle('multi', online.length > 1);

    const frag = document.createDocumentFragment();
    for (const p of st.participants) {
      const li = document.createElement('li');
      li.className = 'roster-item';
      const name = document.createElement('span');
      name.className = 'roster-name';
      name.textContent = p.label + (st.you && p.id === st.you.id ? ' (我)' : '');
      const tags = document.createElement('span');
      tags.className = 'roster-tags';
      if (p.primary) {
        const t = document.createElement('span');
        t.className = 'tag tag-primary';
        t.textContent = p.online ? '主用户' : '主用户(离线)';
        tags.appendChild(t);
      }
      if (p.controller) {
        const t = document.createElement('span');
        t.className = 'tag tag-ctl';
        t.textContent = '操作中';
        tags.appendChild(t);
      } else if (p.online) {
        const t = document.createElement('span');
        t.className = 'tag tag-view';
        t.textContent = '观看';
        tags.appendChild(t);
      }
      li.append(name, tags);
      frag.appendChild(li);
    }
    this.el.rosterList.replaceChildren(frag);

    if (!st.primaryOnline && st.primaryGraceEndsAt) {
      const rem = Math.max(0, Math.ceil((st.primaryGraceEndsAt - (Date.now() + this.client.clockOffset)) / 1000));
      this.el.rosterMeta.textContent = `主用户离线保留剩余 ${rem}s`;
      this.el.rosterMeta.hidden = false;
    } else {
      this.el.rosterMeta.hidden = true;
    }
  }

  // ------------------------------------------------------ layout & timers

  _bindResize() {
    const onResize = () => {
      this._updateVisualViewport();
      this._measureStage();
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => setTimeout(onResize, 120));
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onResize);
    }
  }

  _updateVisualViewport() {
    if (!window.visualViewport) return;
    // Shrink root height when the mobile soft keyboard pops up so the extra-keys bar sits right above it.
    document.documentElement.style.setProperty('--vvh', `${window.visualViewport.height}px`);
  }

  _measureStage() {
    const rect = this.el.stage.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.viewport.setContainer(rect.width, rect.height);
      this._renderTransform();
    }
  }

  _onRemoteResize(w, h) {
    this.viewport.setRemote(w, h);
    this.input.syncRemoteSize(w, h);
    this.el.resWidth.value = String(w);
    this.el.resHeight.value = String(h);
    this._renderTransform();
  }

  _renderTransform() {
    const host = this.el.canvasHost;
    if (!host || !this.viewport.rw) return;
    host.style.width = `${this.viewport.rw}px`;
    host.style.height = `${this.viewport.rh}px`;
    host.style.transform = `translate3d(${this.viewport.x.toFixed(1)}px, ${this.viewport.y.toFixed(1)}px, 0) scale(${this.viewport.scale.toFixed(4)})`;
  }

  _startDurationTimer() {
    this._stopDurationTimer();
    this._updateDuration();
    this._durationTimer = setInterval(() => {
      this._updateDuration();
      if (this._rosterOpen && this.client.state) this._syncRoster(this.client.state);
    }, 1000);
  }

  _stopDurationTimer() {
    clearInterval(this._durationTimer);
    this._durationTimer = null;
  }

  _updateDuration() {
    this.el.duration.textContent = formatDuration(this.client.getSessionDurationMs());
  }

  // ------------------------------------------------------------ feedback

  _showOverlay(text, { spinner = false, actions = false } = {}) {
    this.el.overlayText.textContent = text;
    this.el.overlaySpinner.hidden = !spinner;
    this.el.overlayActions.hidden = !actions;
    this.el.overlay.hidden = false;
  }

  _hideOverlay() {
    this.el.overlay.hidden = true;
  }

  _showBanner(text, btnLabel) {
    this.el.bannerText.textContent = text;
    if (btnLabel) {
      this.el.bannerBtn.textContent = btnLabel;
      this.el.bannerBtn.hidden = false;
    } else {
      this.el.bannerBtn.hidden = true;
    }
    this.el.banner.hidden = false;
  }

  _hideBanner() {
    this.el.banner.hidden = true;
  }

  _toast(message) {
    this.el.toast.textContent = message;
    this.el.toast.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.el.toast.classList.remove('show'), 2800);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.webRdpApp = new WebRDPApp();
});
