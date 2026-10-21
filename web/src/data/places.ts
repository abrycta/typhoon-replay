// Static place data: the place search index and per-place storm exposure, read from the dataset host.
// Never touches the API. Layout (web/docs/DATA-LAYOUT.md; m1-pipeline `dataset.write_places`):
//
//   v<N>/places/index.json      {shards: [{shard, country, admin1, admin2?, places, hits, bbox, path}], search?}
//   v<N>/places/search.json     compact search index: {columns, rows, shards?}   (falls back to the shards)
//   v<N>/places/search/manifest.json  {keys, split, jaBuckets}: slices of search.json by the query's first letter(s)
//   v<N>/places/search/<key>.json     one slice, same shape as search.json (the first search reads only this)
//   v<N>/places/<shard>.json    {country, admin1, places: [...], hits: {columns, rows}, storms: {sid: [name, season]}}
//
// Paths inside the files are dataset-root relative: "v1/places/ph-leyte.json", or the content-addressed shards the
// pipeline shares between versions, "places/ph-leyte/<hash>.json" (at the dataset root, not under v<N>/). Absolute
// URLs, root-relative paths and bare file names (relative to v<N>/places/) also work. Every reader is tolerant: unknown fields are
// ignored, missing optional ones are left out, and a row it cannot read is skipped rather than failing the list.
import type { Country, PlaceSummary } from "@/shared/model/types";

import { getJson, type ResolvedDataset } from "./dataset";
import type { SliceManifest } from "./place-search";

type Fetch = typeof fetch;

export type ExposureRadiusKm = 50 | 100 | 200 | 300 | 500;
export const EXPOSURE_RADII: readonly ExposureRadiusKm[] = [50, 100, 200, 300, 500];

/** A searchable place; `shard` is the URL of the shard file holding its exposure. */
export interface PlaceEntry extends PlaceSummary {
  shard?: string;
  /** Storms whose track came within 100 km (ranking hint; absent when the index does not carry it). */
  storms100?: number;
}

/** One storm's pass near a place, as published in the place's shard. */
export interface PlaceExposure {
  sid: string;
  /** From the shard's storm table; the caller joins the storm index for the full summary. */
  name?: string;
  season?: number;
  closestApproachKm: number;
  closestApproachAt: string;
  maxWindKtWithinRadius?: number;
  maxGustKtWithinRadius?: number;
  hoursWithinRadius: number;
}

export interface PlaceShard {
  places: PlaceEntry[];
  /** Exposure rows of every place in the shard, keyed by place id; filter with `exposureWithin`. */
  hits: Map<string, ShardHit[]>;
}

interface ShardHit {
  sid: string;
  name?: string;
  season?: number;
  km: number;
  at: string;
  wind: Partial<Record<ExposureRadiusKm, number>>;
  gust: Partial<Record<ExposureRadiusKm, number>>;
  hours: Partial<Record<ExposureRadiusKm, number>>;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === "string" && x ? x : undefined);
const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);

