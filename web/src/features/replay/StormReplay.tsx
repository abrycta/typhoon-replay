import { Alert, AlertDescription, AlertTitle, Skeleton, useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { lazy, type ReactNode, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";

import { bestWind, type FrameStore, hourAt, maxNear, type ResolvedDataset, useFrameStore, useStormTrack } from "@/data";
import type { FieldLayer } from "@/shared/lib/fields";
import { formatDateTime, formatShort, fromUrlHour, isoToUnix, type TimeZoneChoice, toUrlHour } from "@/shared/lib/time";
import { ktToMs, msToKt, type SpeedUnit } from "@/shared/lib/units";
import type { StormDetail } from "@/shared/model/types";
import { useHighContrast, useMapTheme, usePrefersReducedMotion } from "@/shared/ui/hooks";
import { useStormName } from "@/shared/ui/use-storm-name";

import { compassPoint, markerAt, offsetAt } from "./centre-offset";
import { CentreOffsetNote, Era5CentreKey } from "./CentreOffsetNote";
import { FieldLegend } from "./FieldLegend";
import { IntensityPanel } from "./IntensityPanel";
import { useFieldLabels } from "./labels";
import { LayerPanel } from "./LayerPanel";
import { MapDescription, MapUnavailableText } from "./MapDescription";
import { type CustomBasemap, themeKey } from "./map/basemap";
import { PlayerControls } from "./PlayerControls";
import { type Speed, usePlayerClock } from "./player";
import { StaticTrack } from "./StaticTrack";
import { TimelineTable } from "./TimelineTable";
import { localZone, parseView } from "./url";
import { useCompassNames } from "./use-compass-names";
import { useReplayKeyboard } from "./useReplayKeyboard";

const ReplayMap = lazy(() => import("./map/ReplayMap"));
const fmt = (v: number, d = 0) => v.toFixed(d);

export interface ReplayUrlState {
  t?: string;
  layer: FieldLayer | "none";
  speed: Speed;
  particles?: boolean;
  track: boolean;
  units: SpeedUnit;
  tz: "local" | "utc";
  v?: string;
}

/** A clock another view drives: its position in hours, its ticks, and a gate that holds playback for missing frames. */
export interface ReplayLeader {
  readonly pos: number;
  onTick(fn: (pos: number) => void): () => void;
  addReadyCheck(fn: (pos: number) => boolean): () => void;
}

/**
 * The frozen embed (src/embed): one hour, its frame already in `store`, a baked basemap and a still map. The
 * player stays visible but inert and the timeline table is left out.
 */
export interface FrozenReplay {
  store: FrameStore;
  basemap: CustomBasemap;
  pixelRatio?: number;
  onRendered?: () => void;
  /** The phone and tablet layout (the frame at the portfolio's picture slot's real size): the map, then a two-line
   * caption instead of the player and the side panels. `viewFrame`: the map size the view was framed for. */
  compact?: { viewFrame: readonly [number, number] };
}

export interface StormReplayProps {
  detail: StormDetail;
  dataset: ResolvedDataset;
  url: ReplayUrlState;
  onUrl: (patch: Partial<ReplayUrlState>) => void;
  /** Keyboard shortcuts on the whole page (storm page) rather than only inside the player. */
  pageKeyboard?: boolean;
  /** Hide the timeline table (compare view shows one shared table). */
  showTable?: boolean;
  /** A shared clock (compare view): this replay follows it at `leaderOffset` hours and hides its own controls. */
  leader?: ReplayLeader;
  leaderOffset?: number;
  /** Drawn over the map (compare view: "not yet formed" / "ended"). */
  mapOverlay?: ReactNode;
  compact?: boolean;
  autoplay?: boolean;
  loop?: boolean;
  mapClassName?: string;
  frozen?: FrozenReplay;
}

export function StormReplay({ detail, dataset, url, onUrl, pageKeyboard, showTable = true, leader, leaderOffset = 0, mapOverlay, compact, autoplay, loop, mapClassName, frozen }: StormReplayProps) {
  const { t } = useLingui();
  const { lang } = useLang();
  const fieldLabels = useFieldLabels();
  const reducedMotion = usePrefersReducedMotion();
  const theme = useMapTheme();
  const hc = useHighContrast();
  const track = useStormTrack(detail.sid);
  const initialT = fromUrlHour(url.t);
  const { store, snap } = useFrameStore(dataset, detail, 0, frozen?.store);
  const header = snap.header;
  const descId = useId();
  /** The timeline table (the map's text alternative) is hidden in the compact view and the frozen embeds. */
  const tableShown = showTable && !compact && !frozen;
  const [webglError, setWebglError] = useState<string>();

  const times = useMemo(() => {
    if (header) return header.time;
    if (detail.frames?.start) {
      const t0 = isoToUnix(detail.frames.start);
      return Array.from({ length: detail.frames.frames }, (_, i) => t0 + i * 3600);
    }
    return (track.data?.hours ?? []).map((h) => h.t);
  }, [header, detail.frames, track.data]);

  const startIndex = initialT !== undefined ? Math.max(0, times.findIndex((x) => x >= initialT)) : 0;
  const { clock, state } = usePlayerClock(times.length, { index: startIndex, speed: url.speed }, { loop });
  const hasFrames = !!detail.frames;
  useEffect(() => {
    // Wait for a frame only while it can still arrive: once the load has finished (or failed, which the
    // alert below reports), play on with the best track rather than hold forever.
    clock.setReady((i) => !hasFrames || !!store?.has(i) || !!store?.getSnapshot().done);
  }, [clock, store, hasFrames]);

  // Autoplay (home page) unless the user asked for reduced motion.
  const autoplayed = useRef(false);
  useEffect(() => {
    if (!autoplay || reducedMotion || autoplayed.current || times.length < 2) return;
    autoplayed.current = true;
    clock.play();
  }, [autoplay, reducedMotion, clock, times.length]);

  // Shared clock (compare view): follow it, and hold its playback until this replay's frame has arrived.
  useEffect(() => {
    if (!leader || !times.length) return;
    let last = -1;
    const follow = (p: number) => {
      clock.follow(p - leaderOffset);
      const i = clock.snapshot.index;
      if (Math.abs(i - last) > 1) store?.prioritise(i); // a jump (drag, step), not playback
      last = i;
    };
    follow(leader.pos);
    return leader.onTick(follow);
  }, [leader, leaderOffset, clock, store, times.length]);
  useEffect(() => {
    if (!leader || !hasFrames) return;
    return leader.addReadyCheck((p) => {
      const i = Math.floor(p + 1e-6) - leaderOffset;
      return i < 0 || i >= times.length || !!store?.has(i) || !!store?.getSnapshot().done;
    });
  }, [leader, leaderOffset, store, hasFrames, times.length]);

  // Keep the URL's time in step while paused (scrubs, steps, jumps), never on every playing frame.
  useEffect(() => {
    if (state.playing || compact || frozen) return;
    const time = times[state.index];
    if (time === undefined) return;
    const next = toUrlHour(time);
    if (next !== url.t && (url.t !== undefined || state.index !== 0)) onUrl({ t: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.index, state.playing]);

  const seek = (i: number) => {
    clock.seek(i);
    store?.prioritise(Math.max(0, Math.min(i, times.length - 1)));
  };
  useReplayKeyboard(clock, seek, () => state.index, pageKeyboard ?? false, times.length);

  const tzChoice: TimeZoneChoice = url.tz === "utc" ? "UTC" : localZone(detail);
  const time = times[state.index];
  const hours = track.data?.hours ?? [];
  const hour = time !== undefined ? hourAt(hours, time) : undefined;
  const exactHour = hour;
  const particles = url.particles ?? !reducedMotion;
  const layer = hasFrames ? url.layer : "none";

  // ERA5 near the best-track centre (within 2°, as in the pipeline's cross-check). Numbers never come from
  // lossy WebP pixels: the pipeline's per-frame `series` (from the unquantised fields) when the summary has
  // it, else the lossless .tyf frame, else the lossless 3-hourly exact grid (no reading between its hours).
  const series = detail.frames?.series;
  const exactOnly = !series?.era5MaxWindMs && header?.format === "webp";
  const near = (i: number): { wind?: number; mslp?: number } | undefined => {
    const tt = times[i];
    if (tt === undefined) return undefined;
    if (series?.era5MaxWindMs) {
      const wind = series.era5MaxWindMs[i] ?? undefined;
      return wind === undefined ? undefined : { wind, mslp: series.era5MinMslpHpa?.[i] ?? undefined };
    }
    const h = hourAt(hours, tt);
    if (!h || !header) return undefined;
    const at = header.format === "TYF1" ? { raw: store?.frame(i), header, k: i } : store?.exactAt(i);
    if (!at?.raw) return undefined;
    return { wind: maxNear(at.raw, at.header, at.k, "wind", h.lon, h.lat, 2), mslp: maxNear(at.raw, at.header, at.k, "mslp", h.lon, h.lat, 2, "min") };
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cur = useMemo(() => near(state.index), [state.index, snap.loadedFrames, snap.exactFrames, header, hours, series]);

  const offset = layer === "none" ? undefined : offsetAt(detail.frames?.centreOffset, state.index);
  const dirs = useCompassNames();
  const mark = markerAt(offset);
  const era5Centre =
    mark && offset?.kind === "offset"
      ? { ...mark, label: t`ERA5 centre`, name: t`ERA5 centre, about ${Math.round(offset.km / 10) * 10} km ${dirs[compassPoint(offset.bearingDeg)]!} of the official track` }
      : undefined;

  const timeLabel = time !== undefined ? formatDateTime(time, lang, tzChoice) : "";
  const bw = exactHour ? bestWind(exactHour) : undefined;
  const valueText = [
    timeLabel,
    bw ? `${bw.kt.toFixed(0)} kt ${bw.agency.toUpperCase()}` : undefined,
    exactHour?.jmaHpa !== undefined ? `${exactHour.jmaHpa.toFixed(0)} hPa` : undefined,
    exactHour && !exactHour.observed ? t`interpolated` : undefined,
  ]
    .filter(Boolean)
    .join(", ");

  const speed = (kt: number) => (url.units === "kt" ? `${fmt(kt)} kt` : `${fmt(ktToMs(kt), 1)} m/s`);
  const tzShort = tzChoice === "UTC" ? "UTC" : tzChoice === "Asia/Tokyo" ? "JST" : "PHT";
  const sealLabel = (kt: number | undefined, t: number) =>
    [kt === undefined ? undefined : url.units === "kt" ? `${Math.round(kt)} kt` : `${Math.round(ktToMs(kt))} m/s`, `${formatShort(t, lang, tzChoice)} ${tzShort}`]
      .filter(Boolean)
      .join(" · ");
  const speedMs = (ms: number) => (url.units === "kt" ? `${fmt(msToKt(ms))} kt` : `${fmt(ms, 1)} m/s`);
  const progress = detail.frames ? Math.round((snap.loadedFrames / detail.frames.frames) * 100) : 100;
  const layerName = layer === "none" ? t`no` : fieldLabels[layer].long;
  const stormName = useStormName()(detail);
  const mapLabel = t`Map of ${stormName}'s track with the ERA5 field (${layerName}) at ${timeLabel}`;

  return (
    <div className="grid gap-4" data-testid="storm-replay" data-frame-ready={hasFrames ? String(!!store?.has(state.index)) : undefined}>
      <div className={compact ? "grid gap-3" : "grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]"}>
        <div className="grid gap-3">
          <div className={mapClassName ?? "relative aspect-[4/3] w-full overflow-hidden rounded-sm border border-border sm:aspect-[16/10]"}>
            {webglError ? (
              <StaticTrack hours={hours} current={hour} label={mapLabel} />
            ) : (
              <Suspense fallback={<Skeleton className="absolute inset-0" />}>
                <ReplayMap
                  className="absolute inset-0"
                  label={mapLabel}
                  descriptionId={descId}
                  header={header}
                  store={store}
                  clock={clock}
                  times={times}
                  track={track.data}
                  layer={layer}
                  particles={particles && hasFrames}
                  showTrack={url.track}
                  themeKey={themeKey(theme, hc)}
                  view={parseView(url.v)}
                  onViewChange={compact || frozen ? undefined : (v) => onUrl({ v: `${v.lon},${v.lat},${v.zoom}` })}
                  interactive={!compact && !frozen}
                  basemap={frozen?.basemap}
                  pixelRatio={frozen?.pixelRatio}
                  onRendered={frozen?.onRendered}
                  viewFrame={frozen?.compact?.viewFrame}
                  onUnavailable={setWebglError}
                  era5Centre={era5Centre}
                  sealLabel={sealLabel}
                />
              </Suspense>
            )}
            {webglError ? null : <CentreOffsetNote reading={offset} bestTrackKt={bw?.kt} />}
            {hasFrames && progress < 100 && !snap.error && !frozen ? (
              <div className="absolute bottom-2 left-2 rounded-sm bg-background/85 px-2 py-0.5 font-mono text-ak-2xs text-muted-foreground" aria-hidden="true">
                {t`frames ${progress}%`}
              </div>
            ) : null}
            {mapOverlay}
          </div>
          <MapDescription id={descId} tableShown={tableShown} />
          {webglError ? (
            <Alert>
              <AlertTitle>{t`Map unavailable`}</AlertTitle>
              <AlertDescription>
                <MapUnavailableText tableShown={tableShown} />
              </AlertDescription>
            </Alert>
          ) : null}
          {snap.error ? (
            <Alert>
              <AlertTitle>{t`Field frames could not be loaded`}</AlertTitle>
              <AlertDescription>{t`The replay continues with the best track only. (${snap.error})`}</AlertDescription>
            </Alert>
          ) : null}
          {frozen?.compact ? (
            <FrozenCaption
              title={stormName}
              time={timeLabel}
              bestTrack={bw ? `${speed(bw.kt)} (${bw.agency.toUpperCase()})` : undefined}
              hpa={exactHour?.jmaHpa}
              era5={cur?.wind !== undefined ? speedMs(cur.wind) : undefined}
            />
          ) : leader ? null : (
          <div className="contents" inert={!!frozen}>
          <PlayerControls
            clock={clock}
            state={state}
            frames={times.length}
            timeLabel={timeLabel}
            valueText={valueText}
            bufferedTo={store ? store.bufferedFrom(state.index) : times.length}
            onSeek={seek}
            onSpeed={(s) => {
              clock.setSpeed(s);
              onUrl({ speed: s });
            }}
            compact={compact}
          />
          </div>
          )}
        </div>
        {compact ? null : (
          <div className="grid content-start gap-4">
            <IntensityPanel
              hour={exactHour}
              era5WindMs={cur?.wind}
              era5MinMslp={cur?.mslp}
              radiusDeg={2}
              threeHourly={exactOnly}
              offset={offset}
              check={detail.reanalysisCheck}
              units={url.units}
              lang={lang}
              tz={tzChoice}
            />
            {layer !== "none" ? <FieldLegend layer={layer} units={url.units} theme={theme} /> : null}
            {layer !== "none" && detail.frames?.centreOffset ? <Era5CentreKey /> : null}
            <LayerPanel
              layer={layer}
              particles={particles}
              track={url.track}
              units={url.units}
              tz={url.tz}
              localZoneLabel={tzChoice === "UTC" ? (localZone(detail) === "Asia/Tokyo" ? "JST" : "PHT") : tzChoice === "Asia/Tokyo" ? "JST" : "PHT"}
              reducedMotion={reducedMotion}
              hasFrames={hasFrames}
              onChange={(p) => onUrl(p)}
            />
          </div>
        )}
      </div>
      {tableShown ? (
        <section aria-labelledby="timeline-h" className="grid gap-2">
          <h2 id="timeline-h" className="text-lg font-semibold">
            {t`Timeline`}
          </h2>
          <TimelineTable
            times={times}
            hours={hours}
            era5={(i) => near(i)?.wind}
            current={state.index}
            onJump={seek}
            units={url.units}
            lang={lang}
            tz={tzChoice}
            landfalls={detail.landfalls}
          />
        </section>
      ) : null}
    </div>
  );
}

/** The compact embed's caption (src/embed): the storm and the hour, then the intensities, in two short lines, right
 * under the map (-mt-3 cancels the grid gap; the embed sizes the map to the frame less these 52 px). */
function FrozenCaption({ title, time, bestTrack, hpa, era5 }: { title: string; time: string; bestTrack?: string; hpa?: number; era5?: string }) {
  const { t } = useLingui();
  const parts = [bestTrack ? `${t`Best track`} ${bestTrack}` : undefined, hpa !== undefined ? `${fmt(hpa)} hPa` : undefined, era5 ? `ERA5 ${era5}` : undefined];
  return (
    <div className="-mt-3 grid h-[52px] min-w-0 content-center gap-0.5 border-t border-border px-3 leading-snug" data-testid="embed-caption">
      <p className="truncate text-sm">
        <span className="font-semibold">{title}</span>
        <span className="text-muted-foreground"> · {time}</span>
      </p>
      <p className="truncate text-xs text-muted-foreground tabular-nums" data-testid="embed-caption-figures">
        {parts.filter(Boolean).join(" · ")}
      </p>
    </div>
  );
}
