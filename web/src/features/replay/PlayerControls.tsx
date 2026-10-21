import { Button, Kbd, NativeSelect, NativeSelectOption } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { ChevronFirstIcon, ChevronLastIcon, PauseIcon, PlayIcon, StepBackIcon, StepForwardIcon } from "lucide-react";
import type { CSSProperties, KeyboardEvent } from "react";

import { type PlayerClock, type PlayerState, SPEEDS, type Speed } from "./player";

export interface PlayerControlsProps {
  clock: PlayerClock;
  state: PlayerState;
  frames: number;
  /** "7 Nov 2013 21:00 GMT+8" for the current index. */
  timeLabel: string;
  /** Full aria-valuetext for the scrubber at the current index. */
  valueText: string;
  /** Frames loaded contiguously from the playhead (for the buffered bar). */
  bufferedTo: number;
  onSeek: (index: number) => void;
  onSpeed: (s: Speed) => void;
  compact?: boolean;
}

export function PlayerControls({ clock, state, frames, timeLabel, valueText, bufferedTo, onSeek, onSpeed, compact }: PlayerControlsProps) {
  const { t } = useLingui();
  const max = Math.max(0, frames - 1);
  const pct = (i: number) => `${max ? ((i / max) * 100).toFixed(2) : 0}%`;
  const style = { "--played": pct(state.index), "--buffered": pct(Math.max(state.index, bufferedTo)) } as CSSProperties;

  // APG slider keys: arrows step 1 h (native), PageUp/PageDown 6 h, Home/End (native).
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      onSeek(state.index + (e.key === "PageUp" ? 6 : -6));
    }
  };

  return (
    <div className="grid gap-2" data-slot="player-controls">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => clock.toggle()}
          aria-label={state.playing ? t`Pause replay` : t`Play replay`}
          aria-keyshortcuts="Space k"
          data-testid="play-toggle"
          disabled={frames < 2}
        >
          {state.playing ? <PauseIcon /> : <PlayIcon />}
          <span className="hidden sm:inline">{state.playing ? t`Pause` : t`Play`}</span>
        </Button>
        {compact ? null : (
          <>
            <Button size="icon-sm" variant="outline" onClick={() => onSeek(0)} aria-label={t`Go to start`}>
              <ChevronFirstIcon />
            </Button>
            <Button size="icon-sm" variant="outline" onClick={() => onSeek(state.index - 1)} aria-label={t`Back one hour`} aria-keyshortcuts="ArrowLeft">
              <StepBackIcon />
            </Button>
            <Button size="icon-sm" variant="outline" onClick={() => onSeek(state.index + 1)} aria-label={t`Forward one hour`} aria-keyshortcuts="ArrowRight">
              <StepForwardIcon />
            </Button>
            <Button size="icon-sm" variant="outline" onClick={() => onSeek(max)} aria-label={t`Go to end`}>
              <ChevronLastIcon />
            </Button>
          </>
        )}
        <output className="ml-auto font-mono text-sm tabular-nums" aria-live="off" data-testid="replay-time">
          {timeLabel}
        </output>
        <span aria-live="polite" className="text-xs text-muted-foreground empty:hidden" data-testid="replay-buffering">
          {state.buffering ? t`Loading frames…` : null}
        </span>
        {compact ? null : (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {t`Speed`}
            <NativeSelect size="sm" value={String(state.speed)} onChange={(e) => onSpeed(Number(e.target.value) as Speed)} aria-label={t`Playback speed`}>
              {SPEEDS.map((s) => (
                <NativeSelectOption key={s} value={String(s)}>
                  {t`${s} h/s`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
        )}
      </div>
      <input
        type="range"
        className="scrubber"
        min={0}
        max={max}
        step={1}
        value={state.index}
        onChange={(e) => onSeek(Number(e.target.value))}
        onKeyDown={onKey}
        aria-label={t`Replay time`}
        aria-valuetext={valueText}
        style={style}
        data-testid="scrubber"
        disabled={frames < 2}
      />
      {compact ? null : (
        <p className="text-xs text-muted-foreground">
          <Kbd>Space</Kbd> {t`play/pause`} · <Kbd>←</Kbd> <Kbd>→</Kbd> {t`1 hour`} · <Kbd>PgUp</Kbd> <Kbd>PgDn</Kbd> {t`6 hours`} · <Kbd>Home</Kbd>{" "}
          <Kbd>End</Kbd>
        </p>
      )}
    </div>
  );
}
