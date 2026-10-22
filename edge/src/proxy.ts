// Same-origin edge proxy: /api/{impl}/* → the impl's origin (CONTRACT-GUIDE §2), with edge caching of public
// reads, cold-start handling, SSE pass-through, per-IP rate limiting and the static-mode emergency switch.
// Behaviour and free-plan notes: edge/README.md.

import { cacheKey, type Entry, fromEntry, lookup, refresh, store } from "./cache";
import { type Env, isStaticMode, KNOWN_IMPLS, readSettings, type Settings } from "./env";
import {
  clientIp,
  downstreamHeaders,
  type EdgeProblemCode,
  etagMatches,
  hasSessionCookie,
  problem,
  requestIdFor,
  upstreamHeaders,
} from "./http";
import { checkRate } from "./ratelimit";

export type { Env } from "./env";

export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

export type EdgeCacheLabel = "HIT" | "MISS" | "STALE" | "BYPASS";

export const MAX_BODY_BYTES = 64 * 1024;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const SSE_PATH = "/v1/live/stream";
const HEALTH_PATHS = new Set(["/healthz", "/readyz"]);
/** Health probes answer quickly either way: a sleeping origin gets a "waking" answer after 2.5 s instead of a long hang. */
const HEALTH_TIMEOUT_MS = 2500;
/** Unsafe methods are never cut short with "waking" (the write may still happen); they wait this long at most. */
const UNSAFE_TIMEOUT_MS = 100_000;
/** Background work is capped at 30 s after the response by the runtime (waitUntil). */
const BACKGROUND_TIMEOUT_MS = 29_000;
/** Render cold starts take about a minute; this is the client's hint for when to retry. */
const WAKE_RETRY_AFTER_S = 20;
const STATIC_RETRY_AFTER_S = 3600;
const WAKE_DEDUPE_MS = 15_000;
/** After a backend says its database is still waking, retry once in the background after this long. */
const UPSTREAM_WAKE_RETRY_MS = 5_000;
/**
 * Paths revalidated with a plain GET. Before contract 2.0.1 `/v1/meta`'s ETag (`c{contract}-{impl}-{implVersion}`)
 * ignored the `datasetVersion` its body carries, so a conditional revalidation could get a 304 and keep a stale body.
 * 2.0.1 adds `-d{datasetVersion}` (CONTRACT-GUIDE §6); this stays for backends that predate it. The body is a few
 * hundred bytes.
 */
const UNCONDITIONAL_REVALIDATION = new Set(["/v1/meta"]);

/** Paths a backend serves at its root (CONTRACT-GUIDE §2). Anything else never leaves the edge. */
export function allowedPath(rest: string): boolean {
  return HEALTH_PATHS.has(rest) || rest === "/v1" || rest.startsWith("/v1/");
}

/** Paths whose responses depend on the session: never looked up or stored, whatever their headers say. */
const PRIVATE_PREFIXES = ["/v1/me/", "/v1/auth/", "/v1/_test/", "/v1/alerts/"];

const lastWake = new Map<string, number>();

