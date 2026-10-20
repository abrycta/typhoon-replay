// Per-IP rate limiting. Pages Functions can't declare the Workers Rate Limiting binding, so the default is an
// in-memory token bucket per isolate: best-effort (each isolate and each data centre counts separately, and
// isolates are recycled), but enough to stop a single client looping on the API and draining Render egress.

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
  if (env.RATE_LIMITER) {
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      return success ? { ok: true } : { ok: false, retryAfterS: 60 };
    } catch {
      /* fall back to the local bucket */
    }
  }
  return takeToken(ip, settings.ratePerMinute, settings.rateBurst);
}

/** Test helper. */
export function __resetBuckets() {
  buckets.clear();
}
