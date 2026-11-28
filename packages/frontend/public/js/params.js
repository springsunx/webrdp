/**
 * Connection parameters from the URL.
 *
 * Compatibility contract (unchanged from the original project):
 *  - query parameters: host, port, user, password, width, height, title, auto
 *  - fragment parameters (#host=...&password=...) are accepted as well and
 *    override query parameters with the same name
 *  - the password in the URL is NEVER removed or masked automatically; it is
 *    what makes refresh / reconnect work for bookmarked links
 *  - after a form login the parameters are written into the URL (as before)
 *
 * Additional optional parameters: domain, dpi, security, ignoreCert, name,
 * mode (touchpad|touch), zoom (fit|height|1).
 */

export const KNOWN = ['host', 'port', 'user', 'password', 'width', 'height', 'title', 'auto',
  'domain', 'dpi', 'security', 'ignoreCert', 'name', 'mode', 'zoom'];

const ALIASES = { hostname: 'host', username: 'user', 'ignore-cert': 'ignoreCert' };

function readPairs(str, into) {
  if (!str) return;
  const sp = new URLSearchParams(str);
  for (const [k0, v] of sp) {
    const k = ALIASES[k0] || k0;
    if (KNOWN.includes(k)) into[k] = v;
  }
}

/**
 * @param {{search:string, hash:string}} loc
 * @returns {{params:object, source:'query'|'hash'|'none'}}
 */
export function parseLocation(loc) {
  const fromQuery = {};
  const fromHash = {};
  readPairs(loc.search.replace(/^\?/, ''), fromQuery);
  const hash = loc.hash.replace(/^#/, '');
  if (hash.includes('=')) readPairs(hash, fromHash);
  const params = { ...fromQuery, ...fromHash };
  let source = 'none';
  if (Object.keys(fromHash).some((k) => ['host', 'user', 'password'].includes(k))) source = 'hash';
  else if (Object.keys(fromQuery).length) source = 'query';
  return { params, source };
}

export function hasCredentials(p) {
  return !!(p.host && p.user && p.password);
}

export function isAuto(p) {
  return p.auto === 'true' || p.auto === '1';
}

/**
 * Write connection parameters back to the URL (form login, resolution
 * change). Keeps the parameters where they came from (query or fragment)
 * and preserves unrelated parameters.
 * @returns {string} new href
 */
export function buildUrl(href, values, source = 'query') {
  const url = new URL(href);
  if (source === 'hash') {
    const sp = new URLSearchParams(url.hash.replace(/^#/, ''));
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined || v === null || v === '') sp.delete(k); else sp.set(k, String(v));
    }
    url.hash = sp.toString();
  } else {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined || v === null || v === '') url.searchParams.delete(k); else url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/** URL with all connection parameters removed ("返回" button, as before). */
export function stripConnectionParams(href) {
  const url = new URL(href);
  for (const k of KNOWN) url.searchParams.delete(k);
  for (const k of Object.keys(ALIASES)) url.searchParams.delete(k);
  const sp = new URLSearchParams(url.hash.replace(/^#/, ''));
  let touched = false;
  for (const k of [...KNOWN, ...Object.keys(ALIASES)]) if (sp.has(k)) { sp.delete(k); touched = true; }
  if (touched) url.hash = sp.toString();
  return url.toString().replace(/#$/, '');
}

/** Resolution heuristic of the original project (mobile keeps a desktop size). */
export function optimalResolution({ innerWidth, containerWidth = 0, containerHeight = 0, screenWidth, screenHeight, mobile }) {
  if (mobile) {
    return innerWidth < 400 ? { width: 800, height: 600 } : { width: 1024, height: 768 };
  }
  let width; let height;
  if (containerWidth > 100 && containerHeight > 100) {
    width = containerWidth; height = containerHeight;
  } else if (screenHeight > screenWidth) {
    width = 800; height = 600;
  } else {
    width = 1024; height = 768;
  }
  width = Math.max(800, Math.floor(width / 8) * 8);
  height = Math.max(600, Math.floor(height / 8) * 8);
  return { width, height };
}
