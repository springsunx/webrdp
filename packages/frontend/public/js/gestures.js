/**
 * Touch gesture recognizer (pure logic, no DOM). Feed it pointer events and
 * it emits high level actions to a sink.
 *
 * Modes
 *   'touchpad'  – the screen behaves like a laptop touchpad (relative cursor)
 *   'touch'     – direct touch: the finger is the mouse pointer
 *
 * Gestures
 *   one finger tap .............. left click (touch: at finger, touchpad: at cursor)
 *   one finger drag ............. touch: left-button drag / touchpad: move cursor
 *   tap, then touch & drag ...... touchpad: left-button drag
 *   long press (touch mode) ..... right click at the finger
 *   two finger tap .............. right click
 *   two finger drag ............. `drag2` (consumer: pan view or mouse wheel)
 *   pinch ....................... `zoom` (+ `pan` by midpoint movement)
 *   three finger tap ............ `threeTap` (toggle soft keyboard)
 *
 * Conflict / mis-touch strategy
 *   - Nothing is sent for a single finger until it either moves beyond
 *     SLOP px or is released. A second finger that lands before that
 *     cancels the single finger action, so pinch/scroll never clicks.
 *   - A two finger gesture is classified once (pinch vs drag) and then locked
 *     until all fingers are lifted; lifting one finger never turns the rest of
 *     the gesture into a click or a drag.
 *   - Long press only fires if the finger stayed within SLOP.
 *   - Extra fingers during a drag are ignored.
 */

