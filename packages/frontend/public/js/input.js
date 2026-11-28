/**
 * Unified input controller for desktop mouse/keyboard + mobile/tablet touch
 * gestures + soft keyboard / IME + extra keys.
 *
 * Key properties:
 *  - Viewers can ALWAYS pan and zoom the viewport locally, while remote input
 *    is blocked both locally and on the server.
 *  - On touch devices, supports both 'touchpad' (relative cursor, great for
 *    small screens) and 'touch' (direct tap/drag, great for tablets), switchable
 *    at any time.
 *  - Two-finger drag pans the viewport when zoomed/overflowing, or sends RDP
 *    scroll wheel when viewing fit-to-screen (or when scroll-lock is enabled).
 *  - Pinch zooms smoothly around the midpoint.
 *  - Soft keyboard uses a hidden input element so iOS/Android native keyboards
 *    and Chinese/English IMEs work reliably without scrolling the page.
 */

import { GestureRecognizer } from './gestures.js';

const KEYSYMS = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  Insert: 0xff63,
  Control: 0xffe3,
  Shift: 0xffe1,
  Alt: 0xffe9,
  Meta: 0xffeb,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
};

function charToKeysym(ch) {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return null;
  if (cp === 0x0a || cp === 0x0d) return 0xff0d;
  if (cp === 0x09) return 0xff09;
  if (cp >= 0x20 && cp <= 0x7e) return cp;
  if (cp >= 0xa0 && cp <= 0xff) return cp;
  return 0x01000000 | cp;
}

