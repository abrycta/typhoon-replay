// Proxy configuration, read from the Pages environment (wrangler.jsonc `vars`, or dashboard overrides).
// Every value is optional and has a safe default, so a missing variable never opens the proxy up.

/** Backends the contract knows about (CONTRACT-GUIDE §2). `mock` never reaches the proxy: MSW serves it in the browser. */
export const KNOWN_IMPLS = ["java", "node", "rust", "go"] as const;
export type Impl = (typeof KNOWN_IMPLS)[number];

/** Optional Workers Rate Limiting binding (not available to Pages Functions today; see edge/README.md). */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** JSON map impl → origin, e.g. `{"java":"https://typhoon-replay-java.onrender.com"}`. A string or an object (wrangler vars allow both). */
  BACKEND_ORIGINS?: string | Record<string, unknown>;
  /** "true" → serve only cached responses (egress guard, set by the nightly bandwidth job). */
  STATIC_MODE?: string | boolean;
  /** How long a GET waits for the origin before answering 503 backend-waking (default 8000 ms). */
  ORIGIN_TIMEOUT_MS?: string | number;
  /** How long a request with a stale cached copy waits for the origin before serving the stale copy (default 1500 ms). */
  STALE_TIMEOUT_MS?: string | number;
  /** Edge stale-if-error window when the origin doesn't send one (default 604800 s = 7 days). */
  STALE_IF_ERROR_S?: string | number;
  /** Per-IP token bucket: sustained requests per minute (default 120) and burst size (default 60). */
  RATE_LIMIT_PER_MINUTE?: string | number;
  RATE_LIMIT_BURST?: string | number;
  /** Optional rate limiting binding; when present it replaces the in-memory bucket. */
  RATE_LIMITER?: RateLimitBinding;
  /** Optional KV namespace with a `static_mode` key ("true"/"false"): flips static mode without a redeploy. */
  EDGE_FLAGS?: KVNamespace;
  /** Pages secret shared with the backends (`TR_EDGE_SECRET`), sent as `X-Edge-Secret` so they trust `X-Forwarded-For`. */
  EDGE_SECRET?: string;
}

export interface Settings {
  origins: Map<string, string>;
  staticMode: boolean;
  originTimeoutMs: number;
  staleTimeoutMs: number;
  staleIfErrorS: number;
  ratePerMinute: number;
  rateBurst: number;
  edgeSecret?: string;
}

const TRUE = new Set(["1", "true", "yes", "on"]);
export const truthy = (v: unknown) => v === true || (typeof v === "string" && TRUE.has(v.trim().toLowerCase()));

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * Parse the origin map. Only absolute http(s) URLs survive, reduced to their origin (scheme://host:port), so a
 * configured path, query or userinfo can never leak into upstream URLs. Unknown impl names are ignored.
 */
export function parseOrigins(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return out;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [impl, value] of Object.entries(obj)) {
    if (!(KNOWN_IMPLS as readonly string[]).includes(impl) || typeof value !== "string") continue;
    let u: URL;
    try {
      u = new URL(value);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    out.set(impl, u.origin);
  }
  return out;
}

let memo: { key: unknown; settings: Settings } | undefined;

export function readSettings(env: Env): Settings {
  // Env objects are stable per isolate, so parse once.
  if (memo?.key === env) return memo.settings;
  const settings: Settings = {
    origins: parseOrigins(env.BACKEND_ORIGINS),
    staticMode: truthy(env.STATIC_MODE),
    originTimeoutMs: num(env.ORIGIN_TIMEOUT_MS, 8000, 100, 100_000),
    staleTimeoutMs: num(env.STALE_TIMEOUT_MS, 1500, 50, 30_000),
    staleIfErrorS: num(env.STALE_IF_ERROR_S, 7 * 86_400, 0, 30 * 86_400),
    ratePerMinute: num(env.RATE_LIMIT_PER_MINUTE, 120, 1, 100_000),
    rateBurst: num(env.RATE_LIMIT_BURST, 60, 1, 100_000),
    edgeSecret: typeof env.EDGE_SECRET === "string" && env.EDGE_SECRET.trim() ? env.EDGE_SECRET.trim() : undefined,
  };
  memo = { key: env, settings };
  return settings;
}

let kvFlag: { value: boolean; until: number } | undefined;

/** Static mode from the env var, or from the optional KV flag (read at most once a minute per isolate). */
export async function isStaticMode(env: Env, settings: Settings, now = Date.now()): Promise<boolean> {
  if (settings.staticMode) return true;
  if (!env.EDGE_FLAGS) return false;
  if (kvFlag && now < kvFlag.until) return kvFlag.value;
  let value = false;
  try {
    value = truthy(await env.EDGE_FLAGS.get("static_mode", { cacheTtl: 60 }));
  } catch {
    value = kvFlag?.value ?? false; // keep the last known value when KV hiccups
  }
  kvFlag = { value, until: now + 60_000 };
  return value;
}

/** Test helper. */
export function __resetEnvMemo() {
  memo = undefined;
  kvFlag = undefined;
}
