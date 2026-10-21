// The contract's response rules (CONTRACT-GUIDE §4, §6): identity headers, request ids, Cache-Control per resource
// class, compression, problem documents and 304s. One Rq per request; nothing request-scoped lives in module state.
import impl from '../../impl.json';
import { CONTRACT_VERSION } from '../generated/openapi';
import type { Env } from './env';
import { Problem } from './problem';
import { forwardedPrefix, parseQuery, resolveRequestId } from './query';

export const IDENTITY = { impl: 'node', implVersion: impl.implVersion, contractVersion: CONTRACT_VERSION } as const;

/** One request in flight. */
export class Rq {
  readonly url: URL;
  readonly requestId: string;
  /** Path as served under the backend root, e.g. /v1/storms (escaped form). */
  readonly path: string;
  /** Query string as received (no leading ?). */
  readonly rawQuery: string;
  /** Every value of every well-formed query parameter, in arrival order. */
  readonly query: Map<string, string[]>;
  /** If-None-Match, with repeated header lines joined into one list. */
  readonly ifNoneMatch: string;
  readonly started = Date.now();
  status = 0;
  /** Headers that also survive on problem responses. */
  readonly sticky = new Headers();

  constructor(
    readonly request: Request,
    readonly env: Env,
  ) {
    this.url = new URL(request.url);
    this.path = this.url.pathname;
    this.rawQuery = this.url.search.slice(1);
    this.query = parseQuery(this.rawQuery);
    this.requestId = resolveRequestId(request.headers.get('X-Request-Id'));
    // The Fetch API joins repeated header lines with ", "; a list split over several lines is one list again.
    this.ifNoneMatch = request.headers.get('If-None-Match') ?? '';
  }

  get method(): string {
    return this.request.method;
  }

  /** The problem `instance`: path and query as received. */
  instance(): string {
    return this.rawQuery ? `${this.path}?${this.rawQuery}` : this.path;
  }

  /** The browser-visible base for Link headers: TR_SITE_ORIGIN + X-Forwarded-Prefix (CONTRACT-GUIDE §5). */
  publicBase(): string {
    return (this.env.TR_SITE_ORIGIN ?? '').replace(/\/$/, '') + forwardedPrefix(this.request.headers.get('X-Forwarded-Prefix'));
  }

  acceptsGzip(): boolean {
    for (const part of (this.request.headers.get('Accept-Encoding') ?? '').split(',')) {
      const [coding = '', ...params] = part.trim().split(';');
      const c = coding.trim().toLowerCase();
      if (c === 'gzip' || c === '*') {
        const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
        return !q || Number(q.slice(2)) > 0;
      }
    }
    return false;
  }
}

/** Cache-Control by resource class (CONTRACT-GUIDE §6). */
export const CACHE = {
  catalogue: 'public, max-age=300, stale-while-revalidate=86400',
  meta: 'public, max-age=60',
  live: 'no-cache',
  noStore: 'no-store',
  notFound: 'public, max-age=60',
} as const;

/** Storms, places, hits and place search. */
export const isCatalogue = (path: string) =>
  path === '/v1/storms' || path.startsWith('/v1/storms/') || path.startsWith('/v1/places/') || path === '/v1/hits';

export function cacheControlFor(path: string): string {
  if (path === '/healthz' || path === '/readyz') return CACHE.noStore;
  if (path === '/v1/meta' || path === '/v1/openapi.json') return CACHE.meta;
  if (path.startsWith('/v1/live/')) return CACHE.live;
  if (isCatalogue(path)) return CACHE.catalogue;
  return CACHE.noStore;
}

/** Errors are no-store, except a 404 on a catalogue read. */
export function cacheControlForError(status: number, method: string, path: string): string {
  return status === 404 && (method === 'GET' || method === 'HEAD') && isCatalogue(path) ? CACHE.notFound : CACHE.noStore;
}

/** The §4 headers plus a Cache-Control. */
export function standardHeaders(rq: Rq, cacheControl: string): Headers {
  const h = new Headers({
    'X-Backend-Impl': IDENTITY.impl,
    'X-Backend-Version': IDENTITY.implVersion,
    'X-Contract-Version': IDENTITY.contractVersion,
    'X-Request-Id': rq.requestId,
    Vary: 'Accept-Encoding',
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '0',
  });
  rq.sticky.forEach((v, k) => h.set(k, v));
  return h;
}

/** Bodies over 1 KB are compressed when the client accepts gzip (CONTRACT-GUIDE §4). */
const GZIP_MIN = 1024;
/** CONTRACT-GUIDE §11: JSON responses stay under 64 KB uncompressed at the maximum page size. */
const RESPONSE_BUDGET = 64 * 1024;

export const JSON_TYPE = 'application/json; charset=utf-8';

function respond(rq: Rq, status: number, headers: Headers, body: string | null): Response {
  rq.status = status;
  if (body !== null && body.length > GZIP_MIN && rq.acceptsGzip()) {
    // The Workers runtime gzips the body when the response declares Content-Encoding (and the edge stores it decoded).
    headers.set('Content-Encoding', 'gzip');
  }
  // Only the contract bundle may exceed the budget; anything else is a bug worth seeing in the logs.
  if (body !== null && body.length > RESPONSE_BUDGET && rq.path !== '/v1/openapi.json') {
    log('warn', 'response over the 64 KB budget', rq, { bytes: body.length });
  }
  return new Response(status === 204 || status === 304 || rq.method === 'HEAD' ? null : body, { status, headers });
}

/** A successful response. */
export function send(rq: Rq, status: number, body: string, contentType = JSON_TYPE, extra: Record<string, string> = {}): Response {
  const h = standardHeaders(rq, cacheControlFor(rq.path));
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  h.set('Content-Type', contentType);
  return respond(rq, status, h, body);
}

/** 304 for a matching If-None-Match: same ETag and Cache-Control, no body. */
export function notModified(rq: Rq, etag: string): Response {
  const h = standardHeaders(rq, cacheControlFor(rq.path));
  h.set('ETag', etag);
  return respond(rq, 304, h, null);
}

/** A problem document: only the §4 headers, the sticky ones and the problem's own headers. */
export function fail(rq: Rq, p: Problem): Response {
  const h = standardHeaders(rq, cacheControlForError(p.status, rq.method, rq.path));
  for (const [k, v] of Object.entries(p.headers)) h.set(k, v);
  h.set('Content-Type', 'application/problem+json');
  return respond(rq, p.status, h, p.body(rq.instance(), rq.requestId));
}

/** One JSON object per line (CONTRACT-GUIDE §11); never Cookie or Authorization. */
export function log(level: 'info' | 'warn' | 'error', msg: string, rq: Rq, extra: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      requestId: rq.requestId,
      impl: IDENTITY.impl,
      method: rq.method,
      path: rq.path,
      status: rq.status,
      durMs: Date.now() - rq.started,
      ...extra,
    }),
  );
}
