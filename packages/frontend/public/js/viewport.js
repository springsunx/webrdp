/**
 * Pure viewport math: fit / zoom / pan of the remote display inside the
 * visible container. All coordinates are CSS pixels relative to the container.
 */

export const MAX_SCALE = 4;

export class Viewport {
  constructor({ maxFitScale = Infinity } = {}) {
    this.maxFitScale = maxFitScale; // desktop: 1 (never upscale), touch: Infinity
    this.rw = 0; this.rh = 0; // remote size
    this.cw = 0; this.ch = 0; // container size
    this.zoom = 1; // multiplier relative to fit
    this.x = 0; this.y = 0; // top-left of the display in container coordinates
    this.preset = 'fit';
  }

  get fitScale() {
    if (!this.rw || !this.rh || !this.cw || !this.ch) return 1;
    return Math.min(this.cw / this.rw, this.ch / this.rh, this.maxFitScale);
  }

  get scale() { return this.fitScale * this.zoom; }

  get maxZoom() { return Math.max(1, MAX_SCALE / this.fitScale); }

  setRemote(w, h) {
    const changed = w !== this.rw || h !== this.rh;
    this.rw = w; this.rh = h;
    if (changed) this.applyPreset(this.preset); else this.clamp();
  }

  setContainer(w, h) {
    // keep the point at the container centre stable across rotations
    const cx = this.cw / 2; const cy = this.ch / 2;
    const r = this.cw ? this.toRemote(cx, cy, false) : null;
    this.cw = w; this.ch = h;
    if (this.preset !== 'custom') { this.applyPreset(this.preset); return; }
    this.zoom = Math.min(Math.max(this.zoom, 1), this.maxZoom);
    if (r) {
      this.x = w / 2 - r.x * this.scale;
      this.y = h / 2 - r.y * this.scale;
    }
    this.clamp();
  }

  /** 'fit' whole screen, 'height' fill height (original mobile behaviour), '1' = 1:1 */
  applyPreset(preset) {
    this.preset = preset;
    const fit = this.fitScale;
    if (preset === 'height' && this.rh && this.ch) this.zoom = (this.ch / this.rh) / fit;
    else if (preset === '1') this.zoom = 1 / fit;
    else this.zoom = 1;
    this.zoom = Math.min(Math.max(this.zoom, 1), this.maxZoom);
    // centre
    this.x = (this.cw - this.rw * this.scale) / 2;
    this.y = (this.ch - this.rh * this.scale) / 2;
    this.clamp();
  }

  /** Keep the content inside the container; centre axes that fit. */
  clamp() {
    const dw = this.rw * this.scale; const dh = this.rh * this.scale;
    if (dw <= this.cw) this.x = (this.cw - dw) / 2;
    else this.x = Math.min(0, Math.max(this.cw - dw, this.x));
    if (dh <= this.ch) this.y = (this.ch - dh) / 2;
    else this.y = Math.min(0, Math.max(this.ch - dh, this.y));
  }

  /** Can the view be moved at all (content larger than container)? */
  get overflowing() {
    return this.rw * this.scale > this.cw + 0.5 || this.rh * this.scale > this.ch + 0.5;
  }

  /** Multiply zoom keeping the container point (cx, cy) fixed. */
  zoomAt(factor, cx, cy) {
    const before = this.toRemote(cx, cy, false);
    this.zoom = Math.min(Math.max(this.zoom * factor, 1), this.maxZoom);
    this.preset = this.zoom === 1 ? 'fit' : 'custom';
    this.x = cx - before.x * this.scale;
    this.y = cy - before.y * this.scale;
    this.clamp();
  }

  panBy(dx, dy) {
    this.x += dx; this.y += dy;
    if (this.preset !== 'fit') this.preset = 'custom';
    this.clamp();
  }

  /** Container point -> remote pixel. */
  toRemote(cx, cy, clampToScreen = true) {
    const s = this.scale || 1;
    let x = (cx - this.x) / s; let y = (cy - this.y) / s;
    if (clampToScreen) {
      x = Math.min(Math.max(0, x), Math.max(0, this.rw - 1));
      y = Math.min(Math.max(0, y), Math.max(0, this.rh - 1));
    }
    return { x, y };
  }

  /** Remote pixel -> container point. */
  toContainer(rx, ry) {
    return { x: this.x + rx * this.scale, y: this.y + ry * this.scale };
  }

  /** Pan so that a remote point is visible with a margin (touchpad cursor follow). */
  ensureVisible(rx, ry, margin = 40) {
    const p = this.toContainer(rx, ry);
    let dx = 0; let dy = 0;
    if (p.x < margin) dx = margin - p.x; else if (p.x > this.cw - margin) dx = this.cw - margin - p.x;
    if (p.y < margin) dy = margin - p.y; else if (p.y > this.ch - margin) dy = this.ch - margin - p.y;
    if (dx || dy) { this.x += dx; this.y += dy; this.clamp(); return true; }
    return false;
  }
}
