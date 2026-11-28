'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const pubJs = (file) => pathToFileURL(path.resolve(__dirname, '../../../frontend/public/js', file)).href;

test('params: parses query & fragment, preserves password, builds and strips URLs', async () => {
  const params = await import(pubJs('params.js'));

  const q = params.parseLocation({
    search: '?host=10.0.0.1&port=3390&user=admin&password=p%40ss&width=1920&height=1080&title=Win11',
    hash: '',
  });
  assert.equal(q.source, 'query');
  assert.equal(q.params.host, '10.0.0.1');
  assert.equal(q.params.port, '3390');
  assert.equal(q.params.password, 'p@ss');
  assert.equal(q.params.title, 'Win11');
  assert.equal(params.hasCredentials(q.params), true);

  // Fragment overrides query
  const h = params.parseLocation({
    search: '?host=old&user=u1&password=old',
    hash: '#host=new&password=secret',
  });
  assert.equal(h.source, 'hash');
  assert.equal(h.params.host, 'new');
  assert.equal(h.params.user, 'u1');
  assert.equal(h.params.password, 'secret');

  // Password is preserved when updating resolution in URL
  const updated = params.buildUrl('http://localhost:3000/?host=a&user=b&password=secret&width=1024&height=768', {
    width: 1280, height: 720,
  }, 'query');
  assert.ok(updated.includes('password=secret'));
  assert.ok(updated.includes('width=1280'));

  // Fragment updates keep hash source
  const updatedHash = params.buildUrl('http://localhost:3000/#host=a&user=b&password=secret', { width: 1280 }, 'hash');
  assert.ok(updatedHash.includes('#'));
  assert.ok(updatedHash.includes('password=secret'));
  assert.ok(updatedHash.includes('width=1280'));

  // Strip removes connection params but keeps unrelated query params
  const stripped = params.stripConnectionParams('http://localhost:3000/?host=a&user=b&password=secret&foo=bar');
  assert.equal(stripped, 'http://localhost:3000/?foo=bar');
});

test('viewport: fit, height preset, zoomAt anchor stability, pan & clamp', async () => {
  const { Viewport } = await import(pubJs('viewport.js'));
  const vp = new Viewport({ maxFitScale: Infinity });
  vp.setContainer(400, 800);
  vp.setRemote(1024, 768);

  // Default fit: 400 / 1024
  assert.ok(Math.abs(vp.scale - 400 / 1024) < 1e-6);
  assert.equal(vp.overflowing, false);

  // Height preset on portrait mobile overflows horizontally
  vp.applyPreset('height');
  assert.ok(vp.overflowing);
  assert.ok(Math.abs(vp.scale - 800 / 768) < 1e-6);

  // zoomAt keeps the remote point under (cx, cy) stationary when overflowing both axes
  vp.applyPreset('fit');
  const before = vp.toRemote(250, 420, false);
  vp.zoomAt(3, 250, 420);
  const after = vp.toRemote(250, 420, false);
  assert.ok(Math.abs(before.x - after.x) < 1e-4);
  assert.ok(Math.abs(before.y - after.y) < 1e-4);

  // Panning clamps within bounds
  vp.panBy(9999, 9999);
  assert.ok(vp.x <= 0.01);
  vp.panBy(-9999, -9999);
  assert.ok(vp.x >= vp.cw - vp.rw * vp.scale - 0.01);
});

test('gestures: touchpad click, drag, two-finger right-click, pinch vs drag2 conflict', async () => {
  const { GestureRecognizer } = await import(pubJs('gestures.js'));
  const log = [];
  let pendingTimer = null;
  const sink = new Proxy({}, {
    get: (_, name) => (...args) => log.push([name, ...args]),
  });
  const g = new GestureRecognizer(sink, {
    mode: 'touchpad',
    setTimer: (fn) => { pendingTimer = fn; return 1; },
    clearTimer: () => { pendingTimer = null; },
  });

  // Single tap -> left click
  g.down(1, 100, 100, 0);
  g.up(1, 102, 101, 80);
  assert.deepEqual(log, [['click', 1]]);

  // Two-finger tap -> right click, never emits left click
  log.length = 0;
  g.down(1, 100, 100, 500);
  g.down(2, 160, 100, 530);
  g.up(1, 100, 100, 600);
  g.up(2, 160, 100, 620);
  assert.deepEqual(log, [['click', 4]]);

  // Pinch -> locks into pinch; lifting one finger does NOT emit click/drag
  log.length = 0;
  g.down(1, 100, 100, 1000);
  g.down(2, 150, 100, 1010);
  g.move(2, 200, 100, 1050); // +50px distance > PINCH_THRESHOLD
  g.move(2, 240, 100, 1080);
  g.up(2, 240, 100, 1100);
  g.up(1, 100, 100, 1120);
  assert.ok(log.some((e) => e[0] === 'zoom'));
  assert.ok(!log.some((e) => e[0] === 'click' || e[0] === 'down'));

  // Three-finger tap -> threeTap (keyboard toggle)
  log.length = 0;
  g.down(1, 50, 50, 2000);
  g.down(2, 100, 50, 2010);
  g.down(3, 150, 50, 2020);
  g.up(1, 50, 50, 2100);
  g.up(2, 100, 50, 2110);
  g.up(3, 150, 50, 2120);
  assert.deepEqual(log, [['threeTap']]);

  // Direct touch mode: long press -> right click, lifting does not left-click
  log.length = 0;
  g.setMode('touch');
  g.down(1, 80, 90, 3000);
  assert.ok(pendingTimer);
  pendingTimer(); // simulate LONG_PRESS_MS firing
  g.up(1, 80, 90, 3600);
  assert.ok(log.some((e) => e[0] === 'click' && e[1] === 4));
  assert.ok(!log.some((e) => e[0] === 'click' && e[1] === 1));
});
