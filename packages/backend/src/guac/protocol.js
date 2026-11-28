'use strict';

/**
 * Guacamole protocol helpers.
 *
 * Wire format: LENGTH.VALUE,LENGTH.VALUE,...;
 * LENGTH counts Unicode code points (NOT UTF-16 code units, NOT bytes).
 */

const HIGH_SURROGATE = /[\uD800-\uDBFF]/;

/** Number of Unicode code points in a JS string. */
function codePointLength(str) {
  if (!HIGH_SURROGATE.test(str)) return str.length;
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) i++;
    n++;
  }
  return n;
}

/**
 * Advance `count` code points from `start` within `str`.
 * Returns the UTF-16 index after the last code point, or -1 if `str`
 * does not contain enough data yet.
 */
function advanceCodePoints(str, start, count) {
  let end = start + count;
  if (end > str.length) return -1;
  // Fast path: no surrogate pairs in the slice (base64 image data etc.)
  let slice = str.slice(start, end);
  if (!HIGH_SURROGATE.test(slice)) return end;
  // Slow path: walk code points.
  let i = start;
  let n = 0;
  while (n < count) {
    if (i >= str.length) return -1;
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= str.length) return -1; // pair split across chunks
      i += 2;
    } else {
      i += 1;
    }
    n++;
  }
  return i;
}

/** Encode one instruction (lengths in code points, as guacd expects). */
function encode(opcode, ...args) {
  let out = `${codePointLength(opcode)}.${opcode}`;
  for (const a of args) {
    const v = a === undefined || a === null ? '' : String(a);
    out += `,${codePointLength(v)}.${v}`;
  }
  return out + ';';
}

/**
 * Encode one instruction with lengths in UTF-16 code units. This is what
 * guacamole-common-js 1.5's WebSocketTunnel produces and expects.
 */
function encodeUtf16(opcode, ...args) {
  let out = `${opcode.length}.${opcode}`;
  for (const a of args) {
    const v = a === undefined || a === null ? '' : String(a);
    out += `,${v.length}.${v}`;
  }
  return out + ';';
}

/** True if the string contains characters outside the BMP. */
function hasSurrogates(str) {
  return HIGH_SURROGATE.test(str);
}

class ProtocolError extends Error {}

/**
 * Incremental parser. Feed arbitrary string chunks; complete instructions
 * are returned from `push()` together with their raw text so that the
 * caller can forward them verbatim without re-encoding.
 */
class Parser {
  /**
   * @param {object} [o]
   * @param {number} [o.maxBuffer]
   * @param {'codepoint'|'utf16'} [o.units] how element lengths are counted
   */
  constructor({ maxBuffer = 16 * 1024 * 1024, units = 'codepoint' } = {}) {
    this.buffer = '';
    this.maxBuffer = maxBuffer;
    this.units = units;
  }

  /**
   * @param {string} chunk
   * @returns {{opcode:string,args:string[],raw:string}[]}
   */
  push(chunk) {
    this.buffer += chunk;
    const out = [];
    let pos = 0;
    const buf = this.buffer;
    outer: while (pos < buf.length) {
      const instrStart = pos;
      const elements = [];
      let cursor = pos;
      for (;;) {
        const dot = buf.indexOf('.', cursor);
        if (dot === -1) {
          if (buf.length - cursor > 12) throw new ProtocolError('Invalid element length');
          break outer;
        }
        const lenStr = buf.slice(cursor, dot);
        if (!/^\d{1,10}$/.test(lenStr)) throw new ProtocolError(`Invalid element length "${lenStr.slice(0, 16)}"`);
        const len = Number(lenStr);
        const valueEnd = this.units === 'utf16'
          ? (dot + 1 + len <= buf.length ? dot + 1 + len : -1)
          : advanceCodePoints(buf, dot + 1, len);
        if (valueEnd === -1 || valueEnd >= buf.length) break outer; // need terminator too
        elements.push(buf.slice(dot + 1, valueEnd));
        const term = buf[valueEnd];
        cursor = valueEnd + 1;
        if (term === ';') {
          out.push({ opcode: elements[0], args: elements.slice(1), raw: buf.slice(instrStart, cursor) });
          pos = cursor;
          break;
        }
        if (term !== ',') throw new ProtocolError(`Unexpected terminator "${term}"`);
      }
    }
    this.buffer = buf.slice(pos);
    if (this.buffer.length > this.maxBuffer) throw new ProtocolError('Instruction too large');
    return out;
  }
}

/** Parse a string that must contain only complete instructions. */
function parseAll(str) {
  const p = new Parser();
  const res = p.push(str);
  if (p.buffer.length) throw new ProtocolError('Incomplete instruction');
  return res;
}

/** Guacamole status codes used by the gateway. */
const Status = Object.freeze({
  SUCCESS: 0x0000,
  UNSUPPORTED: 0x0100,
  SERVER_ERROR: 0x0200,
  SERVER_BUSY: 0x0201,
  UPSTREAM_TIMEOUT: 0x0202,
  UPSTREAM_ERROR: 0x0203,
  RESOURCE_NOT_FOUND: 0x0204,
  RESOURCE_CONFLICT: 0x0205,
  RESOURCE_CLOSED: 0x0206,
  UPSTREAM_NOT_FOUND: 0x0207,
  UPSTREAM_UNAVAILABLE: 0x0208,
  SESSION_CONFLICT: 0x0209,
  SESSION_TIMEOUT: 0x020a,
  SESSION_CLOSED: 0x020b,
  CLIENT_BAD_REQUEST: 0x0300,
  CLIENT_UNAUTHORIZED: 0x0301,
  CLIENT_FORBIDDEN: 0x0303,
  CLIENT_TIMEOUT: 0x0308,
  CLIENT_OVERRUN: 0x030d,
  CLIENT_BAD_TYPE: 0x030f,
  CLIENT_TOO_MANY: 0x031d,
});

module.exports = {
  Parser, ProtocolError, encode, encodeUtf16, hasSurrogates, parseAll, codePointLength, advanceCodePoints, Status,
};
