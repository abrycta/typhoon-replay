// Query strings, request ids and the browser-visible prefix: the request-side rules every operation shares.

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/**
 * The query string as application/x-www-form-urlencoded UTF-8, read leniently: a chunk with an empty name or broken
 * percent-encoding is dropped, never an error (the contract is a tolerant reader). Values keep their arrival order.
 */
export function parseQuery(raw: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const chunk of raw.split('&')) {
    if (!chunk) continue;
    const eq = chunk.indexOf('=');
    const name = formDecode(eq < 0 ? chunk : chunk.slice(0, eq));
    const value = formDecode(eq < 0 ? '' : chunk.slice(eq + 1));
    if (!name || value === undefined) continue;
    const list = out.get(name);
    if (list) list.push(value);
    else out.set(name, [value]);
  }
  return out;
}

function formDecode(s: string): string | undefined {
  if (!/[%+]/.test(s)) return s;
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x2b) bytes.push(0x20);
    else if (c === 0x25) {
      const hex = s.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return undefined;
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (c < 0x80) bytes.push(c);
    else {
      // Raw non-ASCII (the runtime normally percent-encodes it): re-encode as UTF-8.
      const cp = s.codePointAt(i)!;
      bytes.push(...new TextEncoder().encode(String.fromCodePoint(cp)));
      if (cp > 0xffff) i++;
    }
  }
  try {
    return utf8.decode(new Uint8Array(bytes));
  } catch {
    return undefined;
  }
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;
const HEX = '0123456789ABCDEF';

/** RFC 3986 percent-encoding over UTF-8: unreserved characters literal, every other byte as %XX (uppercase). */
export function percentEncode(s: string): string {
  let out = '';
  for (const b of new TextEncoder().encode(s)) {
    const ch = String.fromCharCode(b);
    out += b < 0x80 && UNRESERVED.test(ch) ? ch : `%${HEX[b >> 4]}${HEX[b & 15]}`;
  }
  return out;
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Echo the inbound X-Request-Id when it is 1–64 chars of [A-Za-z0-9._-]; otherwise a new UUIDv7. */
export function resolveRequestId(inbound: string | null): string {
  return inbound && REQUEST_ID.test(inbound) ? inbound : uuidV7();
}

/** A time-ordered random UUID (RFC 9562). */
export function uuidV7(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let ms = Date.now();
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  b[6] = 0x70 | (b[6]! & 0x0f);
  b[8] = 0x80 | (b[8]! & 0x3f);
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** X-Forwarded-Prefix (e.g. /api/node) when well formed: 1–4 segments of [A-Za-z0-9._-]; otherwise "". */
export function forwardedPrefix(v: string | null): string {
  const p = (v ?? '').replace(/\/$/, '');
  return /^(\/[A-Za-z0-9._-]+){1,4}$/.test(p) ? p : '';
}