export async function handleProxy(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  const t0 = Date.now();
  const requestId = requestIdFor(request);
  const url = new URL(request.url);
  const instance = url.pathname + url.search;
  const m = /^\/api\/([^/]+)(\/.*)?$/.exec(url.pathname);
  const impl = m?.[1] ?? "";
  const rest = m?.[2] ?? "/";

  const done = (response: Response, label: EdgeCacheLabel, stale?: string) => decorate(response, { label, impl, requestId, t0, stale });
  const fail = (code: EdgeProblemCode, extra: { detail?: string; retryAfter?: number } = {}) =>
    done(problem(code, { requestId, instance, ...extra }), "BYPASS");

  if (!m) return fail("not-found");
  if (!(KNOWN_IMPLS as readonly string[]).includes(impl)) return fail("unknown-backend", { detail: `no backend named "${impl.slice(0, 32)}"` });
  if (!allowedPath(rest)) return fail("not-found");
  if (!METHODS.has(request.method)) return fail("method-not-allowed");

  const settings = readSettings(env);
  activeBindings = settings.bindings;
  const rate = await checkRate(env, settings, clientIp(request));
  if (!rate.ok) return fail("rate-limited", { retryAfter: rate.retryAfterS });

  const origin = settings.origins.get(impl);
  if (!origin) return fail("backend-not-deployed", { detail: `the ${impl} backend is not configured on this site` });

  const target = new URL(origin);
  target.pathname = rest;
  target.search = url.search;
  if (target.origin !== origin) return fail("not-found"); // defence in depth: never another host

  const safe = request.method === "GET" || request.method === "HEAD";
  const isSse = rest === SSE_PATH;
  const isHealth = HEALTH_PATHS.has(rest);
  const candidate =
    safe &&
    rest.startsWith("/v1/") &&
    !isSse &&
    rest !== "/v1/me" && !PRIVATE_PREFIXES.some((p) => rest.startsWith(p)) &&
    !hasSessionCookie(request) &&
    !request.headers.has("Authorization");

  const cache = caches.default;
  const key = candidate ? cacheKey(request) : undefined;

  // --- egress guard: serve only what is already cached ---
  if (await isStaticMode(env, settings)) {
    if (key) {
      const entry = await lookup(cache, key, settings.staleIfErrorS);
      if (entry) return done(fromEntry(entry, request), entry.state === "fresh" ? "HIT" : "STALE", entry.state === "fresh" ? undefined : "static-mode");
    }
    return fail("static-mode", { retryAfter: STATIC_RETRY_AFTER_S, detail: "the API is resting to stay within its free bandwidth; cached and static data only" });
  }

  // --- request body: capped at 64 KB (CONTRACT-GUIDE §11) ---
  let body: ArrayBuffer | undefined;
  if (!safe) {
    const read = await readCapped(request);
    if (read === "too-large") return fail("payload-too-large", { detail: `request bodies are limited to ${MAX_BODY_BYTES} bytes` });
    body = read;
  }

  const wake = () => {
    const now = Date.now();
    if (now - (lastWake.get(impl) ?? 0) < WAKE_DEDUPE_MS) return;
    lastWake.set(impl, now);
    ctx.waitUntil(
      fetchWithTimeout(`${origin}/healthz`, { headers: { "X-Request-Id": requestId, "User-Agent": "typhoon-replay-edge/wake" } }, BACKGROUND_TIMEOUT_MS)
        .then((r) => r.body?.cancel())
        .catch(() => undefined),
    );
  };

  // --- not cacheable: straight pass-through (unsafe methods, SSE, health, signed-in or private reads) ---
  if (!key) {
    const timeout = !safe ? UNSAFE_TIMEOUT_MS : isHealth ? Math.min(HEALTH_TIMEOUT_MS, settings.originTimeoutMs) : settings.originTimeoutMs;
    const init: RequestInit = { method: request.method, headers: upstreamHeaders(request, { impl, requestId, edgeSecret: settings.edgeSecret }), body, redirect: "manual" };
    const r = await raceOrigin(target, init, timeout, true);
    if (r.kind === "timeout") {
      if (!safe) return fail("gateway-timeout");
      wake();
      return fail("backend-waking", { retryAfter: WAKE_RETRY_AFTER_S, detail: "free hosting sleeps when idle; it takes about a minute to wake" });
    }
    if (r.kind === "error") return fail("bad-gateway");
    return done(await passthrough(r.response, isSse, requestId), "BYPASS");
  }

  // --- cacheable public read ---
  const entry = await lookup(cache, key, settings.staleIfErrorS);
  if (entry?.state === "fresh") return done(fromEntry(entry, request), "HIT");
  const validator = entry && !UNCONDITIONAL_REVALIDATION.has(rest) ? entry.etag : null;

  if (entry?.state === "revalidate") {
    // stale-while-revalidate: answer now, refresh in the background (which also wakes a sleeping backend).
    ctx.waitUntil(revalidate(cache, key, entry, validator, target, request, impl, requestId, settings).catch(() => undefined));
    return done(fromEntry(entry, request), "STALE", "revalidating");
  }

  if (entry && entry.state === "if-error") {
    // stale-if-error: give the origin a short chance; otherwise serve the stale copy and finish in the background.
    const keep = entry.response.clone();
    const pending = originFetch(target, request, impl, requestId, BACKGROUND_TIMEOUT_MS, validator, settings.edgeSecret);
    const r = await raceTimer(pending, settings.staleTimeoutMs);
    if (r && r.kind === "response" && !isGatewayError(r.response)) {
      const fresh = await settle(cache, key, keep, r.response, settings);
      if (fresh) return done(fromEntry(fresh, request), "MISS");
      if (r.response.status !== 304) return done(await passthrough(r.response, false, requestId), "MISS");
      // 304 that could not refresh the entry: fall through to the stale copy.
    }
    if (!r) {
      ctx.waitUntil(pending.then((late) => (late.kind === "response" ? settle(cache, key, keep, late.response, settings) : undefined)).catch(() => undefined));
    } else if (r.kind === "response") {
      void r.response.body?.cancel();
    }
    return done(fromEntry(entry, request), "STALE", "if-error");
  }

  // Miss: fetch without the client's validators so a full copy can be stored, then answer 304 here if it matches.
  const pending = originFetch(target, request, impl, requestId, BACKGROUND_TIMEOUT_MS, null, settings.edgeSecret);
  const r = await raceTimer(pending, settings.originTimeoutMs);
  if (!r) {
    // Cold start. The request keeps going in the background: it wakes the backend and fills the cache.
    lastWake.set(impl, Date.now());
    ctx.waitUntil(
      pending
        .then(async (late) => {
          if (late.kind !== "response") return;
          if (request.method === "GET") await store(cache, key, late.response, settings.staleIfErrorS);
          else await late.response.body?.cancel();
        })
        .catch(() => undefined),
    );
    return fail("backend-waking", { retryAfter: WAKE_RETRY_AFTER_S, detail: "free hosting sleeps when idle; it takes about a minute to wake" });
  }
  if (r.kind === "error") return fail("bad-gateway");
  const response = r.response;
  const upstreamWaking = await wakingRetryAfter(response);
  if (upstreamWaking !== undefined) {
    // The backend is up but its database is still resuming (Neon scales to zero): the same "waking" answer as a
    // sleeping Render service, plus one background retry that fills the cache once the database is back.
    void response.body?.cancel();
    if (request.method === "GET") ctx.waitUntil(retryWaking(cache, key, target, request, impl, requestId, settings).catch(() => undefined));
    return fail("backend-waking", { retryAfter: upstreamWaking, detail: "the backend is waking its database; retry shortly" });
  }
  if (request.method === "GET") {
    const toStore = response.clone();
    ctx.waitUntil(store(cache, key, toStore, settings.staleIfErrorS).catch(() => undefined));
  }
  if (response.status === 200 && etagMatches(request.headers.get("If-None-Match"), response.headers.get("ETag"))) {
    const headers = downstreamHeaders(response.headers);
    for (const h of ["Content-Type", "Content-Length", "Content-Encoding"]) headers.delete(h);
    void response.body?.cancel();
    return done(new Response(null, { status: 304, headers }), "MISS");
  }
  return done(await passthrough(response, false, requestId), "MISS");
}

