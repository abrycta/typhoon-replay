// Edge cache for public API reads, on the Workers Cache API (caches.default).
//
// The Cache API stores and returns responses but implements neither stale-while-revalidate nor stale-if-error
// (https://developers.cloudflare.com/workers/runtime-apis/cache/), so freshness is computed here: each entry is
// stored with a long edge TTL (fresh + max(stale-while-revalidate, stale-if-error)), the time it was stored, and
// the origin's own Cache-Control, which is restored when the entry is served. The cache is per data centre.

import { etagMatches } from "./http";

export interface Directives {
  public: boolean;
  private: boolean;
  noStore: boolean;
  noCache: boolean;
  maxAge?: number;
  sMaxAge?: number;
  swr?: number;
  sie?: number;
}

export function parseCacheControl(value: string | null): Directives {
  const d: Directives = { public: false, private: false, noStore: false, noCache: false };
  if (!value) return d;
  for (const part of value.split(",")) {
    const [rawName, rawValue] = part.split("=", 2) as [string, string | undefined];
    const name = rawName.trim().toLowerCase();
    const n = rawValue === undefined ? NaN : Number(rawValue.trim().replace(/^"|"$/g, ""));
    const sec = Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
    switch (name) {
      case "public": d.public = true; break;
      case "private": d.private = true; break;
      case "no-store": d.noStore = true; break;
      case "no-cache": d.noCache = true; break;
      case "max-age": d.maxAge = sec; break;
      case "s-maxage": d.sMaxAge = sec; break;
      case "stale-while-revalidate": d.swr = sec; break;
      case "stale-if-error": d.sie = sec; break;
    }
  }
  return d;
}

/** Request headers a cached variant may depend on. A response that Varies on anything else is not stored. */
const KEY_HEADERS = ["accept", "accept-language"];
const VARY_ALLOWED = new Set(["accept-encoding", ...KEY_HEADERS]);
const STORABLE_STATUS = new Set([200, 203, 404, 410]);
/**
 * Negative answers (404, 410) turn into 200s as soon as a dataset that has the resource is published, and their
 * problem bodies carry no dataset ETag to revalidate against. They are kept at most this long, and never served
 * stale (no stale-while-revalidate, no stale-if-error).
 */
export const NEGATIVE_MAX_AGE_S = 60;
/**
 * Part of every cache key. Bumping it orphans every stored entry at once (the Cache API is per data centre and
 * has no purge-all of its own): do so when entries stored under older rules must not be served again.
 * 2: 2026-10-21, after stale 404s and a datasetVersion-0 /v1/meta outlived a dataset publish.
 */
export const KEY_VERSION = "2";

export const STORED_AT = "X-Edge-Stored-At";
export const ORIGIN_CC = "X-Edge-Origin-Cache-Control";

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The cache key: the full request URL with its query sorted (so `?b=1&a=2` and `?a=2&b=1` share an entry), plus a
 * hash of the Vary-relevant request headers. Built as a fresh GET with no headers, so conditional request headers
 * never make the Cache API answer 304 on our behalf.
 */
export function cacheKey(request: Request): Request {
  const url = new URL(request.url);
  const pairs = [...url.searchParams].sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const q = new URLSearchParams(pairs);
  const variant = KEY_HEADERS.map((h) => (request.headers.get(h) ?? "").trim().toLowerCase()).join("\n");
  q.append("__edge_v", `${KEY_VERSION}.${fnv1a(variant)}`);
  url.search = q.toString();
  url.hash = "";
  return new Request(url.toString(), { method: "GET" });
}

export interface Lifetimes {
  fresh: number;
  swr: number;
  sie: number;
}

function lifetimes(status: number, d: Directives, defaultSie: number): Lifetimes | undefined {
  const fresh = d.sMaxAge ?? d.maxAge;
  if (!fresh) return undefined;
  if (status === 404 || status === 410) return { fresh: Math.min(fresh, NEGATIVE_MAX_AGE_S), swr: 0, sie: 0 };
  return { fresh, swr: d.swr ?? 0, sie: d.sie ?? defaultSie };
}