/** Resolve a path found in a dataset file against the dataset. */
export function datasetUrl(ds: ResolvedDataset, path: string, relativeTo = `${ds.root}places/`): string {
  if (/^https?:\/\//.test(path) || path.startsWith("/")) return path;
  if (/^v\d+\//.test(path)) return ds.baseUrl + path; // dataset-root relative (the pipeline's form)
  if (path.startsWith("places/")) return ds.baseUrl + path; // shared content-addressed shard (pipeline `put_shared`)
  return relativeTo + path;
}

/** Rows of a columnar table ({columns, rows}) or a plain array of objects, as objects. */
function records(table: unknown): Record<string, unknown>[] {
  if (Array.isArray(table)) return table.filter(isObj);
  if (!isObj(table)) return [];
  const cols = Array.isArray(table.columns) ? table.columns.map(String) : undefined;
  const rows = Array.isArray(table.rows) ? table.rows : Array.isArray(table.items) ? table.items : Array.isArray(table.places) ? table.places : [];
  if (!cols) return rows.filter(isObj);
  return rows.filter(Array.isArray).map((r: unknown[]) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

const COUNTRY = (x: unknown, id: string): Country | undefined => {
  const c = str(x) ?? id.slice(0, 2);
  return c === "PH" || c === "JP" ? c : undefined;
};

function toPlace(o: Record<string, unknown>, defaults: { country?: unknown; admin1?: unknown; admin2?: unknown; shard?: string } = {}): PlaceEntry | undefined {
  const id = str(o.id) ?? str(o.placeId);
  const name = str(o.name);
  if (!id || !name) return undefined;
  const country = COUNTRY(o.country ?? defaults.country, id);
  if (!country) return undefined;
  const c = Array.isArray(o.centroid) ? o.centroid : [o.lon, o.lat];
  const lon = num(c[0]);
  const lat = num(c[1]);
  const summary = isObj(o.summary) ? o.summary : undefined;
  const p: PlaceEntry = {
    id,
    country,
    kind: str(o.kind) ?? "municipality",
    name,
    admin1: str(o.admin1) ?? str(defaults.admin1) ?? "",
    centroid: [lon ?? 0, lat ?? 0],
  };
  const nameJa = str(o.nameJa);
  const admin1Ja = str(o.admin1Ja);
  const admin2 = str(o.admin2) ?? str(defaults.admin2);
  const storms100 = num(o.storms100) ?? num(summary?.stormsWithin100Km);
  if (nameJa) p.nameJa = nameJa;
  if (admin1Ja) p.admin1Ja = admin1Ja;
  if (admin2) p.admin2 = admin2;
  if (defaults.shard) p.shard = defaults.shard;
  if (storms100 !== undefined) p.storms100 = storms100;
  return p;
}

interface ShardRef {
  url: string;
}

async function shardList(ds: ResolvedDataset, f: Fetch): Promise<{ shards: ShardRef[]; search?: string }> {
  const raw = await getJson<unknown>(`${ds.root}places/index.json`, f);
  const list = isObj(raw) ? raw.shards : raw;
  const shards = (Array.isArray(list) ? list : [])
    .map((s) => {
      if (typeof s === "string") return { url: datasetUrl(ds, s.endsWith(".json") ? s : `${s}.json`) };
      if (!isObj(s)) return undefined;
      const path = str(s.path) ?? (str(s.shard) ? `${str(s.shard)}.json` : undefined);
      return path ? { url: datasetUrl(ds, path) } : undefined;
    })
    .filter((s): s is ShardRef => !!s);
  return { shards, search: isObj(raw) ? str(raw.search) : undefined };
}

/** The compact index ({columns, rows, shards?}); undefined when the dataset does not publish one. */
async function loadSearchFile(ds: ResolvedDataset, url: string, f: Fetch, rethrow = false): Promise<PlaceEntry[] | undefined> {
  let raw: unknown;
  try {
    raw = await getJson<unknown>(url, f, 15000);
  } catch (e) {
    if (rethrow) throw e;
    return undefined;
  }
  const shardPaths = isObj(raw) && Array.isArray(raw.shards) ? raw.shards.map((s) => (typeof s === "string" ? s : "")) : [];
  const out: PlaceEntry[] = [];
  for (const r of records(raw)) {
    const sh = r.shard;
    const shard = typeof sh === "number" ? shardPaths[sh] : str(sh);
    const p = toPlace(r, { shard: shard ? datasetUrl(ds, shard.endsWith(".json") ? shard : `${shard}.json`) : undefined });
    if (p) out.push(p);
  }
  return out.length ? out : undefined;
}

/** The slice manifest, or undefined when the dataset has none (older versions): then search the full index. */
export async function loadSliceManifest(ds: ResolvedDataset, f: Fetch = fetch): Promise<SliceManifest | null> {
  try {
    const raw = await getJson<unknown>(`${ds.root}places/search/manifest.json`, f);
    if (!isObj(raw) || !Array.isArray(raw.keys)) return null;
    const jaBuckets = num(raw.jaBuckets);
    return { keys: raw.keys.map(String), split: Array.isArray(raw.split) ? raw.split.map(String) : [], jaBuckets: jaBuckets && jaBuckets > 0 ? jaBuckets : 32 };
  } catch {
    return null;
  }
}

/** One slice of the place index (throws when it cannot be read, so the caller falls back to the full index). */
export async function loadPlaceSlice(ds: ResolvedDataset, key: string, f: Fetch = fetch): Promise<PlaceEntry[]> {
  const url = `${ds.root}places/search/${encodeURIComponent(key)}.json`;
  const places = await loadSearchFile(ds, url, f, true);
  if (!places) throw new Error(`${url}: no places`);
  return places;
}

/** Fetch many URLs with a small concurrency limit; failures are skipped. */
async function fetchAll<T>(urls: string[], f: Fetch, limit = 6): Promise<{ url: string; body: T }[]> {
  const out: { url: string; body: T }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++]!;
      try {
        out.push({ url, body: await getJson<T>(url, f, 20000) });
      } catch {
        /* a missing shard drops its places, not the search */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, urls.length) }, worker));
  return out;
}

