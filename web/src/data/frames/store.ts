// Main-thread frame store: owns one decode worker per opened storm and keeps decoded frames by index.
// React reads it through useSyncExternalStore (see useFrameStore in ../hooks.ts).
import * as Comlink from "comlink";

import { isLeavingPage, onPageExit } from "@/shared/lib/page-exit";

import type { DecodeWorkerApi } from "./decode.worker";
import type { DecodedFrames, FrameSink, Strategy } from "./loader";
import { frameBytes, type TyfHeader } from "./tyf";
import type { ExactFrames, FrameSource } from "./webp";

export interface FrameStoreSnapshot {
  header?: TyfHeader;
  strategy?: Strategy;
  loadedFrames: number;
  loadedBytes: number;
  totalBytes?: number;
  error?: string;
  done: boolean;
  /** Hours with lossless readout codes (WebP storms without per-frame `series` only). */
  exactFrames?: number;
}

/** Lossless codes for one hour of the 3-hourly exact grid; `k` indexes `header`'s frames. */
export interface ExactAt {
  raw: Uint8Array;
  header: TyfHeader;
  k: number;
}

export class FrameStore {
  private raw: (Uint8Array | undefined)[] = [];
  private uvs: (Uint8Array | undefined)[] = [];
  private exact?: { header: TyfHeader; byHour: Map<number, number>; raw: Uint8Array };
  private listeners = new Set<() => void>();
  private worker?: Worker;
  private api?: Comlink.Remote<DecodeWorkerApi>;
  private offPageExit?: () => void;
  private snap: FrameStoreSnapshot = { loadedFrames: 0, loadedBytes: 0, done: false };
  /** Bumped on every change; lets the map layer know when to re-upload. */
  version = 0;

  static open(source: FrameSource, focus = 0): FrameStore {
    const store = new FrameStore();
    store.start(source, focus);
    return store;
  }

  private start(source: FrameSource, focus: number) {
    // WebP geometry comes with the summary: publish it now, so the timeline does not wait for the worker.
    if (source.kind === "webp") this.update({ header: source.header, strategy: "webp" });
    this.worker = new Worker(new URL("./decode.worker.ts", import.meta.url), { type: "module", name: "frame-decode" });
    this.api = Comlink.wrap<DecodeWorkerApi>(this.worker);
    // Leaving the page: the worker stops loading (and must not answer cancelled sheets by loading the .tyf). Should the
    // reader stay after all, the load starts again.
    this.offPageExit = onPageExit((leaving) => {
      void this.api?.pageExit(leaving);
      if (!leaving && this.interrupted) {
        this.interrupted = false;
        this.load(source, focus);
      }
    });
    this.load(source, focus);
  }

  private interrupted = false;

  private load(source: FrameSource, focus: number) {
    const sink: FrameSink = {
      header: (header, strategy, totalBytes) => {
        // A WebP storm that fell back to its .tyf: another frame layout, so drop anything stored.
        if (this.snap.header && this.snap.header.format !== header.format) this.reset();
        this.update({ header, strategy, totalBytes });
      },
      frames: (b) => this.add(b),
      progress: (loadedBytes, totalBytes) => this.update({ loadedBytes, totalBytes: totalBytes ?? this.snap.totalBytes }),
      exact: (b) => this.addExact(b),
    };
    this.api
      ?.open(source, Comlink.proxy(sink), { focus })
      .then(() => this.update({ done: true }))
      .catch((e: unknown) => {
        if (isLeavingPage()) this.interrupted = true;
        else this.update({ error: e instanceof Error ? e.message : String(e), done: true });
      });
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

  private addExact(b: ExactFrames) {
    this.exact = { header: b.header, raw: b.raw, byHour: new Map(b.frameIndex.map((hour, k) => [hour, k])) };
    this.update({ exactFrames: b.frameIndex.length });
  }

  private reset() {
    this.raw = [];
    this.uvs = [];
    this.exact = undefined;
    this.snap = { loadedFrames: 0, loadedBytes: 0, done: false };
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
  /** Lossless readout codes at hour i, when i is one of the exact grid's (3-hourly) hours. */
  exactAt(i: number): ExactAt | undefined {
    const e = this.exact;
    const k = e?.byHour.get(i);
    if (!e || k === undefined) return undefined;
    const fb = frameBytes(e.header);
    return { raw: e.raw.subarray(k * fb, (k + 1) * fb), header: e.header, k };
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
    this.offPageExit?.();
    void this.api?.cancel();
    this.api?.[Comlink.releaseProxy]();
    this.worker?.terminate();
    this.listeners.clear();
  }
}
