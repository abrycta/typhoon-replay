// Domain types shared by the static data layer (src/data) and the API adapters (src/api).
// Field names follow the contract (contracts/openapi) wherever the concept exists there, so a storm
// from the static index and one from GET /v1/storms look the same to features.

export type Country = "PH" | "JP";
export type Agency = "jma" | "jtwc" | "pagasa" | "wmo" | "cma" | "hko" | "kma";
export type LonLat = [number, number];

export interface LocalNames {
  ph?: string;
  ja?: string;
}

export interface StormSummary {
  sid: string;
  name: string;
  localNames?: LocalNames;
  season: number;
  basin: string;
  startedAt: string;
  endedAt: string;
  peakWindKt?: number;
  peakWindAgency?: Agency;
  minPressureHpa?: number;
  landfallCountries: Country[];
  /** JTWC tropical cyclone number from IBTrACS USA_ATCF_ID ("03W"); static index from data v2, optional. */
  designation?: string;
  /** Accumulated cyclone energy (10^4 kt^2), static index only. */
  ace?: number;
  /** Static index only: frames exist for the replay. */
  replayAvailable?: boolean;
  frameCount?: number;
}

export interface AgencyIntensity {
  agency: Agency;
  windAveragingMinutes: number;
  maxWindKt?: number;
  minPressureHpa?: number;
}

export interface Landfall {
  country: Country;
  at: string;
  position: LonLat;
  placeId?: string;
}

export interface DataSource {
  id: string;
  name: string;
  url: string;
  license?: string;
  attribution?: string;
}

export interface PlaceSummary {
  id: string;
  country: Country;
  kind: string;
  name: string;
  nameJa?: string;
  admin1: string;
  admin1Ja?: string;
  admin2?: string;
  centroid: LonLat;
}

/** A place a storm passed near (contract `PlaceHit`). */
export interface PlaceHit {
  place: PlaceSummary;
  closestApproachKm: number;
  closestApproachAt: string;
  maxWindKtWithinRadius?: number;
  maxGustKtWithinRadius?: number;
  hoursWithinRadius: number;
}

/** A storm that passed near a place (contract `StormHit`). */
export interface StormHit {
  storm: StormSummary;
  closestApproachKm: number;
  closestApproachAt: string;
  maxWindKtWithinRadius?: number;
  maxGustKtWithinRadius?: number;
  hoursWithinRadius: number;
}

/** How a quantised frame variable decodes (pipeline/typhoon/frames.py). */
export interface FrameVarMeta {
  name: string;
  units: string;
  encoding: "linear" | "sqrt" | "angle";
  scale: number;
  offset: number;
  description?: string;
}

/** One WebP sprite-sheet set: frame k is the tile at column k % cols, row k / cols, top-left (col, row) * tileStride. */
export interface WebpSheetSet {
  kind: "webp-lossy" | "webp-lossless";
  stepHours: number;
  frames: number;
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  tileStride: number;
  resDeg: number;
  /** exact only: the hourly frame index of each tile. */
  frameIndex?: number[];
  /** exact only: every n-th cell of the hourly grid (same north-west corner). */
  cellStride?: number;
  vars: (FrameVarMeta & { path: string; bytes?: number; sha256?: string; maxCodeError?: number })[];
}

/** Per-frame values near the best-track centre, computed by the pipeline from the unquantised fields. */
export interface FrameSeries {
  note?: string;
  era5MaxWindMs?: (number | null)[];
  era5MaxGustMs?: (number | null)[];
  era5MinMslpHpa?: (number | null)[];
  era5MaxRainMmh?: (number | null)[];
}

/**
 * summary.frames. `format` names the .tyf when there is one (`path`, `bytes`, `sha256` describe it); storms
 * published WebP-only say "webp". `field` (lossy, hourly, drawing only) and `exact` (lossless, 3-hourly)
 * are the WebP sets, with the per-frame geometry in `time`, `nwLat`, `nwLon`.
 */
export interface FramesManifest {
  format: "tyf" | "tyf.gz" | "webp";
  path?: string;
  bytes?: number;
  frames: number;
  start?: string;
  end?: string;
  vars?: (string | FrameVarMeta)[];
  sha256?: string;
  nx?: number;
  ny?: number;
  resDeg?: number;
  nodata?: number;
  /** Unix seconds (UTC) per frame. */
  time?: number[];
  nwLat?: number[];
  nwLon?: number[];
  series?: FrameSeries;
  field?: WebpSheetSet;
  exact?: WebpSheetSet;
}

/** ERA5 vs best track at the storm's peak (from the pipeline's cross-check). */
export interface ReanalysisCheck {
  radiusDeg: number;
  peakTime: string;
  atPeak: {
    jtwcMs?: number;
    jmaMs?: number;
    era5WindMs: number;
    era5GustMs?: number;
    ratioToJtwc?: number;
    ratioToJma?: number;
    era5MslpMinHpa?: number;
    jmaPressureHpa?: number;
  };
  typhoonHoursMedianRatioToJtwc?: number;
  typhoonHoursMedianRatioToJma?: number;
}

export interface StormDetail extends Omit<StormSummary, "peakWindKt" | "peakWindAgency" | "minPressureHpa"> {
  atcfId?: string;
  durationHours?: number;
  fixCount?: number;
  peak?: { windKt?: number; agency?: Agency; pressureHpa?: number; at?: string; position?: LonLat };
  intensity: AgencyIntensity[];
  landfalls: Landfall[];
  sources: DataSource[];
  replayAvailable: boolean;
  frames?: FramesManifest;
  reanalysisCheck?: ReanalysisCheck;
  affectedPlaces?: PlaceHit[];
  affectedRadiusKm?: number;
  ogImage?: string;
}

/** One best-track fix as published (observed, 3- or 6-hourly). */
export interface TrackFix {
  t: string;
  lon: number;
  lat: number;
  jtwcKt?: number;
  jtwcHpa?: number;
  jmaKt?: number;
  jmaHpa?: number;
  overLand?: boolean;
}

/** An hourly track point, observed or interpolated, with provenance. */
export interface TrackHour {
  t: number; // unix seconds
  lon: number;
  lat: number;
  jtwcKt?: number;
  jtwcHpa?: number;
  jmaKt?: number;
  jmaHpa?: number;
  observed: boolean;
  /** For interpolated points: the bracketing observed fixes (unix seconds). */
  between?: [number, number];
}

export interface StormTrack {
  sid: string;
  fixes: TrackFix[];
  hours: TrackHour[];
}

export interface DatasetManifest {
  datasetVersion: number;
  dataAsOf?: string;
  generatedAt?: string;
  fixture?: boolean;
  note?: string;
  storms?: number;
  stormsWithFrames?: number;
  sources: DataSource[];
}
