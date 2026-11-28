'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTarget, normalizeCaps } = require('../../src/session/manager');
const { redact } = require('../../src/logger');

test('normalizeTarget applies defaults of the original project', () => {
  const t = normalizeTarget({ host: '192.168.1.10', user: 'admin', password: 'p' });
  assert.equal(t.port, 3389);
  assert.equal(t.width, 1024);
  assert.equal(t.height, 768);
  assert.equal(t.dpi, 96);
  assert.equal(t.security, 'any');
  assert.equal(t.ignoreCert, true);
});

test('normalizeTarget accepts string numbers from URL params and legacy names', () => {
  const t = normalizeTarget({ hostname: 'pc.local', port: '3390', username: 'u', password: 'x', width: '1921', height: '1080', 'ignore-cert': 'false' });
  assert.equal(t.host, 'pc.local');
  assert.equal(t.port, 3390);
  assert.equal(t.width, 1920); // even
  assert.equal(t.ignoreCert, false);
});

test('normalizeTarget accepts IPv6 in brackets', () => {
  assert.equal(normalizeTarget({ host: '[fe80::1]', user: 'u', password: 'p' }).host, 'fe80::1');
});

test('normalizeTarget rejects missing / invalid input', () => {
  assert.throws(() => normalizeTarget({ host: 'h', user: 'u' }), /host, user, password/);
  assert.throws(() => normalizeTarget({ host: 'bad host', user: 'u', password: 'p' }), /主机/);
  assert.throws(() => normalizeTarget({ host: 'h', user: 'u', password: 'p', port: '70000' }), /port/);
  assert.throws(() => normalizeTarget({ host: 'h', user: 'u', password: 'p', width: '10' }), /width/);
});

test('allowedHosts is enforced', () => {
  assert.throws(() => normalizeTarget({ host: 'evil', user: 'u', password: 'p' }, { allowedHosts: ['good'] }), (e) => e.status === 403);
  assert.equal(normalizeTarget({ host: 'GOOD', user: 'u', password: 'p' }, { allowedHosts: ['good'] }).host, 'GOOD');
});

test('normalizeCaps filters mimetypes', () => {
  const c = normalizeCaps({ audio: ['audio/L16;rate=44100,channels=2', 'evil<script>'], image: ['image/webp', 'audio/L8'] });
  assert.deepEqual(c.audio, ['audio/L16;rate=44100,channels=2']);
  assert.deepEqual(c.image, ['image/webp']);
});

test('logger redacts secrets', () => {
  assert.deepEqual(redact({ password: 'x', a: { resumeToken: 'y', ok: 1 } }), { password: '***', a: { resumeToken: '***', ok: 1 } });
});
