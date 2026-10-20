// WebP frame sets (pipeline/typhoon/frames.py; summary.frames.field and .exact):
//   field  lossy WebP (q80), hourly, one greyscale sheet per variable: wind, gust, mslp, tp, u, v.
//          81x81 tiles on a 96 px stride, so no codec block mixes two hours. For drawing only.
//   exact  lossless WebP, every 3rd hour, every other cell (41x41 at 0.5 deg): exact codes for readouts.
// Frame k of a sheet is the tile at column k % cols, row floor(k / cols), top-left pixel (col, row) * tileStride.
//
// The decode worker turns each sheet into RGBA (createImageBitmap + OffscreenCanvas), cuts it into tiles and
// re-packs them into the per-frame layout of a .tyf frame (uint8[vars][ny][nx]) plus the RG8 u/v texture,
// so the map layer draws both formats with the same code. Lossy codes are never used for numbers.
import { type DecodedFrames, FrameLoadError, type FrameSink } from "./loader";
import { decoder, type TyfHeader, type TyfVar, UV_SCALE } from "./tyf";

export interface SheetGeometry {
  frames: number;
  cols: number;
  tileWidth: number;
  tileHeight: number;
  tileStride: number;
}

export interface SheetVar {
  name: string;
  url: string;
  bytes?: number;
  meta: TyfVar;
}

export interface SheetSet {
  geometry: SheetGeometry;
  vars: SheetVar[];
}

export interface TyfSource {
  kind: "tyf";
  url: string;
  format: "tyf" | "tyf.gz";
}

export interface WebpSource {
  kind: "webp";
  /** Hourly drawing grid; its `vars` are the drawable fields in raw-frame order (wind, gust, mslp, tp). */
  header: TyfHeader;
  /** Sheets for header.vars plus u and v. */
  field: SheetSet;
  /** Lossless 3-hourly sheets for readouts; set only when the summary has no per-frame `series`. */
  exact?: { header: TyfHeader; frameIndex: number[]; set: SheetSet };
  /** The storm's .tyf, used if WebP cannot be fetched or decoded here. */
  fallback?: TyfSource;
}

export type FrameSource = TyfSource | WebpSource;

/** Exact (lossless) codes for the hours in `frameIndex`, packed like .tyf frames under `header`. */
export interface ExactFrames {
  header: TyfHeader;
  frameIndex: number[];
  raw: Uint8Array;
}

/** A decoded sheet as one byte per pixel (the codes), rows `stride` bytes apart. */
export interface GreyImage {
  width: number;
  height: number;
  stride: number;
  data: Uint8Array;
}

export type ImageDecode = (bytes: ArrayBuffer) => Promise<GreyImage>;

/**
 * Grey from 8-bit RGB(X) pixels the way the pipeline reads sheets back (Pillow's "L" conversion, ITU-R 601-2
 * luma), so a lossy sheet yields the codes its manifest's maxCodeError was measured on.
 */
export function greyFromRgb(px: Uint8Array | Uint8ClampedArray, width: number, height: number, stride = width * 4, order: "rgb" | "bgr" = "rgb"): GreyImage {
  const [wr, wb] = order === "rgb" ? [19595, 7471] : [7471, 19595];
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    let p = y * stride;
    let o = y * width;
    for (let x = 0; x < width; x++, p += 4) data[o++] = (px[p]! * wr + px[p + 1]! * 38470 + px[p + 2]! * wb + 0x8000) >>> 16;
  }
  return { width, height, stride: width, data };
}

/**
 * Lossy WebP decodes to VP8's limited-range luma (Y 16-235). For a grey sheet (neutral chroma) libwebp's
 * YUV->RGB gives R = G = B = clip8((MultHi(y, 19077) - 1160) >> 6); this table reproduces it.
 */
export const Y_TO_GREY = Uint8Array.from({ length: 256 }, (_, y) => Math.max(0, Math.min(255, (((y * 19077) >> 8) - 1160) >> 6)));

