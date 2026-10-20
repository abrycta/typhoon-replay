import { describe, expect, it } from "vitest";

import { type DecodedFrames, FrameLoadError, type FrameSink } from "./loader";
import { decoder, maxNear, type TyfHeader, type TyfVar, UV_SCALE } from "./tyf";
import {
  cutTiles,
  type ExactFrames,
  type GreyImage,
  greyFromRgb,
  interleave,
  type SheetGeometry,
  type SheetVar,
  uvFromCodes,
  WebpLoader,
  type WebpSource,
  Y_TO_GREY,
} from "./webp";

const V = {
  wind: { name: "wind", units: "m/s", encoding: "linear", scale: 0.3, offset: 0 },
  gust: { name: "gust", units: "m/s", encoding: "linear", scale: 0.4, offset: 0 },
  mslp: { name: "mslp", units: "hPa", encoding: "linear", scale: 0.65, offset: 870 },
  tp: { name: "tp", units: "mm/h", encoding: "sqrt", scale: 0.04, offset: 0 },
  u: { name: "u", units: "m/s", encoding: "linear", scale: 0.6, offset: -76.2 },
  v: { name: "v", units: "m/s", encoding: "linear", scale: 0.6, offset: -76.2 },
} satisfies Record<string, TyfVar>;

/** A greyscale sprite sheet as the pipeline lays it out (frames.sheet): tiles on a stride, edge-padded. */
function makeSheet(codes: Uint8Array, g: SheetGeometry): GreyImage {
  const rows = Math.ceil(g.frames / g.cols);
  const width = g.cols * g.tileStride, height = rows * g.tileStride;
  const data = new Uint8Array(width * height);
  const n = g.tileWidth * g.tileHeight;
  for (let k = 0; k < g.frames; k++) {
    const x0 = (k % g.cols) * g.tileStride, y0 = Math.floor(k / g.cols) * g.tileStride;
    for (let y = 0; y < g.tileStride; y++)
      for (let x = 0; x < g.tileStride; x++) data[(y0 + y) * width + x0 + x] = codes[k * n + Math.min(y, g.tileHeight - 1) * g.tileWidth + Math.min(x, g.tileWidth - 1)]!;
  }
  return { width, height, stride: width, data };
}

/** The same sheet as 4-byte pixels (what a canvas or an RGB(X) ImageDecoder frame gives), rows padded to `stride`. */
function toRgbx(img: GreyImage, pixel: (q: number) => [number, number, number], stride = img.width * 4 + 8) {
  const px = new Uint8Array(stride * img.height);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) px.set([...pixel(img.data[y * img.width + x]!), 255], y * stride + x * 4);
  return { px, stride };
}

const geometry: SheetGeometry = { frames: 7, cols: 3, tileWidth: 5, tileHeight: 4, tileStride: 8 };
const codesFor = (seed: number, g = geometry) => Uint8Array.from({ length: g.frames * g.tileWidth * g.tileHeight }, (_, i) => (i * 7 + seed * 31) % 255);

