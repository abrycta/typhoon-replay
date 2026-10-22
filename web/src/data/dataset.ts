// Static dataset access (Hugging Face dataset or any CORS static host). Never touches the API.
//
// Layout assumed (see web/docs/DATA-LAYOUT.md; the pipeline confirms):
//   <base>/latest.json                    {"version": 1, "path": "v1/"}  (or just {"version": 1})
//   <base>/v1/manifest.json               dataset version, dataAsOf, sources
//   <base>/v1/index.json                  {"storms": [StormSummary...]}  (a bare array is accepted)
//   <base>/v1/storms/<sid>/summary.json   StormDetail + frames manifest
//   <base>/v1/storms/<sid>/track.json     {"fixes": [...]} (+ optional "hours")
//   <base>/frames/<sid>/<hash>.field.<var>.webp, .exact.<var>.webp, <hash>.tyf
//                                         frame files named by summary.frames (paths relative to the storm
//                                         directory, e.g. ../../../frames/<sid>/...); see frames/source.ts
import type { DatasetManifest, StormDetail, StormSummary, StormTrack, TrackFix, TrackHour } from "@/shared/model/types";

import { isLeavingPage } from "@/shared/lib/page-exit";

import { tyfSource } from "./frames/source";
import { interpolateHourly } from "./track";

export interface DataSourceConfig {
  baseUrl: string;
  pointer: string;
  fallbackBaseUrls: string[];
  /** Storms shipped with the site at build time (scripts/bundle-data.mjs). */
  bundle?: { root: string; version: number; path: string; storms: string[] };
}

export interface ResolvedDataset {
  /** Absolute or root-relative URL of the version directory, with a trailing slash. */
  root: string;
  baseUrl: string;
  version: number;
  /** "fallback" when the primary host failed and a bundled fixture is used. */
  source: "primary" | "fallback";
  primaryError?: string;
  /**
   * Storms whose files are served from the site itself (same origin: no redirect hops, no US frame CDN), at
   * `root`, a copy of this version's layout. Set only while the dataset is the version the site was built with.
   */
  bundle?: { root: string; sids: ReadonlySet<string> };
}

export class DataError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

type Fetch = typeof fetch;