/** Cut a decoded sheet into `frames` tiles of codes, concatenated ([frames][tileHeight][tileWidth]). */
export function cutTiles(img: GreyImage, g: SheetGeometry): Uint8Array {
  const { frames, cols, tileWidth: tw, tileHeight: th, tileStride: s } = g;
  const rows = Math.ceil(frames / cols);
  if (img.width < (Math.min(cols, frames) - 1) * s + tw || img.height < (rows - 1) * s + th) {
    throw new FrameLoadError(`frames: sheet is ${img.width}x${img.height}, smaller than its manifest`);
  }
  const out = new Uint8Array(frames * tw * th);
  for (let k = 0; k < frames; k++) {
    const x0 = (k % cols) * s;
    const y0 = Math.floor(k / cols) * s;
    for (let y = 0; y < th; y++) {
      const p = (y0 + y) * img.stride + x0;
      out.set(img.data.subarray(p, p + tw), (k * th + y) * tw);
    }
  }
  return out;
}

/** Per-variable code blocks ([frames][n] each) -> frame-major [frames][vars][n], the .tyf frame layout. */
export function interleave(frames: number, n: number, codes: Uint8Array[]): Uint8Array {
  const nv = codes.length;
  const raw = new Uint8Array(frames * nv * n);
  for (let f = 0; f < frames; f++) for (let v = 0; v < nv; v++) raw.set(codes[v]!.subarray(f * n, (f + 1) * n), (f * nv + v) * n);
  return raw;
}

/** u/v codes -> the particle layer's RG8 texture (offset 128, UV_SCALE m/s per step); nodata -> calm. */
export function uvFromCodes(u: Uint8Array, v: Uint8Array, uVar: TyfVar, vVar: TyfVar, nodata: number): Uint8Array {
  const lut = (meta: TyfVar) => {
    const dec = decoder(meta);
    return Uint8Array.from({ length: 256 }, (_, q) => (q === nodata ? 128 : Math.max(0, Math.min(255, Math.round(dec(q) / UV_SCALE + 128)))));
  };
  const lu = lut(uVar), lv = lut(vVar);
  const out = new Uint8Array(u.length * 2);
  for (let k = 0; k < u.length; k++) {
    out[k * 2] = lu[u[k]!]!;
    out[k * 2 + 1] = lv[v[k]!]!;
  }
  return out;
}

let sharedCtx: OffscreenCanvasRenderingContext2D | undefined;

function context(): OffscreenCanvasRenderingContext2D {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
    throw new FrameLoadError("frames: this browser cannot decode WebP frames in a worker");
  }
  sharedCtx ??= new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true }) ?? undefined;
  if (!sharedCtx) throw new FrameLoadError("frames: no 2D canvas in this worker");
  return sharedCtx;
}

const hasImageDecoder = () => typeof ImageDecoder !== "undefined";

/**
 * Canvas path only: the first drawImage in a worker sets up the canvas backend (a GPU channel), which takes
 * hundreds of milliseconds on slow or software GPUs; doing it while the sheets download hides most of it.
 */
export async function warmDecoder(): Promise<void> {
  if (hasImageDecoder()) return;
  try {
    const ctx = context();
    const bmp = await createImageBitmap(new ImageData(1, 1));
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
  } catch {
    /* decodeImage reports the problem */
  }
}

/**
 * WebCodecs ImageDecoder (Chromium, Firefox): decodes on the CPU and hands over the codec's own planes, so
 * there is no canvas and no GPU readback. Lossy sheets come as I420 (grey = luma), lossless as RGB(X).
 * Returns undefined for a pixel format it does not know, so the caller can use the canvas instead.
 */
async function viaImageDecoder(bytes: ArrayBuffer): Promise<GreyImage | undefined> {
  const dec = new ImageDecoder({ data: bytes, type: "image/webp", colorSpaceConversion: "none" });
  try {
    const { image } = await dec.decode();
    try {
      const width = image.visibleRect?.width ?? image.displayWidth;
      const height = image.visibleRect?.height ?? image.displayHeight;
      const buf = new Uint8Array(image.allocationSize());
      const [plane] = await image.copyTo(buf);
      if (!plane) return undefined;
      const { offset, stride } = plane;
      switch (image.format) {
        case "I420":
        case "I420A":
        case "I422":
        case "I444":
        case "NV12": {
          const lut = image.colorSpace.fullRange ? undefined : Y_TO_GREY;
          const data = new Uint8Array(width * height);
          for (let y = 0; y < height; y++) {
            const row = buf.subarray(offset + y * stride, offset + y * stride + width);
            if (lut) for (let x = 0; x < width; x++) data[y * width + x] = lut[row[x]!]!;
            else data.set(row, y * width);
          }
          return { width, height, stride: width, data };
        }
        case "RGBA":
        case "RGBX":
          return greyFromRgb(buf.subarray(offset), width, height, stride, "rgb");
        case "BGRA":
        case "BGRX":
          return greyFromRgb(buf.subarray(offset), width, height, stride, "bgr");
        default:
          return undefined;
      }
    } finally {
      image.close();
    }
  } finally {
    dec.close();
  }
}

