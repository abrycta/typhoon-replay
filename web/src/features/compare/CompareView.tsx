import { Skeleton } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { type ReactNode, useEffect, useMemo, useSyncExternalStore } from "react";

import { type ResolvedDataset, useStormDetail, useStormIndex, useStormTrack } from "@/data";
import type { FieldLayer } from "@/shared/lib/fields";
import { isUnnamed } from "@/shared/lib/names";
import type { SpeedUnit } from "@/shared/lib/units";
import type { StormDetail, StormSummary } from "@/shared/model/types";
import { useStormName } from "@/shared/ui/use-storm-name";

import { AboutComparison } from "./AboutComparison";
import { type Alignment, availableAlignments, DEFAULT_ALIGNMENT, sharedTimeline, sideStatus, spanOf, type StormSpan } from "./align";
import { type SharedClock, useSharedClock } from "./clock";
import { type Lane, LineUp } from "./LineUp";
import { suggestPairs } from "./picker-model";
import { DataCard } from "./DataCard";
import { useCountryName } from "./labels";
import { SlotCard } from "./SlotCard";
import { SuggestedPairs } from "./SuggestedPairs";

/** The clock a replay follows (StormReplay's `ReplayLeader`; the route passes it through). */
export interface CompareLeader {
  readonly pos: number;
  onTick(fn: (pos: number) => void): () => void;
  addReadyCheck(fn: (pos: number) => boolean): () => void;
}

/** The route supplies the replay (features never import each other). */
export type RenderReplay = (p: {
  detail: StormDetail;
  dataset: ResolvedDataset;
  layer: FieldLayer | "none";
  units: SpeedUnit;
  leader: CompareLeader;
  leaderOffset: number;
  mapOverlay: ReactNode;
}) => ReactNode;

export interface CompareUrl {
  a?: string;
  b?: string;
  /** Hours from 0 h (the aligned moment); negative before it. */
  h?: number;
  /** Line-up; peak when absent. */
  al?: Alignment;
  layer: FieldLayer | "none";
  units: SpeedUnit;
}

/** "Not yet formed" / "Ended" over a map while its storm is outside its own life on the shared clock. */
function SideOverlay({ clock, offset, hours }: { clock: SharedClock; offset: number; hours: number }) {
  const { t } = useLingui();
  const { index } = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
  const st = sideStatus(index, offset, hours);
  if (st.kind === "during") return null;
  const h = st.hours;
  return (
    <div className="absolute inset-0 grid place-items-center bg-background/70" data-testid="side-overlay">
      <p className="rounded-sm border border-border bg-card px-3 py-1.5 text-sm font-medium text-card-foreground">
        {st.kind === "before" ? t`Not yet formed · forms in ${h} h` : t`Ended ${h} h ago`}
      </p>
    </div>
  );
}

