import { BASE_URL, FORWARDED_PREFIX, SITE_ORIGIN } from './env.ts';

export interface Res {
  status: number;
  headers: Headers;
  text: string;
  /** Parsed JSON body, or undefined when the body is empty or not JSON. */
  json: any;
  bytes: number;
  url: string;
}

export interface Req {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  cookie?: string;
  /** Add `Origin` and `X-Requested-With` (the CSRF pair) automatically for unsafe methods. Default true. */
  csrf?: boolean;
  base?: string;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** One HTTP call with no redirect following, as the browser-facing proxy would forward it. */
export async function call(path: string, req: Req = {}): Promise<Res> {
  const method = req.method ?? 'GET';
  const headers: Record<string, string> = {
    'Accept-Encoding': 'gzip',
    'X-Forwarded-Prefix': FORWARDED_PREFIX,
    ...(req.cookie ? { Cookie: req.cookie } : {}),
    ...(UNSAFE.has(method) && req.csrf !== false ? { Origin: SITE_ORIGIN, 'X-Requested-With': 'typhoon-replay' } : {}),
    ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...req.headers,
  };
  const url = /^https?:/.test(path) ? path : `${req.base ?? BASE_URL}${path}`;
  const r = await fetch(url, {
    method,
    headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    redirect: 'manual',
  });
  const text = await r.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: r.status, headers: r.headers, text, json, bytes: Buffer.byteLength(text), url };
}

export const get = (path: string, req: Req = {}) => call(path, { ...req, method: 'GET' });

/** Name=value of the session cookie from a Set-Cookie header, ready for a Cookie header. */
export function sessionCookie(res: Res): string | undefined {
  const set = res.headers.getSetCookie().find((c) => c.startsWith('__Host-tr_session='));
  return set?.split(';')[0];
}

/** Parsed attributes of the session Set-Cookie (lower-cased names). */
export function sessionCookieAttributes(res: Res): Record<string, string> | undefined {
  const set = res.headers.getSetCookie().find((c) => c.startsWith('__Host-tr_session='));
  if (!set) return undefined;
  const [first, ...attrs] = set.split(';').map((s) => s.trim());
  const out: Record<string, string> = { value: (first ?? '').slice('__Host-tr_session='.length) };
  for (const a of attrs) {
    const [k, v] = a.split('=');
    out[(k ?? '').toLowerCase()] = v ?? 'true';
  }
  return out;
}

/** Asserts no `null` anywhere in a JSON value (optional fields are omitted, never null). Returns offending paths. */
export function nullPaths(value: unknown, path = '$'): string[] {
  if (value === null) return [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => nullPaths(v, `${path}[${i}]`));
  if (typeof value === 'object') return Object.entries(value as object).flatMap(([k, v]) => nullPaths(v, `${path}.${k}`));
  return [];
}

/** base64url(JSON) cursor per CONTRACT-GUIDE §5. */
export const encodeCursor = (parts: unknown[]) => Buffer.from(JSON.stringify(parts)).toString('base64url');
export const decodeCursor = (cursor: string): unknown[] => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