export async function getJson<T>(url: string, f: Fetch = fetch, timeoutMs = 10000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(url, { signal: ctrl.signal });
    if (!res.ok) throw new DataError(`${url}: HTTP ${res.status}`, res.status);
    const type = res.headers.get("Content-Type") ?? "";
    if (type.includes("text/html")) throw new DataError(`${url}: got HTML, not JSON`);
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof DataError) throw e;
    throw new DataError(`${url}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

const slash = (s: string) => (s.endsWith("/") ? s : `${s}/`);

/** Version directory from the pointer file; tolerant of `{path}`, `{version}`, `{latest}` or a bare string. */
export function pointerPath(p: unknown): { path: string; version: number } {
  if (typeof p === "string") return { path: slash(p), version: Number(/\d+/.exec(p)?.[0] ?? 0) };
  if (typeof p === "number") return { path: `v${p}/`, version: p };
  const o = (p ?? {}) as Record<string, unknown>;
  const version = Number(o.version ?? o.datasetVersion ?? o.latest ?? 0);
  const path = typeof o.path === "string" ? slash(o.path) : version ? `v${version}/` : "";
  return { path, version };
}

async function tryBase(baseUrl: string, pointer: string, f: Fetch): Promise<Omit<ResolvedDataset, "source">> {
  const ptr = pointerPath(await getJson<unknown>(baseUrl + pointer, f));
  return { root: baseUrl + ptr.path, baseUrl, version: ptr.version };
}

/** Dataset manifest ("data as of", sources). Loaded beside the index, never on the replay's critical path. */
export async function loadManifest(ds: ResolvedDataset, f: Fetch = fetch): Promise<DatasetManifest> {
  try {
    const m = await getJson<DatasetManifest>(ds.root + "manifest.json", f);
    return { ...m, datasetVersion: m.datasetVersion || ds.version, sources: m.sources ?? [] };
  } catch {
    return { datasetVersion: ds.version, sources: [] };
  }
}

export async function resolveDataset(cfg: DataSourceConfig, f: Fetch = fetch): Promise<ResolvedDataset> {
  let primaryError: string | undefined;
  try {
    return { ...(await tryBase(cfg.baseUrl, cfg.pointer, f)), source: "primary" };
  } catch (e) {
    primaryError = e instanceof Error ? e.message : String(e);
  }
  for (const base of cfg.fallbackBaseUrls) {
    // Leaving mid-load: the browser cancelled the request; asking the fallback host now only logs an error.
    if (isLeavingPage()) break;
    try {
      return { ...(await tryBase(base, cfg.pointer, f)), source: "fallback", primaryError };
    } catch {
      /* try the next one */
    }
  }
  throw new DataError(`No dataset reachable (${primaryError ?? "no hosts configured"})`);
}

/**
 * The dataset as the site was built with it, without asking the pointer: its version from the build, its storms
 * from the bundle. Undefined when the build bundled nothing. The pointer is still read in the background
 * (useDataset), and a newer version or an unreachable host replaces this one.
 */
export function bakedDataset(cfg: DataSourceConfig): ResolvedDataset | undefined {
  const b = cfg.bundle;
  if (!b?.version || !b.path) return undefined;
  return {
    root: cfg.baseUrl + slash(b.path),
    baseUrl: cfg.baseUrl,
    version: b.version,
    source: "primary",
    bundle: { root: slash(b.root) + slash(b.path), sids: new Set(b.storms) },
  };
}

/** Whether `live` (from the pointer) names the same files as `baked`, so the baked one (with its bundle) can stay. */
export const sameDataset = (baked: ResolvedDataset, live: ResolvedDataset) => live.source === baked.source && live.root === baked.root;

export async function loadIndex(ds: ResolvedDataset, f: Fetch = fetch): Promise<StormSummary[]> {
  const raw = await getJson<unknown>(ds.root + "index.json", f);
  const list = (Array.isArray(raw) ? raw : ((raw as { storms?: unknown[] }).storms ?? [])) as StormSummary[];
  return list
    .filter((s) => s && typeof s.sid === "string")
    .map((s) => ({ ...s, landfallCountries: s.landfallCountries ?? [] }));
}

/** The storm's directory on the dataset host. */
export const remoteStormRoot = (ds: ResolvedDataset, sid: string) => `${ds.root}storms/${encodeURIComponent(sid)}/`;

/** The storm's directory for its summary, track and WebP sheets: the site's own copy when the storm is bundled. */
export const stormRoot = (ds: ResolvedDataset, sid: string) =>
  ds.bundle?.sids.has(sid) ? `${ds.bundle.root}storms/${encodeURIComponent(sid)}/` : remoteStormRoot(ds, sid);

export async function loadStormDetail(ds: ResolvedDataset, sid: string, f: Fetch = fetch): Promise<StormDetail> {
  const d = await getJson<StormDetail>(stormRoot(ds, sid) + "summary.json", f);
  return {
    ...d,
    landfallCountries: d.landfallCountries ?? [],
    intensity: d.intensity ?? [],
    landfalls: d.landfalls ?? [],
    sources: d.sources ?? [],
    replayAvailable: d.replayAvailable ?? Boolean(d.frames),
  };
}

export async function loadTrack(ds: ResolvedDataset, sid: string, f: Fetch = fetch): Promise<StormTrack> {
  const raw = await getJson<{ fixes?: TrackFix[]; hours?: TrackHour[] }>(stormRoot(ds, sid) + "track.json", f);
  const fixes = (raw.fixes ?? []).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon));
  const hours = raw.hours?.length ? raw.hours : interpolateHourly(fixes);
  return { sid, fixes, hours };
}

/** URL of the storm's .tyf, if it has one (frames/source.ts picks between it and the WebP sets). */
export function framesUrl(ds: ResolvedDataset, d: StormDetail): string | undefined {
  return d.frames ? tyfSource(d.frames, remoteStormRoot(ds, d.sid))?.url : undefined;
}

export function ogImageUrl(ds: ResolvedDataset, d: Pick<StormDetail, "sid" | "ogImage">): string | undefined {
  return d.ogImage ? remoteStormRoot(ds, d.sid) + d.ogImage : undefined;
}
