// Replay clock. The position is a fractional frame index (1 frame = 1 hour) so the map can blend
// between hourly frames; React only re-renders when the whole-hour index or play state changes,
// while the map reads the fractional position imperatively every animation frame.
import { useEffect, useMemo, useSyncExternalStore } from "react";

export const SPEEDS = [1, 2, 4, 8, 16] as const;
export type Speed = (typeof SPEEDS)[number];

export interface PlayerState {
  index: number;
  playing: boolean;
  buffering: boolean;
  speed: Speed;
}

export class PlayerClock {
  pos = 0;
  private state: PlayerState;
  private listeners = new Set<() => void>();
  private tickListeners = new Set<(pos: number) => void>();
  private raf = 0;
  /** rAF timestamp of the previous tick; undefined until the first tick after play(). */
  private last: number | undefined;

  constructor(
    readonly frames: number,
    initial: { index?: number; speed?: Speed } = {},
    private readonly opts: { loop?: boolean; isReady?: (i: number) => boolean } = {},
  ) {
    this.pos = Math.min(Math.max(0, initial.index ?? 0), Math.max(0, frames - 1));
    this.state = { index: Math.floor(this.pos), playing: false, buffering: false, speed: initial.speed ?? 4 };
  }

  get snapshot() {
    return this.state;
  }

  private set(patch: Partial<PlayerState>) {
    const next = { ...this.state, ...patch };
    if (next.index === this.state.index && next.playing === this.state.playing && next.buffering === this.state.buffering && next.speed === this.state.speed) return;
    this.state = next;
    for (const l of this.listeners) l();
  }

  private moved() {
    for (const l of this.tickListeners) l(this.pos);
    this.set({ index: Math.floor(this.pos + 1e-6) });
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  onTick(fn: (pos: number) => void) {
    this.tickListeners.add(fn);
    return () => this.tickListeners.delete(fn);
  }
  getSnapshot = () => this.state;

  setReady(isReady: (i: number) => boolean) {
    this.opts.isReady = isReady;
  }

  play() {
    if (this.frames < 2) return;
    if (this.pos >= this.frames - 1) this.pos = 0;
    this.set({ playing: true });
    // Measure time only between rAF timestamps: a frame's timestamp can be earlier than performance.now()
    // in the click that started playback, which would make the first step negative.
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

  seek(index: number) {
    if (this.frames < 1) return;
    this.pos = Math.min(Math.max(0, Math.round(index)), this.frames - 1);
    this.moved();
  }

  step(delta: number) {
    this.seek(Math.floor(this.pos + 1e-6) + delta);
  }

  setSpeed(speed: Speed) {
    this.set({ speed });
  }

  private tick = (now: number) => {
    if (!this.state.playing) return;
    const dt = this.last === undefined ? 0 : Math.min(0.25, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const ready = this.opts.isReady ?? (() => true);
    const cur = Math.min(this.frames - 1, Math.max(0, Math.floor(this.pos + 1e-6)));
    const next = Math.min(this.frames - 1, cur + 1);
    if (!ready(next) || !ready(cur)) {
      // Hold here; the loop keeps running and resumes on the first tick after the frames arrive.
      this.set({ buffering: true });
    } else {
      this.set({ buffering: false });
      this.pos = Math.max(0, this.pos + dt * this.state.speed);
      if (this.pos >= this.frames - 1) {
        if (this.opts.loop) this.pos = 0;
        else {
          this.pos = this.frames - 1;
          this.moved();
          this.pause();
          return;
        }
      }
      this.moved();
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    this.listeners.clear();
    this.tickListeners.clear();
  }
}

export function usePlayerClock(frames: number, initial: { index?: number; speed?: Speed }, opts: { loop?: boolean } = {}) {
  // A new clock when the timeline length changes (e.g. frames manifest arrives).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const clock = useMemo(() => new PlayerClock(frames, initial, opts), [frames]);
  useEffect(() => () => clock.dispose(), [clock]);
  const state = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
  return { clock, state };
}
