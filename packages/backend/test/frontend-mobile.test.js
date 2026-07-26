const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadFrontendClass() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../frontend/public/app.js'),
    'utf8',
  );
  const context = {
    URL,
    URLSearchParams,
    clearTimeout,
    console,
    navigator: { maxTouchPoints: 5 },
    setTimeout,
    window: { innerWidth: 390, outerWidth: 390 },
    document: { addEventListener() {} },
  };
  vm.runInNewContext(`${source}\n;globalThis.WebRDPLite = WebRDPLite;`, context);
  return context;
}

function createDisplayHarness() {
  const listeners = new Map();
  const displayElement = {
    style: {},
    tabIndex: -1,
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); },
    focus() { this.focused = true; },
  };
  const cursorElement = { style: {} };
  const display = {
    getElement: () => displayElement,
    getCursorLayer: () => ({ getElement: () => cursorElement }),
    showCursor(value) { this.cursorVisible = value; },
  };
  return { cursorElement, display, displayElement, listeners };
}

test('mobile control restores Touchpad input and dual-finger scrolling', () => {
  const context = loadFrontendClass();
  const harness = createDisplayHarness();
  const sentMouseStates = [];
  class StandardMouse { constructor() { this.mode = 'mouse'; } }
  StandardMouse.Touchpad = class Touchpad { constructor() { this.mode = 'touchpad'; } };
  StandardMouse.Touchscreen = class Touchscreen { constructor() { this.mode = 'touchscreen'; } };
  context.Guacamole = {
    Keyboard: class Keyboard {},
    Mouse: StandardMouse,
  };

  const app = Object.create(context.WebRDPLite.prototype);
  app.guacClient = {
    getDisplay: () => harness.display,
    sendKeyEvent() {},
    sendMouseState(state) { sentMouseStates.push(state); },
  };
  app.hasControl = true;
  app.keyboard = null;
  app.mouse = null;
  app.dualFingerCleanup = null;
  app.rdpContainer = { scrollLeft: 0, scrollTop: 0 };

  app.setupInputListeners();
  assert.equal(app.mouse.mode, 'touchpad');
  assert.equal(harness.display.cursorVisible, true);
  assert.equal(harness.listeners.has('touchstart'), true);
  assert.equal(harness.listeners.has('touchmove'), true);

  app.mouse.onmousemove({ x: 1, y: 2 });
  app.hasControl = false;
  app.mouse.onmousemove({ x: 3, y: 4 });
  assert.equal(sentMouseStates.length, 1);

  harness.listeners.get('touchstart')({
    touches: [{ clientX: 10, clientY: 20 }, { clientX: 30, clientY: 40 }],
  });
  harness.listeners.get('touchmove')({
    touches: [{ clientX: 5, clientY: 10 }, { clientX: 25, clientY: 30 }],
  });
  assert.equal(app.rdpContainer.scrollLeft, 5);
  assert.equal(app.rdpContainer.scrollTop, 10);

  app.dualFingerCleanup();
  assert.equal(harness.listeners.has('touchstart'), false);
  assert.equal(harness.listeners.has('touchmove'), false);
});

test('large touch screens keep direct Touchscreen mode', () => {
  const context = loadFrontendClass();
  context.window.innerWidth = 1024;
  context.window.outerWidth = 1024;
  const harness = createDisplayHarness();
  class StandardMouse { constructor() { this.mode = 'mouse'; } }
  StandardMouse.Touchpad = class Touchpad { constructor() { this.mode = 'touchpad'; } };
  StandardMouse.Touchscreen = class Touchscreen { constructor() { this.mode = 'touchscreen'; } };
  context.Guacamole = { Keyboard: class Keyboard {}, Mouse: StandardMouse };

  const app = Object.create(context.WebRDPLite.prototype);
  app.guacClient = { getDisplay: () => harness.display, sendKeyEvent() {}, sendMouseState() {} };
  app.hasControl = true;
  app.keyboard = null;
  app.mouse = null;
  app.dualFingerCleanup = null;
  app.rdpContainer = { scrollLeft: 0, scrollTop: 0 };

  app.setupInputListeners();
  assert.equal(app.mouse.mode, 'touchscreen');
});

test('mobile permission state uses compact labels and keeps full accessible names', () => {
  const context = loadFrontendClass();
  const classes = new Map();
  const element = () => ({
    classList: {
      toggle(name, enabled) { classes.set(name, enabled); },
    },
    style: {},
    textContent: '',
    title: '',
  });
  const app = Object.create(context.WebRDPLite.prototype);
  app.role = 'controller';
  app.hasControl = false;
  app.connectionStatus = 'disconnected';
  app.takeControlBtn = element();
  app.releaseControlBtn = element();
  app.endShareBtn = element();
  app.resolutionControls = element();
  app.permissionBar = element();
  app.controlState = element();
  app.guacClient = null;

  app.applyPermissionState({ hasControl: false, controlOwner: 'participant' });

  assert.equal(classes.get('has-control'), false);
  assert.equal(app.takeControlBtn.textContent, '抢回');
  assert.equal(app.takeControlBtn.ariaLabel, '抢回控制权');
  assert.equal(app.takeControlBtn.style.display, 'inline-block');
  assert.equal(app.controlState.title, app.controlState.textContent);

  app.role = 'viewer';
  app.applyPermissionState({ hasControl: true, controlOwner: 'participant' });

  assert.equal(classes.get('has-control'), true);
  assert.equal(app.releaseControlBtn.textContent, '归还');
  assert.equal(app.releaseControlBtn.ariaLabel, '结束操作并归还');
  assert.equal(app.releaseControlBtn.style.display, 'inline-block');
  assert.equal(app.endShareBtn.style.display, 'none');

  context.window.innerWidth = 1024;
  app.applyPermissionState({ hasControl: false, controlOwner: 'primary' });
  assert.equal(app.takeControlBtn.textContent, '接管操作');
  assert.equal(app.releaseControlBtn.textContent, '结束操作并归还');
});