/** Whether an origin response may be stored, per the contract's Cache-Control table (CONTRACT-GUIDE §6). */
export function storable(response: Response, defaultSie: number): Lifetimes | undefined {
  if (!STORABLE_STATUS.has(response.status)) return undefined;
  const d = parseCacheControl(response.headers.get("Cache-Control"));
  if (!d.public || d.private || d.noStore || d.noCache) return undefined;
  const life = lifetimes(response.status, d, defaultSie);
  if (!life) return undefined;
  if (response.headers.has("Set-Cookie")) return undefined;
  const vary = response.headers.get("Vary");
  if (vary && vary.split(",").some((v) => !VARY_ALLOWED.has(v.trim().toLowerCase()))) return undefined;
  if ((response.headers.get("Content-Type") ?? "").includes("text/event-stream")) return undefined;
  return life;
}

/** Store a (cloned) origin response. Returns false when it isn't storable. */
export async function store(cache: Cache, key: Request, response: Response, defaultSie: number, now = Date.now()): Promise<boolean> {
  const life = storable(response, defaultSie);
  if (!life) {
    await response.body?.cancel();
    return false;
  }
  const headers = new Headers(response.headers);
  headers.set(ORIGIN_CC, response.headers.get("Cache-Control")!);
  headers.set(STORED_AT, String(now));
  headers.set("Cache-Control", `public, max-age=${life.fresh + Math.max(life.swr, life.sie)}`);
  headers.delete("Age");
  headers.delete("X-Edge-Cache");
  headers.delete("X-Edge-Stale");
  headers.delete("Server-Timing");
  await cache.put(key, new Response(response.body, { status: response.status, headers }));
  return true;
}

export type Freshness = "fresh" | "revalidate" | "if-error" | "expired";

export interface Entry {
  response: Response;
  ageS: number;
  state: Freshness;
  etag: string | null;
}

export async function lookup(cache: Cache, key: Request, defaultSie: number, now = Date.now()): Promise<Entry | undefined> {
  const response = await cache.match(key);
  if (!response) return undefined;
  const storedAt = Number(response.headers.get(STORED_AT));
  const originCc = response.headers.get(ORIGIN_CC);
  if (!Number.isFinite(storedAt) || !originCc) return undefined;
  const life = lifetimes(response.status, parseCacheControl(originCc), defaultSie) ?? { fresh: 0, swr: 0, sie: 0 };
  const ageS = Math.max(0, Math.floor((now - storedAt) / 1000));
  const state: Freshness =
    ageS < life.fresh ? "fresh" : ageS < life.fresh + life.swr ? "revalidate" : ageS < life.fresh + life.sie ? "if-error" : "expired";
  return { response, ageS, state, etag: response.headers.get("ETag") };
}

/** Rebuild a stored entry as the client should see it; answers 304 when If-None-Match matches its ETag. */
export function fromEntry(entry: Entry, request: Request): Response {
  const headers = new Headers(entry.response.headers);
  headers.set("Cache-Control", headers.get(ORIGIN_CC)!);
  headers.delete(ORIGIN_CC);
  headers.delete(STORED_AT);
  headers.set("Age", String(entry.ageS));
  if (entry.response.status === 200 && etagMatches(request.headers.get("If-None-Match"), entry.etag)) {
    for (const h of ["Content-Type", "Content-Length", "Content-Encoding"]) headers.delete(h);
    void entry.response.body?.cancel();
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") {
    void entry.response.body?.cancel();
    return new Response(null, { status: entry.response.status, headers });
  }
  return new Response(entry.response.body, { status: entry.response.status, headers });
}

/** Refresh a stored entry after the origin answered 304 to a revalidation: same body, new headers and timestamp. */
export async function refresh(cache: Cache, key: Request, entry: Response, notModified: Response, defaultSie: number, now = Date.now()) {
  const headers = new Headers(entry.headers);
  headers.set("Cache-Control", entry.headers.get(ORIGIN_CC) ?? "");
  headers.delete(ORIGIN_CC);
  headers.delete(STORED_AT);
  for (const h of ["Cache-Control", "ETag", "Expires", "Vary", "X-Backend-Impl", "X-Backend-Version", "X-Contract-Version"]) {
    const v = notModified.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  return store(cache, key, new Response(entry.body, { status: entry.status, headers }), defaultSie, now);
}
