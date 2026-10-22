// Which frame files to play for a storm, from its summary.frames (see web/docs/DATA-LAYOUT.md).
//
// The pipeline always publishes the WebP sets (`field`, `exact`) and, for some storms, a .tyf as well
// (`format: "tyf"`, `path`). WebP is preferred: about a tenth of the bytes, with the frame geometry already
// in the summary, so the timeline is known before any frame file is requested. The .tyf is the fallback.
import type { FramesManifest, WebpSheetSet } from "@/shared/model/types";

import type { TyfHeader, TyfVar } from "./tyf";
import type { FrameSource, SheetSet, TyfSource, WebpSource } from "./webp";

/** Drawable field variables, in raw-frame order (the same names as in a .tyf). */
export const FIELD_VARS = ["wind", "gust", "mslp", "tp"] as const;
/** What the readouts need from the exact grid. */
export const EXACT_VARS = ["wind", "mslp"] as const;

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

/** `path` relative to the directory URL `base` (absolute or root-relative), with ../ segments resolved. */
export function resolveUrl(base: string, path: string): string {
  if (ABSOLUTE.test(path) || path.startsWith("/")) return path;
  if (ABSOLUTE.test(base)) return new URL(path, base).href;
  const u = new URL(path, new URL(base, "http://root.invalid/"));
  return u.pathname + u.search;
}

const toVar = (v: WebpSheetSet["vars"][number]): TyfVar => ({ name: v.name, units: v.units, encoding: v.encoding, scale: v.scale, offset: v.offset });

function sheetSet(set: WebpSheetSet, names: readonly string[], base: string): SheetSet | undefined {
  const vars = names.map((n) => set.vars.find((v) => v.name === n));
  if (vars.some((v) => !v?.path)) return undefined;
  return {
    geometry: { frames: set.frames, cols: set.cols, tileWidth: set.tileWidth, tileHeight: set.tileHeight, tileStride: set.tileStride },
    vars: vars.map((v) => ({ name: v!.name, url: resolveUrl(base, v!.path), bytes: v!.bytes, meta: toVar(v!) })),
  };
}

/** WebP source when the summary has a complete field set and per-frame geometry. */
export function webpSource(sid: string, fr: FramesManifest, stormDir: string, opts: { exact?: boolean } = {}): WebpSource | undefined {
  const f = fr.field;
  const n = fr.frames;
  if (!f || f.frames !== n || fr.time?.length !== n || fr.nwLat?.length !== n || fr.nwLon?.length !== n) return undefined;
  const field = sheetSet(f, [...FIELD_VARS, "u", "v"], stormDir);
  if (!field) return undefined;
  const nodata = fr.nodata ?? 255;
  const header: TyfHeader = {
    format: "webp",
    sid,
    nx: f.tileWidth,
    ny: f.tileHeight,
    res_deg: f.resDeg,
    frames: n,
    nodata,
    vars: field.vars.slice(0, FIELD_VARS.length).map((v) => v.meta),
    time: fr.time,
    nw_lat: fr.nwLat,
    nw_lon: fr.nwLon,
  };
  const src: WebpSource = { kind: "webp", header, field };
  const e = fr.exact;
  const exactSet = opts.exact && e?.frameIndex?.length === e?.frames ? sheetSet(e!, EXACT_VARS, stormDir) : undefined;
  if (e?.frameIndex && exactSet && e.frameIndex.every((i) => i >= 0 && i < n)) {
    const idx = e.frameIndex;
    src.exact = {
      frameIndex: idx,
      set: exactSet,
      // Every cellStride-th cell of the hourly grid from the same north-west cell centre.
      header: {
        format: "webp",
        sid,
        nx: e.tileWidth,
        ny: e.tileHeight,
        res_deg: e.resDeg,
        frames: e.frames,
        nodata,
        vars: exactSet.vars.map((v) => v.meta),
        time: idx.map((i) => fr.time![i]!),
        nw_lat: idx.map((i) => fr.nwLat![i]!),
        nw_lon: idx.map((i) => fr.nwLon![i]!),
      },
    };
  }
  return src;
}

/** The .tyf named by the summary, if any. */
export function tyfSource(fr: FramesManifest, stormDir: string): TyfSource | undefined {
  if (!fr.path || fr.format === "webp") return undefined;
  return { kind: "tyf", url: resolveUrl(stormDir, fr.path), format: fr.format === "tyf.gz" || fr.path.endsWith(".gz") ? "tyf.gz" : "tyf" };
}

/**
 * Frames to play: WebP when the summary has it (with the .tyf as fallback), else the .tyf. The lossless
 * readout grid is requested only when the summary lacks the per-frame `series`. `tyfDir`: where the .tyf lives when
 * it is not beside the sheets (bundled storms ship only the sheets).
 */
export function frameSource(sid: string, fr: FramesManifest | undefined, stormDir: string, tyfDir = stormDir): FrameSource | undefined {
  if (!fr) return undefined;
  const tyf = tyfSource(fr, tyfDir);
  const webp = webpSource(sid, fr, stormDir, { exact: !fr.series?.era5MaxWindMs });
  if (webp) return tyf ? { ...webp, fallback: tyf } : webp;
  return tyf;
}

/** Stable identity of a source (effects reopen the worker only when this changes). */
export const sourceKey = (s: FrameSource | undefined) => (s ? (s.kind === "tyf" ? s.url : s.field.vars.map((v) => v.url).join("|")) : undefined);