// ---------------------------------------------------------------------------------------------------------------

type FetchResult = { kind: "response"; response: Response } | { kind: "error"; error: unknown };
type OriginResult = FetchResult | { kind: "timeout" };

/** Origin -> service binding of the current environment (stable per isolate: Env objects are). */
let activeBindings: Map<string, Fetcher> = new Map();

/** fetch() to a backend: through its service binding when it has one (Workers backends), else over the network. */
function upstreamFetch(input: string | URL, init: RequestInit): Promise<Response> {
  const binding = activeBindings.get(new URL(input).origin);
  return binding ? binding.fetch(input.toString(), init) : fetch(input, init);
}

function fetchWithTimeout(input: string | URL, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return upstreamFetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

/** Fetch with a deadline for the response headers; the body (e.g. an SSE stream) is not limited. */
async function raceOrigin(target: URL, init: RequestInit, ms: number, abortOnTimeout: boolean): Promise<OriginResult> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (abortOnTimeout) ctrl.abort();
  }, ms);
  try {
    const response = await upstreamFetch(target, { ...init, signal: ctrl.signal });
    return timedOut ? { kind: "timeout" } : { kind: "response", response };
  } catch (error) {
    return timedOut ? { kind: "timeout" } : { kind: "error", error };
  } finally {
    clearTimeout(timer);
  }
}

/** A GET/HEAD to the origin for a cacheable read; resolves (never rejects) within `ms`. */
async function originFetch(target: URL, request: Request, impl: string, requestId: string, ms: number, etag: string | null, edgeSecret?: string): Promise<FetchResult> {
  const headers = upstreamHeaders(request, { impl, requestId, dropConditional: true, edgeSecret });
  if (etag) headers.set("If-None-Match", etag);
  try {
    const response = await fetchWithTimeout(target, { method: request.method, headers, redirect: "manual" }, ms);
    return { kind: "response", response };
  } catch (error) {
    return { kind: "error", error };
  }
}