export class InputController {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.stage      viewport container (#stage)
   * @param {import('./viewport.js').Viewport} opts.viewport
   * @param {import('./session-client.js').SessionClient} opts.client
   * @param {HTMLTextAreaElement} opts.imeInput
   * @param {() => void} opts.onViewportChange
   * @param {() => void} opts.onToggleKeyboard
   * @param {(msg:string) => void} [opts.onHint]
   */
  constructor({ stage, viewport, client, imeInput, onViewportChange, onToggleKeyboard, onHint }) {
    this.stage = stage;
    this.viewport = viewport;
    this.client = client;
    this.imeInput = imeInput;
    this.onViewportChange = onViewportChange;
    this.onToggleKeyboard = onToggleKeyboard;
    this.onHint = onHint || (() => {});

    this.cursor = { x: 512, y: 384 };
    this.buttons = 0; // bitmask: 1=left, 2=middle, 4=right
    this.wheelAccum = 0;
    this.scrollLock = false; // when true, two-finger drag always scrolls remote
    this.touchMode = this._defaultTouchMode();
    this.keyboardOpen = false;
    this.composing = false;
    this.stickyMods = new Set(); // keysyms toggled on the extra-keys bar

    this.guacKeyboard = null;
    this.gesture = new GestureRecognizer(this._gestureSink(), { mode: this.touchMode });

    this._bindStage();
    this._bindDesktopKeyboard();
    this._bindIme();
  }

  _defaultTouchMode() {
    const narrow = window.innerWidth <= 768;
    return narrow ? 'touchpad' : 'touch';
  }

  setTouchMode(mode) {
    this.touchMode = mode === 'touch' ? 'touch' : 'touchpad';
    this.gesture.setMode(this.touchMode);
  }

  setScrollLock(enabled) {
    this.scrollLock = !!enabled;
  }

  syncRemoteSize(w, h) {
    this.cursor.x = Math.min(Math.max(0, this.cursor.x), Math.max(0, w - 1));
    this.cursor.y = Math.min(Math.max(0, this.cursor.y), Math.max(0, h - 1));
  }

  // -------------------------------------------------------------- sending

  _sendMouse(x, y, mask = this.buttons) {
    if (!this.client.isController) return;
    const rx = Math.round(Math.min(Math.max(0, x), Math.max(0, this.viewport.rw - 1)));
    const ry = Math.round(Math.min(Math.max(0, y), Math.max(0, this.viewport.rh - 1)));
    this.cursor.x = rx;
    this.cursor.y = ry;
    this.buttons = mask;
    this.client.sendMouseState({
      x: rx,
      y: ry,
      left: !!(mask & 1),
      middle: !!(mask & 2),
      right: !!(mask & 4),
      up: !!(mask & 8),
      down: !!(mask & 16),
    });
  }

  _pulseWheel(direction) {
    if (!this.client.isController) return;
    const bit = direction > 0 ? 8 : 16; // 8=up, 16=down
    this._sendMouse(this.cursor.x, this.cursor.y, this.buttons | bit);
    this._sendMouse(this.cursor.x, this.cursor.y, this.buttons & ~bit);
  }

  sendTapKey(keysym) {
    if (!this.client.isController || !keysym) return;
    this.client.sendKeyEvent(true, keysym);
    this.client.sendKeyEvent(false, keysym);
    this._releaseStickyModifiers();
  }

  sendKeyCombo(keysyms) {
    if (!this.client.isController || !keysyms.length) return;
    for (const k of keysyms) this.client.sendKeyEvent(true, k);
    for (let i = keysyms.length - 1; i >= 0; i--) this.client.sendKeyEvent(false, keysyms[i]);
  }

  sendText(text) {
    if (!this.client.isController || !text) return;
    for (const ch of text) {
      const ks = charToKeysym(ch);
      if (ks) {
        this.client.sendKeyEvent(true, ks);
        this.client.sendKeyEvent(false, ks);
      }
    }
    this._releaseStickyModifiers();
  }

  toggleStickyModifier(keysym) {
    if (!this.client.isController) return false;
    if (this.stickyMods.has(keysym)) {
      this.stickyMods.delete(keysym);
      this.client.sendKeyEvent(false, keysym);
      return false;
    }
    this.stickyMods.add(keysym);
    this.client.sendKeyEvent(true, keysym);
    return true;
  }

  _releaseStickyModifiers() {
    if (!this.stickyMods.size) return;
    for (const k of this.stickyMods) this.client.sendKeyEvent(false, k);
    this.stickyMods.clear();
    if (this.onStickyChange) this.onStickyChange();
  }

  releaseAll() {
    this.gesture.reset();
    if (this.buttons) this._sendMouse(this.cursor.x, this.cursor.y, 0);
    this._releaseStickyModifiers();
    if (this.guacKeyboard) this.guacKeyboard.reset();
  }

  // ------------------------------------------------------- touch gestures

  _stagePoint(ev) {
    const rect = this.stage.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  _gestureSink() {
    return {
      move: (cx, cy) => {
        if (!this.client.isController) return;
        const r = this.viewport.toRemote(cx, cy);
        this._sendMouse(r.x, r.y, this.buttons);
      },
      down: (btn, cx, cy) => {
        if (!this.client.isController) return;
        if (cx !== undefined) {
          const r = this.viewport.toRemote(cx, cy);
          this._sendMouse(r.x, r.y, this.buttons | btn);
        } else {
          this._sendMouse(this.cursor.x, this.cursor.y, this.buttons | btn);
        }
      },
      up: (btn, cx, cy) => {
        if (!this.client.isController) return;
        if (cx !== undefined) {
          const r = this.viewport.toRemote(cx, cy);
          this._sendMouse(r.x, r.y, this.buttons & ~btn);
        } else {
          this._sendMouse(this.cursor.x, this.cursor.y, this.buttons & ~btn);
        }
      },
      click: (btn, cx, cy) => {
        if (!this.client.isController) return;
        if (cx !== undefined) {
          const r = this.viewport.toRemote(cx, cy);
          this.cursor.x = r.x;
          this.cursor.y = r.y;
        }
        this._sendMouse(this.cursor.x, this.cursor.y, this.buttons | btn);
        this._sendMouse(this.cursor.x, this.cursor.y, this.buttons & ~btn);
      },
      cursor: (dx, dy) => {
        if (!this.client.isController) {
          // Viewers dragging with one finger in touchpad mode simply pan the canvas!
          if (this.viewport.overflowing) {
            this.viewport.panBy(dx, dy);
            this.onViewportChange();
          }
          return;
        }
        const gain = 1.25 / (this.viewport.scale || 1);
        const nx = this.cursor.x + dx * gain;
        const ny = this.cursor.y + dy * gain;
        this._sendMouse(nx, ny, this.buttons);
        if (this.viewport.overflowing && this.viewport.ensureVisible(this.cursor.x, this.cursor.y, 36)) {
          this.onViewportChange();
        }
      },
      drag2: (dx, dy) => {
        // Two-finger drag: scroll remote when locked or when viewport fits cleanly;
        // otherwise pan the zoomed/overflowing viewport.
        if ((this.scrollLock || !this.viewport.overflowing) && this.client.isController) {
          this.wheelAccum += dy;
          const step = 28;
          while (this.wheelAccum >= step) {
            this._pulseWheel(1); // natural scroll: finger down -> wheel up
            this.wheelAccum -= step;
          }
          while (this.wheelAccum <= -step) {
            this._pulseWheel(-1);
            this.wheelAccum += step;
          }
        } else {
          this.viewport.panBy(dx, dy);
          this.onViewportChange();
        }
      },
      zoom: (factor, cx, cy) => {
        this.viewport.zoomAt(factor, cx, cy);
        this.onViewportChange();
      },
      pan: (dx, dy) => {
        this.viewport.panBy(dx, dy);
        this.onViewportChange();
      },
      threeTap: () => {
        if (this.client.isController) this.onToggleKeyboard();
      },
      longPress: () => {
        if (navigator.vibrate) try { navigator.vibrate(18); } catch { /* ignore */ }
      },
    };
  }

  // ------------------------------------------------------------- DOM events

  _bindStage() {
    const el = this.stage;
    let viewerDragging = false;
    let lastX = 0; let lastY = 0;

    el.addEventListener('contextmenu', (e) => e.preventDefault());

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        const p = this._stagePoint(e);
        this.gesture.down(e.pointerId, p.x, p.y, e.timeStamp);
        return;
      }
      // Mouse / pen
      if (!this.keyboardOpen) el.focus({ preventScroll: true });
      const p = this._stagePoint(e);
      if (!this.client.isController) {
        if (this.viewport.overflowing && e.button === 0) {
          viewerDragging = true;
          lastX = e.clientX;
          lastY = e.clientY;
          try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        }
        return;
      }
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      const r = this.viewport.toRemote(p.x, p.y);
      this._sendMouse(r.x, r.y, e.buttons);
    });

