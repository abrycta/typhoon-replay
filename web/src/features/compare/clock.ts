// The compare view's one clock: a fractional position in hours on the shared timeline. Both replays follow it
// (StormReplay `leader`); React re-renders only when the whole hour or the play state changes.
import { useEffect, useMemo } from "react";

/** Playback speeds in hours per second (6 h/s, 12 h/s, 1 day/s). */
export const COMPARE_SPEEDS = [6, 12, 24] as const;
export type CompareSpeed = (typeof COMPARE_SPEEDS)[number];

export interface SharedClockState {
  index: number;
  playing: boolean;
  buffering: boolean;
  speed: CompareSpeed;
}

export class SharedClock {
  pos = 0;
  private state: SharedClockState;
  private listeners = new Set<() => void>();
  private ticks = new Set<(pos: number) => void>();
  private ready = new Set<(pos: number) => boolean>();
  private raf = 0;
  private last: number | undefined;

  constructor(
    readonly frames: number,
    index = 0,
    speed: CompareSpeed = 6,
  ) {
    this.pos = Math.min(Math.max(0, index), Math.max(0, frames - 1));
    this.state = { index: Math.round(this.pos), playing: false, buffering: false, speed };
  }

  get snapshot() {
    return this.state;
  }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  onTick(fn: (pos: number) => void) {
    this.ticks.add(fn);
    return () => void this.ticks.delete(fn);
  }
  addReadyCheck(fn: (pos: number) => boolean) {
    this.ready.add(fn);
    return () => void this.ready.delete(fn);
  }

  private set(patch: Partial<SharedClockState>) {
    const n = { ...this.state, ...patch };
    if (n.index === this.state.index && n.playing === this.state.playing && n.buffering === this.state.buffering && n.speed === this.state.speed) return;
    this.state = n;
    for (const l of this.listeners) l();
  }
  private moved() {
    for (const f of this.ticks) f(this.pos);
    this.set({ index: Math.floor(this.pos + 1e-6) });
  }
  private isReady(p: number) {
    for (const f of this.ready) if (!f(p)) return false;
    return true;
  }

  seek(index: number) {
    if (this.frames < 1) return;
    this.pos = Math.min(Math.max(0, Math.round(index)), this.frames - 1);
    this.moved();
  }
  step(delta: number) {
    this.seek(Math.floor(this.pos + 1e-6) + delta);
  }
  setSpeed(speed: CompareSpeed) {
    this.set({ speed });
  }
  play() {
    if (this.frames < 2) return;
    if (this.pos >= this.frames - 1) this.pos = 0;
    this.set({ playing: true });
    this.last = undefined;
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
  }
  pause() {
    cancelAnimationFrame(this.raf);
    this.set({ playing: false, buffering: false });
  }
  toggle() {
    if (this.state.playing) this.pause();
    else this.play();
  }

  private tick = (now: number) => {
    if (!this.state.playing) return;
    const dt = this.last === undefined ? 0 : Math.min(0.25, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const cur = Math.floor(this.pos + 1e-6);
    if (!this.isReady(cur) || !this.isReady(Math.min(this.frames - 1, cur + 1))) {
      this.set({ buffering: true }); // hold until both replays have their frames
    } else {
      this.set({ buffering: false });
      this.pos += dt * this.state.speed;
      if (this.pos >= this.frames - 1) {
        this.pos = this.frames - 1;
        this.moved();
        this.pause();
        return;
      }
      this.moved();
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    this.listeners.clear();
    this.ticks.clear();
    this.ready.clear();
  }
}

/** A clock for `frames` hours, recreated when the timeline changes (`key`: storms and alignment). */
export function useSharedClock(frames: number, index: number, key: string) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const clock = useMemo(() => new SharedClock(frames, index), [frames, key]);
  useEffect(() => () => clock.dispose(), [clock]);
  return clock; // subscribers (the line-up, overlays) read its state; the page itself does not re-render per hour
}
