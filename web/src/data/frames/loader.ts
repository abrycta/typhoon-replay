// Host-agnostic TYF frame loader (runs inside the decode worker; pure enough to unit-test in Node).
//
// One request decides the strategy: GET with `Range: bytes=0-<probe>`.
//   206 -> range windows: the header comes from the probe, then frame windows are fetched nearest the
//          playhead first (prioritise() reorders them while scrubbing).
//   200 -> the host ignores ranges (Cloudflare Pages does): keep reading that same response as a stream
//          and emit each frame as soon as its bytes arrive (the file is frame-major).
// `.tyf.gz` is always streamed through DecompressionStream.

import { frameBytes, parseHeader, type TyfHeader, windToUv } from "./tyf";

export type Strategy = "range" | "stream";

export interface DecodedFrames {
  /** Index of the first frame in this batch. */
  start: number;
  /** `count` frames of raw quantised bytes, concatenated. */
  raw: Uint8Array;
  /** `count` frames of u/v (RG8) for the particle layer, concatenated. */
  uv: Uint8Array;
  count: number;
}

export interface FrameSink {
  header(header: TyfHeader, strategy: Strategy, totalBytes?: number): void;
  frames(batch: DecodedFrames): void;
  progress?(loadedBytes: number, totalBytes?: number): void;
}

export interface LoadOptions {
  format?: "tyf" | "tyf.gz";
  /** Frame to load first. */
  focus?: number;
  probeBytes?: number;
  windowFrames?: number;
  concurrency?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export class FrameLoadError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

function decodeBatch(h: TyfHeader, start: number, raw: Uint8Array): DecodedFrames {
  const fb = frameBytes(h);
  const count = Math.floor(raw.length / fb);
  const n = h.nx * h.ny;
  const uv = new Uint8Array(count * n * 2);
  for (let i = 0; i < count; i++) uv.set(windToUv(raw.subarray(i * fb, (i + 1) * fb), h), i * n * 2);
  return { start, raw: raw.slice(0, count * fb), uv, count };
}

/** Frame-index windows ordered by distance from `focus` (forward first). */
export function windowOrder(frames: number, size: number, focus: number, done: (w: number) => boolean): number[] {
  const count = Math.ceil(frames / size);
  const f = Math.min(count - 1, Math.max(0, Math.floor(focus / size)));
  const order: number[] = [];
  for (let d = 0; d < count; d++) {
    for (const w of [f + d, f - d]) if (w >= 0 && w < count && !order.includes(w) && !done(w)) order.push(w);
  }
  return order;
}

export class TyfLoader {
  private focus = 0;
  private header?: TyfHeader;
  private dataOffset = 0;

  constructor(private readonly url: string, private readonly sink: FrameSink, private readonly opts: LoadOptions = {}) {
    this.focus = opts.focus ?? 0;
  }

  prioritise(frame: number) {
    this.focus = frame;
  }

  async run(): Promise<Strategy> {
    const f = this.opts.fetch ?? fetch;
    const gz = this.opts.format === "tyf.gz" || this.url.endsWith(".gz");
    const probe = this.opts.probeBytes ?? 65536;
    const res = await f(this.url, { headers: gz ? {} : { Range: `bytes=0-${probe - 1}` }, signal: this.opts.signal });
    if (res.status === 206 && !gz) {
      await this.ranges(res);
      return "range";
    }
    if (!res.ok) throw new FrameLoadError(`frames: HTTP ${res.status}`, res.status);
    await this.stream(res, gz);
    return "stream";
  }

