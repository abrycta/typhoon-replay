import { Alert, AlertDescription, AlertTitle, Skeleton, useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";

import { bestWind, hourAt, maxNear, type ResolvedDataset, useFrameStore, useStormTrack } from "@/data";
import type { FieldLayer } from "@/shared/lib/fields";
import { formatDateTime, fromUrlHour, isoToUnix, type TimeZoneChoice, toUrlHour } from "@/shared/lib/time";
import type { SpeedUnit } from "@/shared/lib/units";
import type { StormDetail } from "@/shared/model/types";
import { useHighContrast, useMapTheme, usePrefersReducedMotion } from "@/shared/ui/hooks";
import { useStormName } from "@/shared/ui/use-storm-name";

import { FieldLegend } from "./FieldLegend";
import { IntensityPanel } from "./IntensityPanel";
import { useFieldLabels } from "./labels";
import { LayerPanel } from "./LayerPanel";
import { themeKey } from "./map/basemap";
import { PlayerControls } from "./PlayerControls";
import { type Speed, usePlayerClock } from "./player";
import { StaticTrack } from "./StaticTrack";
import { TimelineTable } from "./TimelineTable";
import { localZone, parseView } from "./url";
import { useReplayKeyboard } from "./useReplayKeyboard";

const ReplayMap = lazy(() => import("./map/ReplayMap"));

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

export interface StormReplayProps {
  detail: StormDetail;
  dataset: ResolvedDataset;
  url: ReplayUrlState;
  onUrl: (patch: Partial<ReplayUrlState>) => void;
  /** Keyboard shortcuts on the whole page (storm page) rather than only inside the player. */
  pageKeyboard?: boolean;
  /** Hide the timeline table (compare view shows one shared table). */
  showTable?: boolean;
  /** Externally driven index (compare view keeps two players in step). */
  syncIndex?: number;
  onIndex?: (index: number) => void;
  compact?: boolean;
  autoplay?: boolean;
  loop?: boolean;
  mapClassName?: string;
}

export function StormReplay({ detail, dataset, url, onUrl, pageKeyboard, showTable = true, syncIndex, onIndex, compact, autoplay, loop, mapClassName }: StormReplayProps) {
  const { t } = useLingui();
  const { lang } = useLang();
  const fieldLabels = useFieldLabels();
  const reducedMotion = usePrefersReducedMotion();
  const theme = useMapTheme();
  const hc = useHighContrast();
  const track = useStormTrack(detail.sid);
  const initialT = fromUrlHour(url.t);
  const { store, snap } = useFrameStore(dataset, detail);
  const header = snap.header;
  const descId = useId();
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

  // External sync (compare view).
  useEffect(() => {
    if (times.length && syncIndex !== undefined && syncIndex !== state.index) clock.seek(Math.min(syncIndex, times.length - 1));
  }, [syncIndex, clock, state.index, times.length]);
  useEffect(() => {
    // Read the clock, not the render's state: a sync seek in the same commit has already moved it.
    const i = clock.snapshot.index;
    if (!times.length) return; // timeline not known yet
    // A shorter storm clamps the shared hour; only report moves the user made inside its range.
    if (syncIndex === undefined || (i !== syncIndex && !(syncIndex > times.length - 1 && i === times.length - 1))) onIndex?.(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.index, onIndex, clock]);

  // Keep the URL's time in step while paused (scrubs, steps, jumps), never on every playing frame.
  useEffect(() => {
    if (state.playing || compact) return;
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
                  onViewChange={compact ? undefined : (v) => onUrl({ v: `${v.lon},${v.lat},${v.zoom}` })}
                  interactive={!compact}
                  onUnavailable={setWebglError}
                />
              </Suspense>
            )}
            {hasFrames && progress < 100 && !snap.error ? (
              <div className="absolute bottom-2 left-2 rounded-sm bg-background/85 px-2 py-0.5 font-mono text-[11px] text-muted-foreground" aria-hidden="true">
                {t`frames ${progress}%`}
              </div>
            ) : null}
          </div>
          <p id={descId} className="sr-only">
            {t`The map shows the storm-following ERA5 field window, the best track as a line with observed fixes as dots, and the current centre as a ring (filled at observed fixes, hollow when interpolated). The timeline table below has the same data as text.`}
          </p>
          {webglError ? (
            <Alert>
              <AlertTitle>{t`Map unavailable`}</AlertTitle>
              <AlertDescription>{t`This browser cannot draw the WebGL map, so the track is shown as a simple drawing. The timeline table has all the data.`}</AlertDescription>
            </Alert>
          ) : null}
          {snap.error ? (
            <Alert>
              <AlertTitle>{t`Field frames could not be loaded`}</AlertTitle>
              <AlertDescription>{t`The replay continues with the best track only. (${snap.error})`}</AlertDescription>
            </Alert>
          ) : null}
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
        {compact ? null : (
          <div className="grid content-start gap-4">
            <IntensityPanel
              hour={exactHour}
              era5WindMs={cur?.wind}
              era5MinMslp={cur?.mslp}
              radiusDeg={2}
              threeHourly={exactOnly}
              check={detail.reanalysisCheck}
              units={url.units}
              lang={lang}
              tz={tzChoice}
            />
            {layer !== "none" ? <FieldLegend layer={layer} units={url.units} theme={theme} /> : null}
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
      {showTable && !compact ? (
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