describe("WebP sheet decoding", () => {
  it("cuts stride-padded tiles back into frame-major codes", () => {
    const codes = codesFor(1);
    expect(cutTiles(makeSheet(codes, geometry), geometry)).toEqual(codes);
  });

  it("reads grey from RGB(X) pixels the way the pipeline does (Pillow's L conversion), in either channel order", () => {
    const codes = codesFor(2);
    const sheet = makeSheet(codes, geometry);
    const grey = toRgbx(sheet, (q) => [q, q, q]);
    expect(cutTiles(greyFromRgb(grey.px, sheet.width, sheet.height, grey.stride), geometry)).toEqual(codes);
    // A lossy decode returns near-grey RGB; luma must still land on the code.
    const noisy = toRgbx(sheet, (q) => [Math.min(255, q + 1), q, Math.max(0, q - 1)]);
    const back = cutTiles(greyFromRgb(noisy.px, sheet.width, sheet.height, noisy.stride), geometry);
    for (let i = 0; i < codes.length; i++) expect(Math.abs(back[i]! - codes[i]!)).toBeLessThanOrEqual(1);
    // BGR order weighs the channels the other way round: R=40, G=0, B=0 as BGRX bytes [0, 0, 40].
    expect(greyFromRgb(Uint8Array.from([0, 0, 40, 255]), 1, 1, 4, "bgr").data[0]).toBe(greyFromRgb(Uint8Array.from([40, 0, 0, 255]), 1, 1).data[0]);
  });

  it("maps lossy WebP luma (limited range) to grey as libwebp does", () => {
    // libwebp: R = G = B = clip8((MultHi(y, 19077) - 1160) >> 6) for neutral chroma.
    expect(Y_TO_GREY[16]).toBe(0);
    expect(Y_TO_GREY[43]).toBe(31); // a pixel of the Haiyan fixture's wind sheet: Y 43 decodes to 31 on a canvas
    expect(Y_TO_GREY[235]).toBe(255);
    expect(Y_TO_GREY[255]).toBe(255);
    for (let y = 17; y < 256; y++) expect(Y_TO_GREY[y]!).toBeGreaterThanOrEqual(Y_TO_GREY[y - 1]!);
  });

  it("rejects a sheet smaller than its manifest", () => {
    const img = makeSheet(codesFor(3), geometry);
    expect(() => cutTiles({ ...img, width: img.width - 9 }, geometry)).toThrow(FrameLoadError);
  });

  it("interleaves per-variable blocks into the .tyf frame layout", () => {
    const a = Uint8Array.from([1, 2, 3, 4]), b = Uint8Array.from([5, 6, 7, 8]); // 2 frames x 2 cells
    expect(interleave(2, 2, [a, b])).toEqual(Uint8Array.from([1, 2, 5, 6, 3, 4, 7, 8]));
  });

  it("packs u/v codes into the particle texture (offset 128, UV_SCALE per step), nodata as calm", () => {
    const q = (ms: number) => Math.round((ms + 76.2) / 0.6);
    const uv = uvFromCodes(Uint8Array.from([q(0), q(12), 255]), Uint8Array.from([q(-6), q(40), 3]), V.u, V.v, 255);
    expect(uv[0]).toBe(128);
    expect(uv[1]).toBe(Math.round(decoder(V.v)(q(-6)) / UV_SCALE + 128));
    expect(uv[2]).toBe(Math.round(decoder(V.u)(q(12)) / UV_SCALE + 128));
    expect(uv[3]).toBe(Math.round(decoder(V.v)(q(40)) / UV_SCALE + 128));
    expect([uv[4], uv[5]]).toEqual([128, 0]); // u nodata -> 128; v -74.4 m/s clamps at 0
  });
});

