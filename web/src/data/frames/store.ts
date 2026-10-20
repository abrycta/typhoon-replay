// Main-thread frame store: owns one decode worker per opened storm and keeps decoded frames by index.
// React reads it through useSyncExternalStore (see useFrameStore in ../hooks.ts).
import * as Comlink from "comlink";

import type { DecodeWorkerApi } from "./decode.worker";
import type { DecodedFrames, FrameSink, Strategy } from "./loader";
import { frameBytes, type TyfHeader } from "./tyf";

export interface FrameStoreSnapshot {
  header?: TyfHeader;
  strategy?: Strategy;
  loadedFrames: number;
  loadedBytes: number;
  totalBytes?: number;
  error?: string;
  done: boolean;
}

export class FrameStore {
  private raw: (Uint8Array | undefined)[] = [];
  private uvs: (Uint8Array | undefined)[] = [];
  private listeners = new Set<() => void>();
  private worker?: Worker;
  private api?: Comlink.Remote<DecodeWorkerApi>;
  private snap: FrameStoreSnapshot = { loadedFrames: 0, loadedBytes: 0, done: false };
  /** Bumped on every change; lets the map layer know when to re-upload. */
  version = 0;

  static open(url: string, format: "tyf" | "tyf.gz", focus = 0): FrameStore {
    const store = new FrameStore();
    store.start(url, format, focus);
    return store;
  }

  private start(url: string, format: "tyf" | "tyf.gz", focus: number) {
    this.worker = new Worker(new URL("./decode.worker.ts", import.meta.url), { type: "module", name: "tyf-decode" });
    this.api = Comlink.wrap<DecodeWorkerApi>(this.worker);
    const sink: FrameSink = {
      header: (header, strategy, totalBytes) => this.update({ header, strategy, totalBytes }),
      frames: (b) => this.add(b),
      progress: (loadedBytes, totalBytes) => this.update({ loadedBytes, totalBytes: totalBytes ?? this.snap.totalBytes }),
    };
    this.api
      .open(url, Comlink.proxy(sink), { format, focus })
      .then(() => this.update({ done: true }))
      .catch((e: unknown) => this.update({ error: e instanceof Error ? e.message : String(e), done: true }));
  }

  /** For tests and the static fallback: fill the store from an in-memory file. */
  static fromFrames(header: TyfHeader, batch: DecodedFrames): FrameStore {
    const s = new FrameStore();
    s.update({ header, strategy: "stream", done: true });
    s.add(batch);
    return s;
  }

  private add(b: DecodedFrames) {
    const h = this.snap.header;
    if (!h) return;
    const fb = frameBytes(h);
    const uvb = h.nx * h.ny * 2;
    let added = 0;
    for (let i = 0; i < b.count; i++) {
      const k = b.start + i;
      if (!this.raw[k]) added++;
      this.raw[k] = b.raw.subarray(i * fb, (i + 1) * fb);
      this.uvs[k] = b.uv.subarray(i * uvb, (i + 1) * uvb);
    }
    this.update({ loadedFrames: this.snap.loadedFrames + added });
  }

  private update(patch: Partial<FrameStoreSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.version++;
    for (const l of this.listeners) l();
  }

  frame(i: number): Uint8Array | undefined {
    return this.raw[i];
  }
  uv(i: number): Uint8Array | undefined {
    return this.uvs[i];
  }
  has(i: number): boolean {
    return this.raw[i] !== undefined;
  }
  /** Fraction of frames loaded contiguously from frame `from` (for the buffered bar). */
  bufferedFrom(from: number): number {
    let i = Math.max(0, from);
    while (i < this.raw.length && this.raw[i]) i++;
    return i;
  }

  prioritise(i: number) {
    void this.api?.prioritise(i);
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = () => this.snap;

  dispose() {
    void this.api?.cancel();
    this.api?.[Comlink.releaseProxy]();
    this.worker?.terminate();
    this.listeners.clear();
  }
}