  private async stream(res: Response, gz: boolean) {
    if (!res.body) throw new FrameLoadError("frames: response has no body");
    const lenHeader = Number(res.headers.get("Content-Length") ?? "");
    const total = !gz && lenHeader > 0 ? lenHeader : undefined;
    const body = gz ? res.body.pipeThrough(new DecompressionStream("gzip")) : res.body;
    const reader = body.getReader();
    let buf = new Uint8Array(total ?? 1 << 20);
    let len = 0;
    let emitted = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (len + value.length > buf.length) {
        const next = new Uint8Array(Math.max(buf.length * 2, len + value.length));
        next.set(buf.subarray(0, len));
        buf = next;
      }
      buf.set(value, len);
      len += value.length;
      this.sink.progress?.(len, total);
      if (!this.header) {
        const parsed = parseHeader(buf.subarray(0, len));
        if (!parsed) continue;
        this.header = parsed.header;
        this.dataOffset = parsed.dataOffset;
        this.sink.header(parsed.header, "stream", total);
      }
      const fb = frameBytes(this.header);
      const complete = Math.min(this.header.frames, Math.floor((len - this.dataOffset) / fb));
      if (complete > emitted) {
        this.sink.frames(decodeBatch(this.header, emitted, buf.subarray(this.dataOffset + emitted * fb, this.dataOffset + complete * fb)));
        emitted = complete;
      }
    }
    if (!this.header) throw new FrameLoadError("frames: file ended before the header");
    if (emitted < this.header.frames) throw new FrameLoadError(`frames: file truncated (${emitted}/${this.header.frames} frames)`);
  }

  private async ranges(first: Response) {
    const f = this.opts.fetch ?? fetch;
    const total = Number(first.headers.get("Content-Range")?.split("/")[1] ?? "") || undefined;
    let head = new Uint8Array(await first.arrayBuffer());
    let parsed = parseHeader(head);
    if (!parsed) {
      // Header longer than the probe: fetch exactly the rest of it.
      const hlen = new DataView(head.buffer).getUint32(4, true);
      const more = await f(this.url, { headers: { Range: `bytes=${head.length}-${8 + hlen - 1}` }, signal: this.opts.signal });
      const rest = new Uint8Array(await more.arrayBuffer());
      const joined = new Uint8Array(head.length + rest.length);
      joined.set(head);
      joined.set(rest, head.length);
      head = joined;
      parsed = parseHeader(head);
      if (!parsed) throw new FrameLoadError("frames: could not read header");
    }
    const h = parsed.header;
    this.header = h;
    this.dataOffset = parsed.dataOffset;
    this.sink.header(h, "range", total);
    const fb = frameBytes(h);
    const size = this.opts.windowFrames ?? 24;
    const windows = Math.ceil(h.frames / size);
    const done = new Set<number>();
    let loaded = head.length;

    // Frames already inside the probe.
    const inProbe = Math.min(h.frames, Math.floor((head.length - parsed.dataOffset) / fb));
    if (inProbe > 0) this.sink.frames(decodeBatch(h, 0, head.subarray(parsed.dataOffset, parsed.dataOffset + inProbe * fb)));
    for (let w = 0; w < windows; w++) if (Math.min(h.frames, (w + 1) * size) <= inProbe) done.add(w);

    const inflight = new Set<number>();
    const next = () => windowOrder(h.frames, size, this.focus, (w) => done.has(w) || inflight.has(w))[0];
    const worker = async () => {
      for (let w = next(); w !== undefined; w = next()) {
        inflight.add(w);
        const a = w * size;
        const b = Math.min(h.frames, a + size);
        const from = this.dataOffset + a * fb;
        const to = this.dataOffset + b * fb - 1;
        const res = await f(this.url, { headers: { Range: `bytes=${from}-${to}` }, signal: this.opts.signal });
        if (res.status !== 206 && !res.ok) throw new FrameLoadError(`frames: HTTP ${res.status}`, res.status);
        let bytes = new Uint8Array(await res.arrayBuffer());
        if (res.status === 200) bytes = bytes.subarray(from, to + 1); // host changed its mind: slice the full file
        if (bytes.length < to - from + 1) throw new FrameLoadError("frames: short range response");
        loaded += bytes.length;
        this.sink.progress?.(loaded, total);
        this.sink.frames(decodeBatch(h, a, bytes));
        inflight.delete(w);
        done.add(w);
      }
    };
    await Promise.all(Array.from({ length: this.opts.concurrency ?? 2 }, worker));
  }
}
