// Per-IP limit with the Workers rate limiting binding (RATE_LIMITER: namespace 1002, 600 requests per 60 s). The edge
// proxy's limit is the first guard; this one protects the public workers.dev URL. TR_RATE_LIMIT_PER_MINUTE=0 turns it
// off (CI). Probes are never limited.
import type { Rq } from './http';
import { Problem } from './problem';

export async function rateLimit(rq: Rq): Promise<Problem | undefined> {
  const { env } = rq;
  if (!env.RATE_LIMITER || env.TR_RATE_LIMIT_PER_MINUTE === '0' || rq.path === '/healthz' || rq.path === '/readyz') return;
  const { success } = await env.RATE_LIMITER.limit({ key: clientIp(rq) });
  if (success) return;
  return new Problem('rate-limited', 'Too many requests from this address; retry later.', [], { 'Retry-After': '60' });
}

/** Whether the request carries the edge proxy's secret (X-Edge-Secret = TR_EDGE_SECRET). */
export function fromEdge(rq: Rq): boolean {
  const secret = rq.env.TR_EDGE_SECRET?.trim();
  const sent = rq.request.headers.get('X-Edge-Secret')?.trim();
  return !!secret && !!sent && sameSecret(sent, secret);
}

const FORBIDDEN = JSON.stringify({
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  detail: "Requests must come through the site's edge proxy.",
});

/**
 * When TR_EDGE_SECRET is set, /v1/* answers only requests that carry it (the edge proxy adds it; it reaches this
 * Worker through a service binding). A direct call to the public workers.dev URL would skip the edge cache and query
 * Neon, so it gets a small 403. /healthz and /readyz stay open; with no secret configured nothing is refused.
 */
export function edgeOnly(rq: Rq): Response | undefined {
  if (!rq.env.TR_EDGE_SECRET?.trim() || !rq.path.startsWith('/v1/') || fromEdge(rq)) return;
  rq.status = 403;
  return new Response(FORBIDDEN, {
    status: 403,
    headers: { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' },
  });
}

/** Behind the edge proxy (proved by X-Edge-Secret) the first X-Forwarded-For entry; otherwise CF-Connecting-IP. */
export function clientIp(rq: Rq): string {
  const h = rq.request.headers;
  if (fromEdge(rq)) {
    const first = (h.get('X-Forwarded-For') ?? '').split(',')[0]!.trim();
    if (first) return first;
  }
  return h.get('CF-Connecting-IP') ?? 'unknown';
}

/** Constant-time string comparison. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