async function viaCanvas(bytes: ArrayBuffer): Promise<GreyImage> {
  const ctx = context();
  // No colour management or premultiplication: the pixels are codes, not colours.
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/webp" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  try {
    const { width, height } = bmp;
    if (ctx.canvas.width < width || ctx.canvas.height < height) {
      ctx.canvas.width = Math.max(ctx.canvas.width, width);
      ctx.canvas.height = Math.max(ctx.canvas.height, height);
    }
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bmp, 0, 0);
    return greyFromRgb(ctx.getImageData(0, 0, width, height).data, width, height);
  } finally {
    bmp.close();
  }
}

/** Decode a WebP sheet to its codes off the main thread: ImageDecoder where available, else a 2D canvas. */
export const decodeImage: ImageDecode = async (bytes) => (hasImageDecoder() ? await viaImageDecoder(bytes) : undefined) ?? viaCanvas(bytes);

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

export interface WebpLoadOptions {
  signal?: AbortSignal;
  fetch?: typeof fetch;
  decode?: ImageDecode;
  /** Parallel sheet requests (all six field sheets at once by default: they are small). */
  concurrency?: number;
}

/**
 * Loads a storm's WebP field sheets and emits every frame in one batch once all six are decoded (a sheet
 * holds every hour, so there is nothing to emit earlier). Then, when requested, the exact sheets for readouts.
 */
export class WebpLoader {
  private loaded = 0;

  constructor(private readonly source: WebpSource, private readonly sink: FrameSink, private readonly opts: WebpLoadOptions = {}) {}

  private async sheet(v: SheetVar, g: SheetGeometry, total?: number): Promise<Uint8Array> {
    const f = this.opts.fetch ?? fetch;
    const res = await f(v.url, { signal: this.opts.signal });
    if (!res.ok) throw new FrameLoadError(`frames: HTTP ${res.status} (${v.name} sheet)`, res.status);
    const type = res.headers.get("Content-Type") ?? "";
    if (type.includes("text/html")) throw new FrameLoadError(`frames: got HTML, not WebP (${v.name} sheet)`);
    const buf = await res.arrayBuffer();
    this.loaded += buf.byteLength;
    this.sink.progress?.(this.loaded, total);
    return cutTiles(await (this.opts.decode ?? decodeImage)(buf), g);
  }

  async run(): Promise<"webp"> {
    const { header, field, exact } = this.source;
    const known = field.vars.every((v) => v.bytes);
    const total = known ? field.vars.reduce((s, v) => s + v.bytes!, 0) : undefined;
    this.sink.header(header, "webp", total);
    if (!this.opts.decode) void warmDecoder();
    const tiles = await mapLimit(field.vars, this.opts.concurrency ?? 6, (v) => this.sheet(v, field.geometry, total));
    const by = (name: string) => {
      const i = field.vars.findIndex((v) => v.name === name);
      if (i < 0) throw new FrameLoadError(`frames: no ${name} sheet`);
      return { codes: tiles[i]!, meta: field.vars[i]!.meta };
    };
    const n = header.nx * header.ny;
    const u = by("u"), v = by("v");
    this.opts.signal?.throwIfAborted();
    const batch: DecodedFrames = {
      start: 0,
      count: header.frames,
      raw: interleave(header.frames, n, header.vars.map((x) => by(x.name).codes)),
      uv: uvFromCodes(u.codes, v.codes, u.meta, v.meta, header.nodata),
    };
    this.sink.frames(batch);

    if (exact) {
      // Readouts only: a failure here leaves the drawing intact.
      try {
        const codes = await mapLimit(exact.set.vars, 2, (x) => this.sheet(x, exact.set.geometry));
        this.opts.signal?.throwIfAborted();
        const raw = interleave(exact.header.frames, exact.header.nx * exact.header.ny, codes);
        this.sink.exact?.({ header: exact.header, frameIndex: exact.frameIndex, raw });
      } catch (e) {
        if (this.opts.signal?.aborted) throw e;
        console.warn("exact frames:", e instanceof Error ? e.message : e);
      }
    }
    return "webp";
  }
}