/** Writes the hour to the URL whenever the clock rests on a new one (never on every playing frame). */
function UrlHour({ clock, zero, h, onUrl }: { clock: SharedClock; zero: number; h?: number; onUrl: (p: Partial<CompareUrl>) => void }) {
  const { index, playing } = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
  useEffect(() => {
    if (playing) return;
    const rel = index - zero;
    if (rel !== (h ?? 0)) onUrl({ h: rel || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, playing, zero]);
  return null;
}

function useSide(sid: string | undefined) {
  const d = useStormDetail(sid);
  const track = useStormTrack(sid && d.data && !d.data.frames ? sid : undefined);
  const span: StormSpan | undefined = useMemo(() => (d.data ? spanOf(d.data, track.data?.hours) : undefined), [d.data, track.data]);
  return { detail: d.data, dataset: d.dataset, error: d.error, loading: !!sid && (d.isPending || (!!d.data && !d.data.frames && track.isPending)), span };
}

/** Two storms on one clock: suggested pairs, two storm cards, the line-up timeline, both maps and the data notes. */
export function CompareView({ url, onUrl, renderReplay, fieldControl }: { url: CompareUrl; onUrl: (p: Partial<CompareUrl>) => void; renderReplay: RenderReplay; fieldControl?: ReactNode }) {
  const { t } = useLingui();
  const stormName = useStormName();
  const country = useCountryName();
  const index = useStormIndex();
  const storms: readonly StormSummary[] = useMemo(() => index.data ?? [], [index.data]);
  const bySid = useMemo(() => new Map(storms.map((s) => [s.sid, s])), [storms]);
  const pairs = useMemo(() => suggestPairs(storms), [storms]);
  const A = useSide(url.a);
  const B = useSide(url.b);
  const sides = [
    { slot: "A" as const, sid: url.a, ...A },
    { slot: "B" as const, sid: url.b, ...B },
  ];
  const ready = sides.filter((s): s is typeof s & { span: StormSpan; detail: StormDetail } => !!s.span && !!s.detail);
  const spans = ready.map((s) => s.span);
  const wanted = url.al ?? DEFAULT_ALIGNMENT;
  const available = spans.length ? availableAlignments(spans) : [];
  const timeline = sharedTimeline(spans, wanted);
  const startIndex = Math.min(Math.max(0, (url.h ?? 0) + timeline.zero), Math.max(0, timeline.frames - 1));
  const clock = useSharedClock(timeline.frames, startIndex, `${ready.map((s) => s.sid).join(",")}|${timeline.alignment}|${timeline.zero}`);
  const mapLabel = (name: string) => t`Map of ${name}`;
  const nameOf = (d: StormDetail) => (isUnnamed(d.name) ? stormName(d) : d.name);

  const lanes: Lane[] = ready.map((s, k) => {
    const first = [...s.detail.landfalls].sort((x, y) => x.at.localeCompare(y.at))[0];
    return {
      slot: s.slot,
      name: nameOf(s.detail),
      span: s.span,
      offset: timeline.offsets[k]!,
      peakKt: s.detail.peak?.windKt,
      landfallPlace: first ? (first.placeName ?? country(first.country)) : undefined,
      durationHours: s.detail.durationHours ?? (s.span.endedAt !== undefined && s.span.formedAt !== undefined ? (s.span.endedAt - s.span.formedAt) / 3600 : undefined),
    };
  });
  const noLandfall = ready.filter((s) => s.span.landfallAt === undefined).map((s) => nameOf(s.detail));

  return (
    <div className="grid gap-5">
      <SuggestedPairs pairs={pairs} a={url.a} b={url.b} onChoose={(p) => onUrl({ a: p.a.sid, b: p.b.sid, al: p.alignment, h: undefined })} />
      <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(20rem,100%),1fr))]">
        {sides.map((s) => (
          <SlotCard
            key={s.slot}
            slot={s.slot}
            summary={s.sid ? bySid.get(s.sid) : undefined}
            detail={s.detail}
            loading={s.loading || index.isPending}
            storms={storms}
            onPick={(sid) => onUrl(s.slot === "A" ? { a: sid, h: undefined } : { b: sid, h: undefined })}
          />
        ))}
      </div>
      {sides.some((s) => s.error) ? <p className="text-sm text-destructive">{t`A storm could not be loaded. Pick another one or try again later.`}</p> : null}

      {lanes.length ? (
        <>
          <LineUp
            lanes={lanes}
            timeline={timeline}
            clock={clock}
            wanted={wanted}
            available={available}
            onAlign={(al) => onUrl({ al })}
            noLandfall={noLandfall}
          />
          <UrlHour clock={clock} zero={timeline.zero} h={url.h} onUrl={onUrl} />
        </>
      ) : sides.some((s) => s.loading) ? (
        <Skeleton className="h-40" />
      ) : null}

      {fieldControl}
      <div className="grid gap-6 lg:grid-cols-2">
        {sides.map((s) => {
          const k = ready.findIndex((r) => r.slot === s.slot);
          if (!s.sid) return <div key={s.slot} className="hidden lg:block" />;
          if (k < 0 || !s.dataset) return s.error ? <div key={s.slot} /> : <Skeleton key={s.slot} className="aspect-[4/3]" />;
          const r = ready[k]!;
          const offset = timeline.offsets[k]!;
          return (
            <section key={s.slot} aria-label={mapLabel(lanes[k]!.name)} className="grid content-start gap-3" data-testid={`map-${s.slot}`}>
              {renderReplay({
                detail: r.detail,
                dataset: s.dataset,
                layer: url.layer,
                units: url.units,
                leader: clock,
                leaderOffset: offset,
                mapOverlay: <SideOverlay clock={clock} offset={offset} hours={r.span.hours} />,
              })}
              <DataCard slot={s.slot} name={lanes[k]!.name} detail={r.detail} />
            </section>
          );
        })}
      </div>
      {ready.length ? <AboutComparison storms={ready.map((s, k) => ({ name: lanes[k]!.name, detail: s.detail, landfallPlace: lanes[k]!.landfallPlace }))} alignment={timeline.alignment} /> : null}
    </div>
  );
}
