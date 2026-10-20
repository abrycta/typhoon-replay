// Frame decode worker: fetches and decodes TYF frames off the main thread (Comlink RPC).
import * as Comlink from "comlink";

import { type FrameSink, type LoadOptions, type Strategy, TyfLoader } from "./loader";

let current: { loader: TyfLoader; abort: AbortController } | undefined;

const api = {
  async open(url: string, sink: FrameSink, opts: Omit<LoadOptions, "signal" | "fetch">): Promise<Strategy> {
    current?.abort.abort();
    const abort = new AbortController();
    // Wrap the proxied sink so decoded buffers are transferred, not copied.
    const local: FrameSink = {
      header: (h, s, t) => sink.header(h, s, t),
      frames: (b) => sink.frames(Comlink.transfer(b, [b.raw.buffer, b.uv.buffer])),
      progress: (l, t) => sink.progress?.(l, t),
    };
    const loader = new TyfLoader(url, local, { ...opts, signal: abort.signal });
    current = { loader, abort };
    return loader.run();
  },
  prioritise(frame: number) {
    current?.loader.prioritise(frame);
  },
  cancel() {
    current?.abort.abort();
    current = undefined;
  },
};

export type DecodeWorkerApi = typeof api;
Comlink.expose(api);
