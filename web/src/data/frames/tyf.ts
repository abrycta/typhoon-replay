// TYF1 frame file (pipeline/typhoon/frames.py):
//   bytes 0-3  "TYF1"; bytes 4-7 uint32 LE header length H; JSON header (space-padded so data is 8-byte aligned)
//   data       uint8[frames][vars][ny][nx], row 0 = north edge, col 0 = west edge; 255 = nodata
// Decoding per variable: linear v = offset + q*scale; sqrt v = (q*scale)^2; angle deg = q*360/256.

export interface TyfVar {
  name: string;
  units: string;
  encoding: "linear" | "sqrt" | "angle";
  scale: number;
  offset: number;
}

export interface TyfHeader {
  format: "TYF1";
  sid: string;
  name?: string;
  season?: number;
  source?: string;
  credit?: string;
  nx: number;
  ny: number;
  res_deg: number;
  frames: number;
  nodata: number;
  vars: TyfVar[];
  /** Unix seconds (UTC) per frame. */
  time: number[];
  /** North-west cell centre per frame. Longitudes may be 0-360. */
  nw_lat: number[];
  nw_lon: number[];
}

export const PREAMBLE = 8;

export class TyfFormatError extends Error {}

/** Header length from the first 8 bytes, or undefined if fewer are available. */
export function headerLength(bytes: Uint8Array): number | undefined {
  if (bytes.length < PREAMBLE) return undefined;
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== "TYF1") throw new TyfFormatError(`not a TYF1 file (magic ${JSON.stringify(magic)})`);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
}

export function parseHeader(bytes: Uint8Array): { header: TyfHeader; dataOffset: number } | undefined {
  const hlen = headerLength(bytes);
  if (hlen === undefined || bytes.length < PREAMBLE + hlen) return undefined;
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(PREAMBLE, PREAMBLE + hlen))) as TyfHeader;
  if (!header.nx || !header.ny || !header.frames || !Array.isArray(header.vars)) throw new TyfFormatError("incomplete TYF1 header");
  return { header, dataOffset: PREAMBLE + hlen };
}

export const frameBytes = (h: Pick<TyfHeader, "nx" | "ny" | "vars">) => h.nx * h.ny * h.vars.length;

export function decoder(v: TyfVar): (q: number) => number {
  if (v.encoding === "sqrt") return (q) => (q * v.scale) ** 2;
  if (v.encoding === "angle") return (q) => (q * 360) / 256;
  return (q) => v.offset + q * v.scale;
}

/** Window geometry for frame i: west/east/north/south cell-edge bounds, longitudes in (-180, 180+]. */
export function frameBounds(h: TyfHeader, i: number) {
  let west = h.nw_lon[i]! - h.res_deg / 2;
  if (west > 180) west -= 360;
  const north = h.nw_lat[i]! + h.res_deg / 2;
  return { west, east: west + h.nx * h.res_deg, north, south: north - h.ny * h.res_deg };
}

/** U/V wind (m/s) packed as RG8, offset 128, 0.4 m/s per step (±51 m/s), for the particle layer. */
export const UV_SCALE = 0.4;

export function windToUv(frame: Uint8Array, h: TyfHeader): Uint8Array {
  const n = h.nx * h.ny;
  const wi = h.vars.findIndex((v) => v.name === "wind");
  const di = h.vars.findIndex((v) => v.name === "wdir");
  const out = new Uint8Array(n * 2).fill(128);
  if (wi < 0 || di < 0) return out;
  const ws = decoder(h.vars[wi]!);
  for (let k = 0; k < n; k++) {
    const qw = frame[wi * n + k]!;
    const qd = frame[di * n + k]!;
    if (qw === h.nodata) continue;
    const s = ws(qw);
    const a = (qd * 2 * Math.PI) / 256; // direction blown towards, clockwise from north
    const u = s * Math.sin(a);
    const v = s * Math.cos(a);
    out[k * 2] = Math.max(0, Math.min(255, Math.round(u / UV_SCALE + 128)));
    out[k * 2 + 1] = Math.max(0, Math.min(255, Math.round(v / UV_SCALE + 128)));
  }
  return out;
}

/** Max of a variable within radiusDeg of (lon, lat) in one frame, or undefined. */
export function maxNear(frame: Uint8Array, h: TyfHeader, i: number, varName: string, lon: number, lat: number, radiusDeg: number, mode: "max" | "min" = "max"): number | undefined {
  const vi = h.vars.findIndex((v) => v.name === varName);
  if (vi < 0) return undefined;
  const dec = decoder(h.vars[vi]!);
  const n = h.nx * h.ny;
  let nwLon = h.nw_lon[i]!;
  let clon = lon;
  if (nwLon > 180) nwLon -= 360;
  if (clon - nwLon > 180) clon -= 360;
  if (nwLon - clon > 180) clon += 360;
  const cos = Math.cos((lat * Math.PI) / 180);
  let best: number | undefined;
  for (let r = 0; r < h.ny; r++) {
    const cellLat = h.nw_lat[i]! - r * h.res_deg;
    const dy = cellLat - lat;
    if (Math.abs(dy) > radiusDeg) continue;
    for (let c = 0; c < h.nx; c++) {
      const dx = (nwLon + c * h.res_deg - clon) * cos;
      if (dx * dx + dy * dy > radiusDeg * radiusDeg) continue;
      const q = frame[vi * n + r * h.nx + c]!;
      if (q === h.nodata) continue;
      const v = dec(q);
      if (best === undefined || (mode === "max" ? v > best : v < best)) best = v;
    }
  }
  return best;
}