/** Resolve with the result, or undefined if `ms` passes first (the promise keeps running). */
function raceTimer<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([p, t]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function isGatewayError(r: Response) {
  return r.status >= 500;
}

/** Apply a revalidation answer to the cache; returns the new entry when the cache now holds a fresh copy. */
async function settle(cache: Cache, key: Request, cached: Response, response: Response, settings: Settings): Promise<Entry | undefined> {
  let stored = false;
  if (response.status === 304) {
    stored = await refresh(cache, key, cached, response, settings.staleIfErrorS);
  } else if (response.status < 500) {
    stored = await store(cache, key, response.clone(), settings.staleIfErrorS);
    if (!stored) return undefined;
  } else {
    await response.body?.cancel();
    return undefined;
  }
  if (!stored) return undefined;
  return lookup(cache, key, settings.staleIfErrorS);
}

const revalidating = new Set<string>();

async function revalidate(cache: Cache, key: Request, entry: Entry, etag: string | null, target: URL, request: Request, impl: string, requestId: string, settings: Settings) {
  if (revalidating.has(key.url)) return;
  revalidating.add(key.url);
  try {
    const keep = entry.response.clone();
    const r = await originFetch(target, request, impl, requestId, BACKGROUND_TIMEOUT_MS, etag, settings.edgeSecret);
    if (r.kind === "response") await settle(cache, key, keep, r.response, settings);
  } finally {
    revalidating.delete(key.url);
  }
}

/**
 * A backend's own 503 problem saying it can't serve yet (`not-ready`: its database is unreachable, e.g. Neon resuming;
 * or `backend-waking`): returns the Retry-After to use, otherwise undefined.
 */
async function wakingRetryAfter(response: Response): Promise<number | undefined> {
  if (response.status !== 503 || !(response.headers.get("Content-Type") ?? "").includes("json")) return undefined;
  try {
    const { code } = (await response.clone().json()) as { code?: unknown };
    if (code !== "not-ready" && code !== "backend-waking") return undefined;
  } catch {
    return undefined;
  }
  return Number(response.headers.get("Retry-After") ?? "") || WAKE_RETRY_AFTER_S;
}

async function retryWaking(cache: Cache, key: Request, target: URL, request: Request, impl: string, requestId: string, settings: Settings) {
  if (revalidating.has(key.url)) return;
  revalidating.add(key.url);
  try {
    await new Promise((resolve) => setTimeout(resolve, UPSTREAM_WAKE_RETRY_MS));
    const r = await originFetch(target, request, impl, requestId, BACKGROUND_TIMEOUT_MS - UPSTREAM_WAKE_RETRY_MS, null, settings.edgeSecret);
    if (r.kind === "response") await store(cache, key, r.response, settings.staleIfErrorS);
  } finally {
    revalidating.delete(key.url);
  }
}

/** Render's page for a suspended service (503, "This service has been suspended by its owner."). */
const SUSPENDED = /suspended/i;

/** Seconds until the next calendar month (UTC): Render's free instance hours reset monthly. */
export function secondsToNextMonth(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * Hand the origin response to the client. The body stream is passed through untouched (no buffering, so SSE
 * frames arrive as they are written). Render's own 502/503/504 pages become problem+json so the SPA can read them:
 * a suspended service (the budget guard pauses it when the month's free hours run low, `scripts/budget-check.mjs`)
 * is `backend-paused` until next month; anything else is `backend-unavailable`.
 */
async function passthrough(response: Response, isSse: boolean, requestId: string): Promise<Response> {
  const ct = response.headers.get("Content-Type") ?? "";
  if ([502, 503, 504].includes(response.status) && !ct.includes("json")) {
    const page = response.status === 503 ? (await response.text().catch(() => "")).slice(0, 4096) : (void response.body?.cancel(), "");
    if (SUSPENDED.test(page)) {
      return problem("backend-paused", { requestId, retryAfter: secondsToNextMonth(), detail: "this backend is paused until next month to stay within its free hosting hours" });
    }
    return problem("backend-unavailable", { requestId, retryAfter: Number(response.headers.get("Retry-After") ?? "") || WAKE_RETRY_AFTER_S });
  }
  const headers = downstreamHeaders(response.headers);
  if (isSse) {
    headers.delete("Content-Length");
    headers.set("Cache-Control", headers.get("Cache-Control") ?? "no-cache");
    headers.set("X-Accel-Buffering", "no");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function decorate(response: Response, o: { label: EdgeCacheLabel; impl: string; requestId: string; t0: number; stale?: string }): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Edge-Cache", o.label);
  if (o.stale) headers.set("X-Edge-Stale", o.stale);
  if (o.impl) headers.set("X-Edge-Route", o.impl);
  headers.set("X-Request-Id", o.requestId);
  headers.append("Server-Timing", `edge;dur=${Date.now() - o.t0}`);
  const vary = headers.get("Vary");
  if (vary) headers.set("Vary", dedupeTokens(vary));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Render's front adds its own `Vary: Accept-Encoding` next to the one the backend already sends, so the Go origin
 * answers `Vary: Accept-Encoding, Accept-Encoding`. Keep one of each token (case-insensitive, first spelling wins).
 */
export function dedupeTokens(value: string): string {
  const seen = new Map<string, string>();
  for (const raw of value.split(",")) {
    const token = raw.trim();
    if (token && !seen.has(token.toLowerCase())) seen.set(token.toLowerCase(), token);
  }
  return [...seen.values()].join(", ");
}

async function readCapped(request: Request): Promise<ArrayBuffer | undefined | "too-large"> {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return "too-large";
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return "too-large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

/** Test helper. */
export function __resetProxyState() {
  lastWake.clear();
  revalidating.clear();
}
