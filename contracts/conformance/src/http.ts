import { BASE_URL, EDGE_HEADERS, FORWARDED_PREFIX } from './env.ts';

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
  /** A Cookie header to send: backends MUST ignore it (contract 2.0.0 has no sessions). */
  cookie?: string;
  base?: string;
}

/** One HTTP call with no redirect following, as the browser-facing proxy would forward it. */
export async function call(path: string, req: Req = {}): Promise<Res> {
  const method = req.method ?? 'GET';
  const headers: Record<string, string> = {
    'Accept-Encoding': 'gzip',
    'X-Forwarded-Prefix': FORWARDED_PREFIX,
    ...EDGE_HEADERS,
    ...(req.cookie ? { Cookie: req.cookie } : {}),
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