export const SLOP = 10;
export const TAP_MAX_MS = 280;
export const LONG_PRESS_MS = 550;
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_DIST = 40;
export const PINCH_THRESHOLD = 24; // px change of finger distance
export const TWO_TAP_MAX_MS = 300;

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export class GestureRecognizer {
  /**
   * @param {object} sink   action callbacks (all optional):
   *   move(x,y)  down(button,x,y)  up(button,x,y)  click(button,x,y)
   *   cursor(dx,dy)  drag2(dx,dy)  zoom(factor,cx,cy)  pan(dx,dy)  threeTap()  longPress(x,y)
   * @param {object} [opts]
   */
  constructor(sink, { mode = 'touchpad', setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.sink = sink;
    this.mode = mode;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pointers = new Map(); // id -> {x,y,sx,sy,t}
    this.state = 'idle';
    this.lastTap = null; // {x,y,t}
    this.timer = null;
    this.maxPointers = 0;
  }

  setMode(mode) { this.reset(); this.mode = mode; }

  _emit(name, ...args) { const f = this.sink[name]; if (f) f(...args); }

  reset() {
    if (this.state === 'drag' || this.state === 'trackdrag') this._emit('up', 1, ...this._anchorXY());
    this._clearTimer();
    this.pointers.clear();
    this.state = 'idle';
    this.maxPointers = 0;
  }

  _clearTimer() { if (this.timer) { this.clearTimer(this.timer); this.timer = null; } }

  _anchorXY() {
    const p = this.pointers.values().next().value;
    return p ? [p.x, p.y] : [0, 0];
  }

  down(id, x, y, t) {
    this.pointers.set(id, { x, y, sx: x, sy: y, t, lx: x, ly: y });
    const n = this.pointers.size;
    this.maxPointers = Math.max(this.maxPointers, n);
    switch (this.state) {
      case 'idle': {
        this.state = 'one';
        this.start = { x, y, t };
        this.dragArmed = this.mode === 'touchpad' && this.lastTap
          && t - this.lastTap.t < DOUBLE_TAP_MS && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < DOUBLE_TAP_DIST;
        if (this.mode === 'touch') {
          this.timer = this.setTimer(() => this._longPress(), LONG_PRESS_MS);
        }
        break;
      }
      case 'one':
      case 'trackmove':
        if (n === 2) this._startTwo(t);
        break;
      case 'two':
        if (n === 3) { this.state = 'three'; this.threeStart = t; }
        break;
      default:
        // drag / trackdrag / pinch / drag2 / wait: extra fingers are ignored
        break;
    }
  }

  _startTwo(t) {
    this._clearTimer();
    const [a, b] = [...this.pointers.values()];
    this.state = 'two';
    this.two = { t, d0: dist(a, b), m0: mid(a, b), lastD: dist(a, b), lastM: mid(a, b), first: { x: a.sx, y: a.sy } };
  }

  move(id, x, y, t) {
    const p = this.pointers.get(id);
    if (!p) return;
    const dx = x - p.x; const dy = y - p.y;
    p.x = x; p.y = y;
    switch (this.state) {
      case 'one': {
        if (Math.hypot(x - p.sx, y - p.sy) < SLOP) return;
        this._clearTimer();
        if (this.mode === 'touch') {
          this.state = 'drag';
          this._emit('move', p.sx, p.sy);
          this._emit('down', 1, p.sx, p.sy);
          this._emit('move', x, y);
        } else if (this.dragArmed) {
          this.state = 'trackdrag';
          this._emit('down', 1);
          this._emit('cursor', x - p.sx, y - p.sy);
        } else {
          this.state = 'trackmove';
          this._emit('cursor', x - p.sx, y - p.sy);
        }
        break;
      }
      case 'drag':
        if (id === this._primaryId()) this._emit('move', x, y);
        break;
      case 'trackmove':
      case 'trackdrag':
        if (id === this._primaryId()) this._emit('cursor', dx, dy);
        break;
      case 'two': {
        const [a, b] = this._twoPoints();
        if (!a) return;
        const d = dist(a, b); const m = mid(a, b);
        if (Math.abs(d - this.two.d0) > PINCH_THRESHOLD) {
          this.state = 'pinch';
          this.two.lastD = d; this.two.lastM = m;
        } else if (dist(m, this.two.m0) > SLOP) {
          this.state = 'drag2';
          this._emit('drag2', m.x - this.two.m0.x, m.y - this.two.m0.y);
          this.two.lastM = m;
        }
        break;
      }
      case 'pinch': {
        const [a, b] = this._twoPoints();
        if (!a) return;
        const d = dist(a, b); const m = mid(a, b);
        if (this.two.lastD > 0) this._emit('zoom', d / this.two.lastD, m.x, m.y);
        this._emit('pan', m.x - this.two.lastM.x, m.y - this.two.lastM.y);
        this.two.lastD = d; this.two.lastM = m;
        break;
      }
      case 'drag2': {
        const [a, b] = this._twoPoints();
        if (!a) return;
        const m = mid(a, b);
        this._emit('drag2', m.x - this.two.lastM.x, m.y - this.two.lastM.y);
        this.two.lastM = m;
        break;
      }
      default:
        break;
    }
  }

  _primaryId() { return this.pointers.keys().next().value; }

  _twoPoints() {
    const it = this.pointers.values();
    const a = it.next().value; const b = it.next().value;
    return b ? [a, b] : [null, null];
  }

  up(id, x, y, t) {
    const p = this.pointers.get(id);
    if (!p) return;
    p.x = x; p.y = y;
    const state = this.state;
    switch (state) {
      case 'one': {
        this._clearTimer();
        this.pointers.delete(id);
        if (t - this.start.t <= TAP_MAX_MS * 3 || this.mode === 'touchpad') {
          // a tap (touch mode taps can be slow-ish; long press already handled)
          if (this.mode === 'touch') {
            this._emit('move', p.sx, p.sy);
            this._emit('click', 1, p.sx, p.sy);
          } else {
            this._emit('click', 1);
          }
          this.lastTap = { x: p.sx, y: p.sy, t };
        }
        this.state = 'idle';
        break;
      }
      case 'drag': {
        const wasPrimary = id === this._primaryId();
        this.pointers.delete(id);
        if (wasPrimary) {
          // the dragging finger left: release the button, ignore the rest
          this._emit('up', 1, x, y);
          this.state = this.pointers.size ? 'wait' : 'idle';
        }
        break;
      }
      case 'trackmove':
        this.pointers.delete(id);
        if (this.pointers.size === 0) this.state = 'idle';
        this.lastTap = null;
        break;
      case 'trackdrag':
        this.pointers.delete(id);
        if (this.pointers.size === 0) { this._emit('up', 1); this.state = 'idle'; }
        this.lastTap = null;
        break;
      case 'two': {
        // lifting during an unclassified two finger touch -> candidate two-finger tap
        this.pointers.delete(id);
        const quick = t - this.two.t <= TWO_TAP_MAX_MS;
        this.state = quick ? 'twotap' : 'wait';
        if (this.pointers.size === 0) this._finishTwoTap(t);
        break;
      }
      case 'twotap':
        this.pointers.delete(id);
        if (this.pointers.size === 0) this._finishTwoTap(t);
        break;
      case 'three':
        this.pointers.delete(id);
        if (this.pointers.size === 0) {
          if (t - this.threeStart < 400) this._emit('threeTap');
          this.state = 'idle';
        } else {
          this.state = 'threewait';
        }
        break;
      case 'threewait':
        this.pointers.delete(id);
        if (this.pointers.size === 0) {
          if (t - this.threeStart < 500) this._emit('threeTap');
          this.state = 'idle';
        }
        break;
      default: // pinch, drag2, wait, longpressed
        this.pointers.delete(id);
        if (this.pointers.size === 0) this.state = 'idle';
        else if (state === 'pinch' || state === 'drag2') this.state = 'wait';
        break;
    }
    if (this.pointers.size === 0) this.maxPointers = 0;
  }

  _finishTwoTap(t) {
    if (this.state === 'twotap' && t - this.two.t <= TWO_TAP_MAX_MS + 150) {
      if (this.mode === 'touch') {
        this._emit('move', this.two.first.x, this.two.first.y);
        this._emit('click', 4, this.two.first.x, this.two.first.y);
      } else {
        this._emit('click', 4);
      }
    }
    this.state = 'idle';
    this.lastTap = null;
  }

  _longPress() {
    this.timer = null;
    if (this.state !== 'one') return;
    const p = this.pointers.values().next().value;
    if (!p) return;
    this.state = 'longpressed';
    this._emit('longPress', p.sx, p.sy);
    this._emit('move', p.sx, p.sy);
    this._emit('click', 4, p.sx, p.sy);
  }

  cancel() {
    // pointercancel (system gesture, incoming call...) -> release everything
    this.reset();
  }
}
