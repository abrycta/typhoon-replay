import { Button, NativeSelect, NativeSelectOption, ToggleGroup, ToggleGroupItem, useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { PauseIcon, PlayIcon, StepBackIcon, StepForwardIcon } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useId, useRef, useSyncExternalStore } from "react";

import { formatDate, formatShort } from "@/shared/lib/time";

import { type Alignment, hoursInto, type SharedTimeline, sideStatus, type StormSpan } from "./align";
import { COMPARE_SPEEDS, type CompareSpeed, type SharedClock } from "./clock";
import { BAR, relLabel, signed, SLOT_COLOR, useDuration } from "./labels";

export interface Lane {
  slot: "A" | "B";
  name: string;
  span: StormSpan;
  offset: number;
  peakKt?: number;
  /** First landfall: municipality name (or country) for the 0 h line. */
  landfallPlace?: string;
  durationHours?: number;
}

function useStatusText() {
  const { t } = useLingui();
  const { lang } = useLang();
  return (lane: Lane, index: number): string => {
    const st = sideStatus(index, lane.offset, lane.span.hours);
    if (st.kind === "before") {
      const { hours } = st;
      return t`not yet formed (in ${hours} h)`;
    }
    if (st.kind === "after") {
      const { hours } = st;
      return t`ended ${hours} h ago`;
    }
    const time = `${formatShort(lane.span.start + st.index * 3600, lang, "UTC")} UTC`;
    if (lane.span.peakAt === undefined) {
      const n = st.index;
      return `${time} · ${t`hour ${n}`}`;
    }
    const d = st.index - Math.round(hoursInto(lane.span, lane.span.peakAt));
    const ad = Math.abs(d);
    return `${time} · ${d === 0 ? t`at peak` : d < 0 ? t`${ad} h before peak` : t`${ad} h after peak`}`;
  };
}

function Marker({ left, kind, color, title }: { left: number; kind: "formed" | "peak" | "landfall"; color: string; title: string }) {
  if (left < 0 || left > 100) return null;
  const common = "pointer-events-none absolute top-1/2";
  if (kind === "formed")
    return <span title={title} className={`${common} -mt-[5px] -ml-[5px] size-2.5 rounded-full border-2 bg-white`} style={{ left: `${left}%`, borderColor: color }} />;
  if (kind === "peak") return <span title={title} className={`${common} -mt-1.5 -ml-1.5 size-3 rotate-45 bg-white`} style={{ left: `${left}%` }} />;
  return (
    <span title={title} className={`${common} -mt-2 -ml-[7px] text-[13px] leading-none text-white`} style={{ left: `${left}%` }}>
      ▲
    </span>
  );
}

/**
 * "Line the storms up": the alignment switch, a day-scale axis with the 0 h line, one lane per storm (bar, ● formed,
 * ◆ peak, ▲ first landfall, striped before/after), a draggable playhead (an APG slider) and the play controls.
 */
