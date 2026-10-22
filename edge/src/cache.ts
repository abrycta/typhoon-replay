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

/**
 * Request headers a cached variant may depend on. A response that Varies on anything else is not stored.
 * Accept-Language is deliberately not one: no backend varies on it (they all answer `Vary: Accept-Encoding`), and
 * keying on it split the cache per browser language string, so each one paid its own misses and cold starts.
 */
const KEY_HEADERS = ["accept"];
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
 * 3: 2026-10-21, entries are stored decoded (no Content-Encoding) since the proxy asks the origin for gzip.
 * 4: 2026-10-22, the key no longer includes Accept-Language and normalises Accept.
 */
export const KEY_VERSION = "4";

/**
 * Dataset pin. A catalogue representation changes only with the dataset version: its ETag is `W/"d{n}-{resourceKey}"`,
 * derived from data, never from bytes (CONTRACT-GUIDE §6), which is also why a revalidation may answer 304. Every
 * time the origin answers with such an ETag (or `/v1/meta`'s `…-d{n}"`), the proxy records `n` as that backend's
 * current dataset version at this data centre. A catalogue entry past its max-age whose version matches a record
 * younger than DATASET_PIN_S is served as a fresh HIT: one origin answer confirms every cached catalogue entry at
 * once, instead of one revalidation per URL every max-age. The bound on staleness after a publish is the same as
 * the contract's max-age (300 s), and an entry whose version differs from the record follows the normal rules.
 */
export const DATASET_PIN_S = 300;
const DATASET_HEADER = "X-Edge-Dataset";

/** The dataset version an ETag carries: catalogue `W/"d{n}-…"` or `/v1/meta` `W/"c…-d{n}"`. */
export function datasetOf(etag: string | null): number | undefined {
  const m = /^(?:W\/)?"(?:d(\d+)-[^"]*|c[^"]*-d(\d+))"$/.exec(etag?.trim() ?? "");
  const v = m ? Number(m[1] ?? m[2]) : NaN;
  return Number.isSafeInteger(v) ? v : undefined;
}

/** Where a backend's dataset record lives: next to its entries (same host and impl), on a path no backend serves. */
function datasetKey(key: Request): Request | undefined {
  const url = new URL(key.url);
  const m = /^\/api\/[^/]+/.exec(url.pathname);
  if (!m) return undefined;
  return new Request(`${url.origin}${m[0]}/__edge/dataset?__edge_v=${KEY_VERSION}`, { method: "GET" });
}

async function recordDataset(cache: Cache, key: Request, version: number, now: number) {
  const dk = datasetKey(key);
  if (!dk) return;
  const headers = new Headers({ "Cache-Control": `public, max-age=${DATASET_PIN_S}`, [STORED_AT]: String(now), [DATASET_HEADER]: String(version) });
  await cache.put(dk, new Response(null, { status: 200, headers }));
}

async function currentDataset(cache: Cache, key: Request, now: number): Promise<number | undefined> {
  const dk = datasetKey(key);
  const r = dk && (await cache.match(dk));
  if (!r) return undefined;
  const at = Number(r.headers.get(STORED_AT));
  const v = Number(r.headers.get(DATASET_HEADER));
  if (!Number.isFinite(at) || !Number.isSafeInteger(v) || now - at >= DATASET_PIN_S * 1000 || now < at) return undefined;
  return v;
}

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
 * A key header's value in canonical form: lower case, no whitespace, and an absent Accept read as the "any type"
 * default it stands for, so spacing or letter case in a client's Accept never splits an entry.
 */
function normaliseKeyHeader(name: string, value: string | null): string {
  const v = (value ?? "").replace(/\s+/g, "").toLowerCase();
  return name === "accept" && v === "" ? "*/*" : v;
}

/**
 * The cache key: the full request URL with its query sorted (so `?b=1&a=2` and `?a=2&b=1` share an entry), plus a
 * hash of the normalised Vary-relevant request headers. Built as a fresh GET with no headers, so conditional request headers
 * never make the Cache API answer 304 on our behalf.
 */
export function cacheKey(request: Request): Request {
  const url = new URL(request.url);
  const pairs = [...url.searchParams].sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const q = new URLSearchParams(pairs);
  const variant = KEY_HEADERS.map((h) => normaliseKeyHeader(h, request.headers.get(h))).join("\n");
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
  // Stored decoded: reading the body decodes the origin's gzip, so the entry's headers must not claim an encoding.
  // Cloudflare compresses the answer for each client again; the bytes that count (Render → edge) stay compressed.
  for (const h of ["Age", "X-Edge-Cache", "X-Edge-Stale", "Server-Timing", "Content-Encoding", "Content-Length"]) headers.delete(h);
  const body = await response.arrayBuffer();
  await cache.put(key, new Response(body, { status: response.status, headers }));
  const version = response.status === 200 ? datasetOf(headers.get("ETag")) : undefined;
  if (version !== undefined) await recordDataset(cache, key, version, now);
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
  let state: Freshness =
    ageS < life.fresh ? "fresh" : ageS < life.fresh + life.swr ? "revalidate" : ageS < life.fresh + life.sie ? "if-error" : "expired";
  const etag = response.headers.get("ETag");
  if ((state === "revalidate" || state === "if-error") && response.status === 200) {
    // Dataset pin: past max-age, but the backend recently confirmed the dataset this entry was built from.
    const version = etag?.trim().replace(/^W\//, "").startsWith('"d') ? datasetOf(etag) : undefined;
    if (version !== undefined && (await currentDataset(cache, key, now)) === version) state = "fresh";
  }
  return { response, ageS, state, etag };
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