describe("WebpLoader", () => {
  const g: SheetGeometry = { frames: 5, cols: 3, tileWidth: 4, tileHeight: 3, tileStride: 6 };
  const n = g.tileWidth * g.tileHeight;
  const names = ["wind", "gust", "mslp", "tp", "u", "v"] as const;
  const codes = Object.fromEntries(names.map((name, i) => [name, codesFor(i + 1, g)])) as Record<(typeof names)[number], Uint8Array>;
  const header: TyfHeader = {
    format: "webp",
    sid: "2020299N11144",
    nx: g.tileWidth,
    ny: g.tileHeight,
    res_deg: 0.25,
    frames: g.frames,
    nodata: 255,
    vars: [V.wind, V.gust, V.mslp, V.tp],
    time: Array.from({ length: g.frames }, (_, i) => 1604102400 + i * 3600),
    nw_lat: Array(g.frames).fill(14) as number[],
    nw_lon: Array(g.frames).fill(124) as number[],
  };
  const sheetVar = (name: (typeof names)[number], kind = "field"): SheetVar => ({ name, url: `/frames/x.${kind}.${name}.webp`, bytes: 100, meta: V[name] });

  // Exact grid: every other cell, every 3rd hour (frames 0 and 3).
  const eg: SheetGeometry = { frames: 2, cols: 2, tileWidth: 2, tileHeight: 2, tileStride: 2 };
  const exactCodes = { wind: Uint8Array.from([10, 20, 30, 200, 11, 21, 31, 41]), mslp: Uint8Array.from([150, 140, 130, 120, 151, 141, 131, 121]) };

  /** Fake host + decoder: each URL serves a token; decoding the token yields the sheet image. */
  function host(opts: { fail?: string } = {}) {
    const images = new Map<string, GreyImage>();
    for (const name of names) images.set(`/frames/x.field.${name}.webp`, makeSheet(codes[name], g));
    images.set("/frames/x.exact.wind.webp", makeSheet(exactCodes.wind, eg));
    images.set("/frames/x.exact.mslp.webp", makeSheet(exactCodes.mslp, eg));
    const requested: string[] = [];
    const fetch = (async (url: RequestInfo | URL) => {
      const u = String(url);
      requested.push(u);
      if (u === opts.fail || !images.has(u)) return new Response("missing", { status: 404 });
      return new Response(new TextEncoder().encode(u), { status: 200, headers: { "Content-Type": "image/webp" } });
    }) as typeof globalThis.fetch;
    const decode = async (buf: ArrayBuffer) => images.get(new TextDecoder().decode(buf))!;
    return { fetch, decode, requested };
  }

  function sink() {
    const out = { strategy: "", batches: [] as DecodedFrames[], exact: [] as ExactFrames[], total: 0 as number | undefined };
    const s: FrameSink = {
      header: (_h, strategy, total) => void Object.assign(out, { strategy, total }),
      frames: (b) => void out.batches.push(b),
      exact: (b) => void out.exact.push(b),
    };
    return { s, out };
  }

  const source = (exact = false): WebpSource => ({
    kind: "webp",
    header,
    field: { geometry: g, vars: names.map((x) => sheetVar(x)) },
    exact: exact
      ? {
          frameIndex: [0, 3],
          set: { geometry: eg, vars: [sheetVar("wind", "exact"), sheetVar("mslp", "exact")] },
          header: { ...header, nx: 2, ny: 2, res_deg: 0.5, frames: 2, vars: [V.wind, V.mslp], time: [header.time[0]!, header.time[3]!], nw_lat: [14, 14], nw_lon: [124, 124] },
        }
      : undefined,
  });

  it("emits every frame in the .tyf layout with u/v for the particles", async () => {
    const { fetch, decode, requested } = host();
    const { s, out } = sink();
    expect(await new WebpLoader(source(), s, { fetch, decode }).run()).toBe("webp");
    expect(out.strategy).toBe("webp");
    expect(out.total).toBe(600);
    expect(requested).toHaveLength(6); // field sheets only: no exact grid without a request for it
    expect(out.batches).toHaveLength(1);
    const b = out.batches[0]!;
    expect(b.count).toBe(5);
    for (let f = 0; f < 5; f++) {
      const frame = b.raw.subarray(f * 4 * n, (f + 1) * 4 * n);
      ["wind", "gust", "mslp", "tp"].forEach((name, vi) =>
        expect(frame.subarray(vi * n, (vi + 1) * n)).toEqual(codes[name as "wind"].subarray(f * n, (f + 1) * n)),
      );
    }
    expect(b.uv).toEqual(uvFromCodes(codes.u, codes.v, V.u, V.v, 255));
  });

  it("loads the lossless exact grid on request; readouts use it, not the lossy sheets", async () => {
    const { fetch, decode } = host();
    const { s, out } = sink();
    await new WebpLoader(source(true), s, { fetch, decode }).run();
    expect(out.exact).toHaveLength(1);
    const e = out.exact[0]!;
    expect(e.frameIndex).toEqual([0, 3]);
    // hour 3 = exact tile 1: wind codes [11, 21, 31, 41] -> max 41 * 0.3 m/s
    const tile = e.raw.subarray(8, 16);
    expect(maxNear(tile, e.header, 1, "wind", 124.25, 13.75, 2)).toBeCloseTo(41 * 0.3, 5);
    expect(maxNear(tile, e.header, 1, "mslp", 124.25, 13.75, 2, "min")).toBeCloseTo(870 + 121 * 0.65, 5);
  });

  it("fails on a missing field sheet, but a missing exact sheet only loses the readouts", async () => {
    const bad = host({ fail: "/frames/x.field.tp.webp" });
    await expect(new WebpLoader(source(), sink().s, bad).run()).rejects.toBeInstanceOf(FrameLoadError);
    const partial = host({ fail: "/frames/x.exact.mslp.webp" });
    const { s, out } = sink();
    const warn = console.warn;
    console.warn = () => {};
    try {
      await new WebpLoader(source(true), s, partial).run();
    } finally {
      console.warn = warn;
    }
    expect(out.batches).toHaveLength(1);
    expect(out.exact).toHaveLength(0);
  });

  it("rejects an HTML page served in place of a sheet", async () => {
    const html = (async () => new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } })) as typeof fetch;
    await expect(new WebpLoader(source(), sink().s, { fetch: html, decode: host().decode }).run()).rejects.toThrow(/HTML/);
  });
});
