// Interchangeable keyset cursors (CONTRACT-GUIDE §5): base64url (no padding) of the UTF-8 JSON array
// [1, "<sort>", <keysetValue>, "<lastId>"]. Any backend's cursor works here and ours work there.
import { badCursor } from './problem';

export type KeyKind = 'number' | 'string' | 'timestamp';

export interface Cursor {
  /** The keyset value as text: a number's decimal form (compared as numeric in SQL, so 27 and 27.0 match), or the string. */
  key: string;
  lastId: string;
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function toBase64Url(s: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a cursor made for `sort`; a malformed one, or one made for another sort, is 400 invalid-cursor. */
export function decodeCursor(raw: string | undefined, sort: string, kind: KeyKind): Cursor | undefined {
  if (raw === undefined || raw === '') return undefined;
  let parts: unknown;
  try {
    parts = JSON.parse(utf8.decode(fromBase64Url(raw)));
  } catch {
    throw badCursor('cursor is not base64url JSON');
  }
  if (!Array.isArray(parts) || parts.length !== 4) throw badCursor('cursor has the wrong shape');
  const [version, cursorSort, key, lastId] = parts as unknown[];
  if (version !== 1) throw badCursor('unknown cursor version');
  if (cursorSort !== sort) throw badCursor('cursor was made for another sort');
  let text: string;
  if (kind === 'number') {
    if (typeof key !== 'number' || !Number.isFinite(key)) throw badCursor('cursor keyset must be a number');
    text = String(key);
  } else {
    if (typeof key !== 'string') throw badCursor('cursor keyset must be a string');
    if (kind === 'timestamp' && (!RFC3339.test(key) || Number.isNaN(Date.parse(key))))
      throw badCursor('cursor keyset must be an RFC 3339 timestamp');
    text = key;
  }
  if (typeof lastId !== 'string' || lastId === '' || [...lastId].length > 64) throw badCursor('cursor id must be a string');
  return { key: text, lastId };
}

/** The cursor for the page after the row with keyset value `key` (text from Postgres) and id `lastId`. */
export function encodeCursor(sort: string, kind: KeyKind, key: string, lastId: string): string {
  return toBase64Url(JSON.stringify([1, sort, kind === 'number' ? Number(key) : key, lastId]));
}
