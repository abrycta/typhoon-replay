// Builds small synthetic TYF1 files for tests (same layout as pipeline/typhoon/frames.py).
import type { TyfHeader } from "@/data";

export function makeTyf(opts: { frames?: number; nx?: number; ny?: number; fill?: (f: number, v: number, k: number) => number } = {}) {
  const frames = opts.frames ?? 5, nx = opts.nx ?? 4, ny = opts.ny ?? 3;
  const header: TyfHeader = {
    format: "TYF1",
    sid: "2013306N07162",
    nx,
    ny,
    res_deg: 0.25,
    frames,
    nodata: 255,
    vars: [
      { name: "wind", units: "m/s", encoding: "linear", scale: 0.3, offset: 0 },
      { name: "gust", units: "m/s", encoding: "linear", scale: 0.4, offset: 0 },
      { name: "mslp", units: "hPa", encoding: "linear", scale: 0.65, offset: 870 },
      { name: "tp", units: "mm/h", encoding: "sqrt", scale: 0.04, offset: 0 },
      { name: "wdir", units: "deg", encoding: "angle", scale: 1.40625, offset: 0 },
    ],
    time: Array.from({ length: frames }, (_, i) => 1383696000 + i * 3600),
    nw_lat: Array.from({ length: frames }, () => 12),
    nw_lon: Array.from({ length: frames }, (_, i) => 125 - i * 0.25),
  };
  let hb = new TextEncoder().encode(JSON.stringify(header));
  const pad = (8 - ((8 + hb.length) % 8)) % 8;
  const padded = new Uint8Array(hb.length + pad).fill(32);
  padded.set(hb);
  hb = padded;
  const fsz = nx * ny * header.vars.length;
  const out = new Uint8Array(8 + hb.length + frames * fsz);
  out.set([84, 89, 70, 49]); // "TYF1"
  new DataView(out.buffer).setUint32(4, hb.length, true);
  out.set(hb, 8);
  const fill = opts.fill ?? ((f, v, k) => (f * 10 + v * 3 + k) % 250);
  for (let f = 0; f < frames; f++)
    for (let v = 0; v < header.vars.length; v++)
      for (let k = 0; k < nx * ny; k++) out[8 + hb.length + f * fsz + v * nx * ny + k] = fill(f, v, k);
  return { bytes: out, header, dataOffset: 8 + hb.length, frameBytes: fsz };
}

/** A fetch stub serving one file, honouring (or ignoring) Range like a static host. */
export function fileFetch(bytes: Uint8Array, { ranges = true, chunk = 37 }: { ranges?: boolean; chunk?: number } = {}) {
  const calls: string[] = [];
  const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers).get("Range");
    calls.push(range ?? "full");
    const m = range && ranges ? /bytes=(\d+)-(\d+)/.exec(range) : null;
    if (m) {
      const a = Number(m[1]), b = Math.min(Number(m[2]), bytes.length - 1);
      return new Response(bytes.slice(a, b + 1), { status: 206, headers: { "Content-Range": `bytes ${a}-${b}/${bytes.length}` } });
    }
    // Stream in small chunks so frame-by-frame emission is exercised.
    let pos = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pos >= bytes.length) return c.close();
        c.enqueue(bytes.slice(pos, pos + chunk));
        pos += chunk;
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Length": String(bytes.length) } });
  }) as typeof fetch;
  return { fetch: f, calls };
}