/**
 * Every searchable place. Reads places/search.json (or the path places/index.json names); when the dataset has
 * no compact index, builds one from the shard files (heavier, still static).
 */
export async function loadPlaceIndex(ds: ResolvedDataset, f: Fetch = fetch): Promise<PlaceEntry[]> {
  let listing: Awaited<ReturnType<typeof shardList>> | undefined;
  try {
    listing = await shardList(ds, f);
  } catch {
    listing = undefined;
  }
  const fromSearch = await loadSearchFile(ds, listing?.search ? datasetUrl(ds, listing.search) : `${ds.root}places/search.json`, f);
  if (fromSearch) return fromSearch;
  if (!listing?.shards.length) return [];
  const shards = await fetchAll<unknown>(
    listing.shards.map((s) => s.url),
    f,
  );
  return shards.flatMap(({ url, body }) => parseShard(body, url).places);
}

function parseHit(o: Record<string, unknown>, storms: Record<string, unknown>): ShardHit | undefined {
  const sid = str(o.sid);
  const km = num(o.km) ?? num(o.closestApproachKm);
  const atRaw = o.at ?? o.closestApproachAt;
  const at = typeof atRaw === "number" ? new Date(atRaw * 1000).toISOString().replace(".000Z", "Z") : str(atRaw);
  if (!sid || km === undefined || !at) return undefined;
  const meta = storms[sid];
  const hit: ShardHit = { sid, km, at, wind: {}, gust: {}, hours: {} };
  if (Array.isArray(meta)) {
    hit.name = str(meta[0]);
    hit.season = num(meta[1]);
  } else if (isObj(meta)) {
    hit.name = str(meta.name);
    hit.season = num(meta.season);
  }
  for (const r of EXPOSURE_RADII) {
    const w = num(o[`w${r}`]);
    const g = num(o[`g${r}`]);
    const h = num(o[`h${r}`]);
    if (w !== undefined) hit.wind[r] = w;
    if (g !== undefined) hit.gust[r] = g;
    if (h !== undefined) hit.hours[r] = h;
  }
  return hit;
}

/** Parse a shard file (exported for tests). `url` becomes each place's `shard`. */
export function parseShard(raw: unknown, url: string): PlaceShard {
  const doc = isObj(raw) ? raw : {};
  const defaults = { country: doc.country, admin1: doc.admin1, admin2: doc.admin2, shard: url };
  const placesRaw = Array.isArray(doc.places) ? doc.places.filter(isObj) : [];
  const places = placesRaw.map((p) => toPlace(p, defaults)).filter((p): p is PlaceEntry => !!p);
  const storms = isObj(doc.storms) ? doc.storms : {};
  const hits = new Map<string, ShardHit[]>();
  for (const r of records(doc.hits)) {
    // `place` is an index into `places` (the pipeline's form) or a place id.
    const ref = r.place ?? r.placeId;
    const id = typeof ref === "number" ? str(placesRaw[ref]?.id) : str(ref);
    const hit = id ? parseHit(r, storms) : undefined;
    if (!id || !hit) continue;
    const list = hits.get(id) ?? [];
    list.push(hit);
    hits.set(id, list);
  }
  return { places, hits };
}

export async function loadPlaceShard(url: string, f: Fetch = fetch): Promise<PlaceShard> {
  return parseShard(await getJson<unknown>(url, f, 20000), url);
}

/** Storms that passed within `radiusKm` of a place, closest first (ties by sid). */
export function exposureWithin(shard: PlaceShard, placeId: string, radiusKm: ExposureRadiusKm): PlaceExposure[] {
  return (shard.hits.get(placeId) ?? [])
    .filter((h) => h.km <= radiusKm)
    .sort((a, b) => a.km - b.km || a.sid.localeCompare(b.sid))
    .map((h) => {
      const e: PlaceExposure = {
        sid: h.sid,
        closestApproachKm: h.km,
        closestApproachAt: h.at,
        // Hours are only meaningful per radius; a shard without them counts the closest-approach hour.
        hoursWithinRadius: h.hours[radiusKm] ?? 1,
      };
      if (h.name) e.name = h.name;
      if (h.season !== undefined) e.season = h.season;
      if (h.wind[radiusKm] !== undefined) e.maxWindKtWithinRadius = h.wind[radiusKm];
      if (h.gust[radiusKm] !== undefined) e.maxGustKtWithinRadius = h.gust[radiusKm];
      return e;
    });
}
