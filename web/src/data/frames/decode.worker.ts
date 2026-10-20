// Frame decode worker: fetches and decodes a storm's frames off the main thread (Comlink RPC):
// WebP sheet sets (./webp.ts) or a TYF file (./loader.ts), falling back to the .tyf when WebP fails.
import * as Comlink from "comlink";

import { type FrameSink, type LoadOptions, type Strategy, TyfLoader } from "./loader";
import { type FrameSource, WebpLoader } from "./webp";

let current: { loader?: TyfLoader; abort: AbortController } | undefined;

const api = {
  async open(source: FrameSource, sink: FrameSink, opts: Omit<LoadOptions, "signal" | "fetch" | "format">): Promise<Strategy> {
    current?.abort.abort();
    const abort = new AbortController();
    const state: NonNullable<typeof current> = { abort };
    current = state;
    // Wrap the proxied sink so decoded buffers are transferred, not copied.
    const local: FrameSink = {
      header: (h, s, t) => sink.header(h, s, t),
      frames: (b) => sink.frames(Comlink.transfer(b, [b.raw.buffer, b.uv.buffer])),
      progress: (l, t) => sink.progress?.(l, t),
      exact: (b) => sink.exact?.(Comlink.transfer(b, [b.raw.buffer])),
    };
    let tyf = source.kind === "tyf" ? source : undefined;
    if (source.kind === "webp") {
      try {
        return await new WebpLoader(source, local, { signal: abort.signal }).run();
      } catch (e) {
        if (abort.signal.aborted || !source.fallback) throw e;
        console.warn("WebP frames failed, loading the .tyf:", e instanceof Error ? e.message : e);
        tyf = source.fallback;
      }
    }
    state.loader = new TyfLoader(tyf!.url, local, { ...opts, format: tyf!.format, signal: abort.signal });
    return state.loader.run();
  },
  prioritise(frame: number) {
    current?.loader?.prioritise(frame);
  },
  cancel() {
    current?.abort.abort();
    current = undefined;
  },
};

export type DecodeWorkerApi = typeof api;
Comlink.expose(api);
