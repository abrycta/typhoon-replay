// Per-IP rate limiting, in two layers:
// 1. An in-memory token bucket per isolate (burst 60, 120/min): stops a single client looping on the API. It is
//    best-effort: each isolate and each data centre counts separately, and isolates are recycled.
// 2. When bound, the RATE_LIMITER service (the replay-ratelimit Worker, edge/limiter/), which holds the free Workers
//    Rate Limiting binding that Pages Functions can't declare: one count per IP and Cloudflare location across all
//    isolates (240/min), so a client can't spread a flood over isolates. If it errors, the bucket alone decides.

import type { Env, Settings } from "./env";

export type RateDecision = { ok: true } | { ok: false; retryAfterS: number };

interface Bucket {
  tokens: number;
  at: number;
}

const MAX_KEYS = 10_000;
const buckets = new Map<string, Bucket>();

export function takeToken(key: string, perMinute: number, burst: number, now = Date.now()): RateDecision {
  const ratePerMs = perMinute / 60_000;
  const prev = buckets.get(key);
  let tokens = prev ? Math.min(burst, prev.tokens + (now - prev.at) * ratePerMs) : burst;
  if (prev) buckets.delete(key); // re-insert below: Map order doubles as LRU order
  if (tokens < 1) {
    buckets.set(key, { tokens, at: now });
    return { ok: false, retryAfterS: Math.max(1, Math.ceil((1 - tokens) / ratePerMs / 1000)) };
  }
  tokens -= 1;
  buckets.set(key, { tokens, at: now });
  if (buckets.size > MAX_KEYS) buckets.delete(buckets.keys().next().value!);
  return { ok: true };
}

export async function checkRate(env: Env, settings: Settings, ip: string): Promise<RateDecision> {
  const local = takeToken(ip, settings.ratePerMinute, settings.rateBurst);
  if (!local.ok || !env.RATE_LIMITER) return local;
  try {
    const res = await env.RATE_LIMITER.fetch(`https://replay-ratelimit/limit?key=${encodeURIComponent(ip)}`);
    return res.status === 429 ? { ok: false, retryAfterS: 60 } : local;
  } catch {
    return local; // the global limiter is an extra layer; never fail closed on it
  }
}

/** Test helper. */
export function __resetBuckets() {
  buckets.clear();
}
