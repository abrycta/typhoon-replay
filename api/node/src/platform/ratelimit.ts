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

/** Behind the edge proxy (proved by X-Edge-Secret) the first X-Forwarded-For entry; otherwise CF-Connecting-IP. */
export function clientIp(rq: Rq): string {
  const h = rq.request.headers;
  const secret = rq.env.TR_EDGE_SECRET;
  const sent = h.get('X-Edge-Secret')?.trim();
  if (secret && sent && sameSecret(sent, secret)) {
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