    el.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') {
        e.preventDefault();
        const p = this._stagePoint(e);
        this.gesture.move(e.pointerId, p.x, p.y, e.timeStamp);
        return;
      }
      if (viewerDragging) {
        this.viewport.panBy(e.clientX - lastX, e.clientY - lastY);
        lastX = e.clientX;
        lastY = e.clientY;
        this.onViewportChange();
        return;
      }
      if (!this.client.isController) return;
      const p = this._stagePoint(e);
      const r = this.viewport.toRemote(p.x, p.y);
      this._sendMouse(r.x, r.y, e.buttons);
    });

    const onUp = (e) => {
      if (e.pointerType === 'touch') {
        e.preventDefault();
        const p = this._stagePoint(e);
        if (e.type === 'pointercancel') this.gesture.cancel();
        else this.gesture.up(e.pointerId, p.x, p.y, e.timeStamp);
        return;
      }
      if (viewerDragging) { viewerDragging = false; return; }
      if (!this.client.isController) return;
      const p = this._stagePoint(e);
      const r = this.viewport.toRemote(p.x, p.y);
      this._sendMouse(r.x, r.y, e.buttons);
    };
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey) {
        // Pinch-zoom on laptop trackpads
        const p = this._stagePoint(e);
        const factor = Math.exp(-e.deltaY * 0.004);
        this.viewport.zoomAt(factor, p.x, p.y);
        this.onViewportChange();
        return;
      }
      if (!this.client.isController) {
        if (this.viewport.overflowing) {
          this.viewport.panBy(-e.deltaX, -e.deltaY);
          this.onViewportChange();
        }
        return;
      }
      const p = this._stagePoint(e);
      const r = this.viewport.toRemote(p.x, p.y);
      this.cursor.x = r.x;
      this.cursor.y = r.y;
      if (e.deltaY < 0) this._pulseWheel(1);
      else if (e.deltaY > 0) this._pulseWheel(-1);
    }, { passive: false });
  }

  _bindDesktopKeyboard() {
    const Guacamole = window.Guacamole;
    if (!Guacamole) return;
    const kb = new Guacamole.Keyboard(this.stage);
    this.guacKeyboard = kb;
    kb.onkeydown = (keysym) => {
      if (this.keyboardOpen) return true; // handled by IME textarea
      if (!this.client.isController) return true;
      this.client.sendKeyEvent(true, keysym);
      return false;
    };
    kb.onkeyup = (keysym) => {
      if (this.keyboardOpen) return;
      if (!this.client.isController) return;
      this.client.sendKeyEvent(false, keysym);
    };
    window.addEventListener('blur', () => {
      if (this.guacKeyboard) this.guacKeyboard.reset();
    });
  }

  _bindIme() {
    const inp = this.imeInput;
    if (!inp) return;
    inp.addEventListener('compositionstart', () => { this.composing = true; });
    inp.addEventListener('compositionend', (e) => {
      this.composing = false;
      if (e.data) this.sendText(e.data);
      inp.value = '';
    });
    inp.addEventListener('input', (e) => {
      if (this.composing) return;
      if (e.inputType === 'deleteContentBackward') {
        this.sendTapKey(KEYSYMS.Backspace);
        inp.value = '';
        return;
      }
      if (e.inputType === 'insertLineBreak') {
        this.sendTapKey(KEYSYMS.Enter);
        inp.value = '';
        return;
      }
      const val = inp.value;
      if (val) {
        this.sendText(val);
        inp.value = '';
      }
    });
    inp.addEventListener('keydown', (e) => {
      if (this.composing) return;
      const ks = KEYSYMS[e.key];
      if (ks && (e.key === 'Backspace' || e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape' || e.key.startsWith('Arrow'))) {
        e.preventDefault();
        this.sendTapKey(ks);
      }
    });
  }

  openKeyboard() {
    this.keyboardOpen = true;
    if (this.imeInput) {
      this.imeInput.value = '';
      this.imeInput.focus({ preventScroll: true });
    }
  }

  closeKeyboard() {
    this.keyboardOpen = false;
    if (this.imeInput) {
      this.imeInput.blur();
      this.imeInput.value = '';
    }
    this._releaseStickyModifiers();
  }
}

export { KEYSYMS };
