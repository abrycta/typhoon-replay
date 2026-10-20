// Static dataset access (Hugging Face dataset or any CORS static host). Never touches the API.
//
// Layout assumed (see web/docs/DATA-LAYOUT.md; the pipeline confirms):
//   <base>/latest.json                    {"version": 1, "path": "v1/"}  (or just {"version": 1})
//   <base>/v1/manifest.json               dataset version, dataAsOf, sources
//   <base>/v1/index.json                  {"storms": [StormSummary...]}  (a bare array is accepted)
//   <base>/v1/storms/<sid>/summary.json   StormDetail + frames manifest
//   <base>/v1/storms/<sid>/track.json     {"fixes": [...]} (+ optional "hours")
//   <base>/v1/storms/<sid>/frames.tyf     TYF1 frames (or frames.tyf.gz)
import type { DatasetManifest, StormDetail, StormSummary, StormTrack, TrackFix, TrackHour } from "@/shared/model/types";

import { interpolateHourly } from "./track";

export interface DataSourceConfig {
  baseUrl: string;
  pointer: string;
  fallbackBaseUrls: string[];
}

export interface ResolvedDataset {
  /** Absolute or root-relative URL of the version directory, with a trailing slash. */
  root: string;
  baseUrl: string;
  version: number;
  manifest: DatasetManifest;
  /** "fallback" when the primary host failed and a bundled fixture is used. */
  source: "primary" | "fallback";
  primaryError?: string;
}

export class DataError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

type Fetch = typeof fetch;

async function getJson<T>(url: string, f: Fetch, timeoutMs = 10000): Promise<T> {
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
  const root = baseUrl + ptr.path;
  let manifest: DatasetManifest;
  try {
    manifest = await getJson<DatasetManifest>(root + "manifest.json", f);
  } catch {
    manifest = { datasetVersion: ptr.version, sources: [] };
  }
  manifest.sources ??= [];
  return { root, baseUrl, version: manifest.datasetVersion || ptr.version, manifest };
}

export async function resolveDataset(cfg: DataSourceConfig, f: Fetch = fetch): Promise<ResolvedDataset> {
  let primaryError: string | undefined;
  try {
    return { ...(await tryBase(cfg.baseUrl, cfg.pointer, f)), source: "primary" };
  } catch (e) {
    primaryError = e instanceof Error ? e.message : String(e);
  }
  for (const base of cfg.fallbackBaseUrls) {
    try {
      return { ...(await tryBase(base, cfg.pointer, f)), source: "fallback", primaryError };
    } catch {
      /* try the next one */
    }
  }
  throw new DataError(`No dataset reachable (${primaryError ?? "no hosts configured"})`);
}

export async function loadIndex(ds: ResolvedDataset, f: Fetch = fetch): Promise<StormSummary[]> {
  const raw = await getJson<unknown>(ds.root + "index.json", f);
  const list = (Array.isArray(raw) ? raw : ((raw as { storms?: unknown[] }).storms ?? [])) as StormSummary[];
  return list
    .filter((s) => s && typeof s.sid === "string")
    .map((s) => ({ ...s, landfallCountries: s.landfallCountries ?? [] }));
}

export const stormRoot = (ds: ResolvedDataset, sid: string) => `${ds.root}storms/${encodeURIComponent(sid)}/`;

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

export function framesUrl(ds: ResolvedDataset, d: StormDetail): string | undefined {
  if (!d.frames) return undefined;
  return /^https?:|^\//.test(d.frames.path) ? d.frames.path : stormRoot(ds, d.sid) + d.frames.path;
}

export function ogImageUrl(ds: ResolvedDataset, d: Pick<StormDetail, "sid" | "ogImage">): string | undefined {
  return d.ogImage ? stormRoot(ds, d.sid) + d.ogImage : undefined;
}