export function LineUp({
  lanes,
  timeline,
  clock,
  wanted,
  available,
  onAlign,
  noLandfall,
}: {
  lanes: Lane[];
  timeline: SharedTimeline;
  clock: SharedClock;
  wanted: Alignment;
  available: Alignment[];
  onAlign: (a: Alignment) => void;
  /** Names of chosen storms that never made landfall (why Landfall is off). */
  noLandfall: string[];
}) {
  const { t } = useLingui();
  const { lang } = useLang();
  const id = useId();
  const duration = useDuration();
  const status = useStatusText();
  const state = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
  const { frames, zero, alignment } = timeline;
  const max = Math.max(1, frames - 1);
  const pct = (i: number) => (i / max) * 100;
  const index = state.index;
  const rel = index - zero;

  // The playhead follows the fractional clock every frame without re-rendering.
  const headRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const move = (p: number) => {
      if (headRef.current) headRef.current.style.left = `${(p / max) * 100}%`;
    };
    move(clock.pos);
    return clock.onTick(move);
  }, [clock, max]);

  const trackRef = useRef<HTMLDivElement>(null);
  const toIndex = (x: number) => {
    const r = trackRef.current?.getBoundingClientRect();
    return r && r.width ? Math.round(((x - r.left) / r.width) * max) : index;
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    clock.pause();
    clock.seek(toIndex(e.clientX));
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) clock.seek(toIndex(e.clientX));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 6 : 1;
    const moves: Record<string, number> = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: 24, PageDown: -24 };
    if (e.key in moves) clock.step(moves[e.key]!);
    else if (e.key === "Home") clock.seek(0);
    else if (e.key === "End") clock.seek(max);
    else if (e.key === " " || e.key === "k") clock.toggle();
    else return;
    e.preventDefault();
  };

  // Axis: whole days from 0 h, at most about eight labels.
  const days = frames / 24;
  const stepD = [1, 2, 4, 7, 14].find((d) => days / d <= 8) ?? 28;
  const ticks: number[] = [];
  for (let d = Math.ceil(-zero / 24 / stepD) * stepD; d * 24 <= max - zero; d += stepD) ticks.push(d);

  const names = lanes.map((l) => l.name);
  const zeroText = (() => {
    if (lanes.length < 1) return "";
    const parts = (f: (l: Lane) => string) => lanes.map(f).join(", ");
    if (alignment === "landfall") {
      const list = parts((l) => {
        const { name, landfallPlace: place } = l;
        return place ? t`${name} at ${place}` : name;
      });
      return t`0 h = first landfall (${list})`;
    }
    if (alignment === "peak") {
      const list = parts((l) => (l.peakKt !== undefined ? `${l.name} ${l.peakKt} kt` : l.name));
      return t`0 h = peak wind (${list})`;
    }
    const list = parts((l) => `${l.name} ${formatDate(l.span.start, lang)}`);
    return t`0 h = first track point (${list})`;
  })();
  const fellBack = alignment !== wanted;
  const missing = noLandfall.join(", ");
  const valueText = `${relLabel(rel)}: ${lanes.map((l) => `${l.name} ${status(l, index)}`).join("; ")}`;
  const options: { v: Alignment; label: ReactNode; hint: string }[] = [
    { v: "formation", label: t`Formation`, hint: t`First track point` },
    { v: "peak", label: `◆ ${t`Peak`}`, hint: t`Strongest wind` },
    { v: "landfall", label: `▲ ${t`Landfall`}`, hint: t`First time on land` },
  ];
  const stripes = "repeating-linear-gradient(135deg, var(--color-muted) 0 6px, transparent 6px 12px)";

  return (
    <section aria-labelledby={`${id}-h`} className="grid gap-3 rounded-md border border-border bg-card px-4 py-3.5 text-card-foreground" data-testid="lineup">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id={`${id}-h`} className="font-heading text-lg font-semibold">
            {t`Line the storms up`}
          </h2>
          <span className="text-sm text-muted-foreground" data-testid="zero-line">
            {zeroText}
          </span>
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          role="radiogroup"
          aria-label={t`Line up by`}
          aria-describedby={noLandfall.length ? `${id}-nolf` : undefined}
          value={alignment}
          onValueChange={(v) => v && onAlign(v as Alignment)}
          data-testid="align"
        >
          {options.map((o) => (
            <ToggleGroupItem key={o.v} value={o.v} title={o.hint} disabled={!available.includes(o.v)} className="h-9 px-3 text-sm">
              {o.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {noLandfall.length ? (
        <p id={`${id}-nolf`} className="-mt-1 text-xs text-muted-foreground">
          {fellBack ? t`Landfall is off: ${missing} never made landfall in the Philippines or Japan, so the storms are lined up at the peak.` : t`Landfall is off: ${missing} never made landfall in the Philippines or Japan.`}
        </p>
      ) : null}

      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <span />
        <div className="relative h-5 font-mono text-[11px] text-muted-foreground" aria-hidden="true">
          {ticks.map((d) => (
            <span key={d} className={`absolute -translate-x-1/2 whitespace-nowrap ${d === 0 ? "font-medium text-foreground" : ""}`} style={{ left: `${pct(zero + d * 24)}%` }}>
              {d === 0 ? "0" : `${signed(d)} ${t`d`}`}
            </span>
          ))}
        </div>

        <div className="grid gap-1.5">
          {lanes.map((l) => (
            <div key={l.slot} className="flex h-10 min-w-0 flex-col justify-center leading-tight">
              <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                <span className={`size-2.5 shrink-0 ${l.slot === "A" ? "rounded-full" : "rounded-[2px]"}`} style={{ background: BAR[l.slot] }} aria-hidden="true" />
                <span className="truncate">{l.name}</span>
              </span>
              {l.durationHours !== undefined ? (
                <span className="whitespace-nowrap text-[11px] leading-normal text-muted-foreground">
                  {duration(l.durationHours)} · {Math.round(l.durationHours)} h
                </span>
              ) : null}
            </div>
          ))}
        </div>

        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label={t`Shared timeline`}
          aria-valuemin={-zero}
          aria-valuemax={max - zero}
          aria-valuenow={rel}
          aria-valuetext={valueText}
          aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End Space"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onKeyDown={onKey}
          className="relative grid cursor-ew-resize touch-none gap-1.5 rounded-sm py-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
          data-testid="playhead"
        >
          {lanes.map((l) => {
            const from = pct(l.offset);
            const to = pct(l.offset + l.span.hours - 1);
            const at = (t0: number | undefined) => (t0 === undefined ? -1 : pct(l.offset + hoursInto(l.span, t0)));
            return (
              <div key={l.slot} className="relative h-10 overflow-hidden rounded-[5px]" style={{ background: stripes }} data-testid={`lane-${l.slot}`}>
                {from >= 12 ? (
                  <span className="absolute inset-y-0 left-0 flex items-center justify-center text-[11.5px] text-muted-foreground" style={{ width: `${from}%` }}>
                    {t`not yet formed`}
                  </span>
                ) : null}
                <span className="absolute inset-y-2.5 rounded-full" style={{ left: `${from}%`, right: `${100 - to}%`, background: BAR[l.slot] }} />
                {100 - to >= 8 ? (
                  <span className="absolute inset-y-0 right-0 flex items-center justify-center text-[11.5px] text-muted-foreground" style={{ width: `${100 - to}%` }}>
                    {t`ended`}
                  </span>
                ) : null}
                <Marker kind="formed" left={at(l.span.formedAt ?? l.span.start)} color={BAR[l.slot]} title={t`Formed`} />
                <Marker kind="peak" left={at(l.span.peakAt)} color={BAR[l.slot]} title={t`Peak`} />
                <Marker kind="landfall" left={at(l.span.landfallAt)} color={BAR[l.slot]} title={t`First landfall`} />
              </div>
            );
          })}
          <span className="pointer-events-none absolute -inset-y-1 border-l-[1.5px] border-dashed border-foreground/50" style={{ left: `${pct(zero)}%` }} aria-hidden="true" />
          <div ref={headRef} className="pointer-events-none absolute -top-1.5 -bottom-2.5" style={{ left: `${pct(index)}%` }} aria-hidden="true">
            <span className="absolute inset-y-0 -ml-px border-l-2" style={{ borderColor: "var(--ak-text)" }} />
            <span className="absolute -bottom-1 -ml-[7px] size-3.5 rounded-full border-2 border-card" style={{ background: "var(--ak-text)", boxShadow: "0 0 0 1px var(--ak-text)" }} />
          </div>
        </div>
      </div>
      <ul className="sr-only">
        {lanes.map((l) => (
          <li key={l.slot}>
            {l.name}: {l.durationHours !== undefined ? duration(l.durationHours) : ""}
          </li>
        ))}
      </ul>

      <div className="mt-1 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Button size="icon-sm" variant="outline" onClick={() => clock.step(-1)} aria-label={t`Back one hour`}>
          <StepBackIcon />
        </Button>
        <Button size="icon" className="rounded-full" onClick={() => clock.toggle()} aria-label={state.playing ? t`Pause both` : t`Play both`} data-testid="play-both" disabled={frames < 2}>
          {state.playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <Button size="icon-sm" variant="outline" onClick={() => clock.step(1)} aria-label={t`Forward one hour`}>
          <StepForwardIcon />
        </Button>
        <NativeSelect size="sm" value={String(state.speed)} onChange={(e) => clock.setSpeed(Number(e.target.value) as CompareSpeed)} aria-label={t`Playback speed`}>
          {COMPARE_SPEEDS.map((s) => (
            <NativeSelectOption key={s} value={String(s)}>
              {s === 24 ? t`1 d/s` : t`${s} h/s`}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <output className="mx-1 font-mono text-sm tabular-nums text-foreground" data-testid="shared-hour">
          {relLabel(rel)}
        </output>
        <span className="sr-only" aria-live="polite">
          {state.buffering ? t`Loading frames…` : ""}
        </span>
        <span className="min-w-0 flex-[1_1_26rem] text-sm text-muted-foreground" data-testid="side-status">
          {lanes.map((l, k) => (
            <span key={l.slot}>
              {k ? " · " : ""}
              <b className="font-semibold" style={{ color: SLOT_COLOR[l.slot] }}>
                {l.name}
              </b>{" "}
              {status(l, index)}
            </span>
          ))}
        </span>
        <span className="text-xs text-muted-foreground" aria-hidden="true">
          {t`● formed ◆ peak ▲ landfall`}
        </span>
      </div>
      <p className="sr-only">{names.length ? t`Keys: arrows move one hour, Shift+arrows six, Home and End jump to the ends, Space plays.` : ""}</p>
    </section>
  );
}
