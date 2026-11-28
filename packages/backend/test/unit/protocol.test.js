'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  Parser, encode, encodeUtf16, parseAll, codePointLength, ProtocolError,
} = require('../../src/guac/protocol');

test('encode uses code point lengths', () => {
  assert.equal(encode('key', 65, 1), '3.key,2.65,1.1;');
  assert.equal(encode('name', '😀a'), '4.name,2.😀a;');
  assert.equal(encodeUtf16('name', '😀a'), '4.name,3.😀a;');
  assert.equal(encode(''), '0.;');
  assert.equal(codePointLength('中文😀'), 3);
});

test('parser handles chunk boundaries anywhere', () => {
  const stream = encode('size', 0, 1024, 768) + encode('name', '你好😀世界') + encode('sync', 123) + encode('', 'ping', '42');
  for (let split = 0; split <= stream.length; split++) {
    const p = new Parser();
    const out = [...p.push(stream.slice(0, split)), ...p.push(stream.slice(split))];
    assert.deepEqual(out.map((i) => i.opcode), ['size', 'name', 'sync', ''], `split at ${split}`);
    assert.equal(out[1].args[0], '你好😀世界');
    assert.equal(out.map((i) => i.raw).join(''), stream);
    assert.equal(p.buffer, '');
  }
});

test('utf16 parser accepts guacamole-common-js encoding', () => {
  const s = encodeUtf16('clipboard', '😀😀') + encodeUtf16('key', 1, 0);
  const p = new Parser({ units: 'utf16' });
  const out = p.push(s);
  assert.equal(out[0].args[0], '😀😀');
  assert.equal(out[1].opcode, 'key');
});

test('parser rejects garbage', () => {
  assert.throws(() => parseAll('x.abc;'), ProtocolError);
  assert.throws(() => parseAll('3.abc!'), ProtocolError);
  assert.throws(() => new Parser().push('99999999999999999999999.'), ProtocolError);
  assert.throws(() => parseAll('3.abc,'), ProtocolError); // incomplete
});

test('parser enforces max buffer', () => {
  const p = new Parser({ maxBuffer: 100 });
  assert.throws(() => p.push(`1000.${'a'.repeat(200)}`), ProtocolError);
});
