import { type GeoJSONSource, type LngLatBoundsLike, Map as MaplibreMap, Marker, type Map as MlMap, NavigationControl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// MapLibre 6 derives its worker URL at runtime from import.meta.url, which bundlers cannot see, so the
// self-contained worker file is emitted as an asset and handed to MapLibre explicitly.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { setWorkerCount, setWorkerUrl } from "maplibre-gl";

setWorkerUrl(workerUrl);

import { useEffect, useRef, useState } from "react";

import { type FrameStore, type TyfHeader } from "@/data";
import { hostPause } from "@/shared/ui/host-pause";
import { FIELDS, fieldLut, type FieldLayer as FieldLayerId } from "@/shared/lib/fields";
import { isLeavingPage, onPageExit } from "@/shared/lib/page-exit";
import type { StormTrack, TrackHour } from "@/shared/model/types";

import type { PlayerClock } from "../player";
import { BASEMAP_STYLE, type CustomBasemap, fallbackStyle, themeBasemap, type ThemeKey, tokenColor } from "./basemap";
import { coverZoom } from "./cover-zoom";
import { eyeAt } from "./eye";
import { FieldLayer } from "./field-layer";

export interface MapView {
  lon: number;
  lat: number;
  zoom: number;
}

export interface ReplayMapProps {
  label: string;
  descriptionId?: string;
  header?: TyfHeader;
  store?: FrameStore;
  clock: PlayerClock;
  /** Unix time of each timeline index. */
  times: number[];
  track?: StormTrack;
  layer: FieldLayerId | "none";
  particles: boolean;
  showTrack: boolean;
  themeKey: ThemeKey;
  view?: MapView;
  /** ERA5's own storm centre at this hour, marked only when it is far from the track (never moves the field). */
  era5Centre?: { lon: number; lat: number; label: string; name: string };
  onViewChange?: (v: MapView) => void;
  interactive?: boolean;
  className?: string;
  onUnavailable?: (reason: string) => void;
  /** Replaces the OpenFreeMap basemap (the frozen embed); no fallback switching then. */
  basemap?: CustomBasemap;
  /** MapLibre pixelRatio (the embed is shown scaled down); default devicePixelRatio. */
  pixelRatio?: number;
  /** Called once, on the first idle map after the overlays and the current frame are drawn. */
  onRendered?: () => void;
  /** The map size `view` was framed for (the embed's baked basemap): at any other size the zoom changes so the map
   * still fills with the same area (cover), at creation and on every resize. */
  viewFrame?: readonly [number, number];
}

function trackLine(hours: readonly TrackHour[]): [number, number][] {
  // Unwrap longitudes so a track crossing the antimeridian stays continuous.
  const out: [number, number][] = [];
  let prev: number | undefined;
  for (const h of hours) {
    let lon = h.lon;
    if (prev !== undefined) {
      while (lon - prev > 180) lon -= 360;
      while (prev - lon > 180) lon += 360;
    }
    out.push([lon, h.lat]);
    prev = lon;
  }
  return out;
}

function era5Marker(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("role", "img");
  el.dataset.testid = "era5-centre-marker";
  el.className = "pointer-events-none flex items-center gap-1";
  el.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style="overflow:visible">' +
    '<path d="M3 3l10 10M13 3L3 13" stroke="var(--background, #fff)" stroke-width="5" stroke-linecap="round"/>' +
    '<path d="M3 3l10 10M13 3L3 13" stroke="var(--foreground, #111)" stroke-width="2.25" stroke-linecap="round"/></svg>' +
    '<span data-label aria-hidden="true" class="rounded-sm bg-background/85 px-1 font-mono text-[10px] text-foreground"></span>';
  return el;
}

function bounds(hours: readonly TrackHour[]): LngLatBoundsLike | undefined {
  const line = trackLine(hours);
  if (!line.length) return undefined;
  const lons = line.map((p) => p[0]), lats = line.map((p) => p[1]);
  return [Math.min(...lons) - 2, Math.min(...lats) - 2, Math.max(...lons) + 2, Math.max(...lats) + 2];
}


export default function ReplayMap(props: ReplayMapProps) {
  const { label, descriptionId, header, store, clock, track, layer, particles, showTrack, themeKey, view, interactive = true, className, onUnavailable } = props;
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const fieldRef = useRef<FieldLayer | null>(null);
  const fallbackRef = useRef(false);
  const renderedRef = useRef(false);
  const [styleVersion, setStyleVersion] = useState(0);
  // The reader is leaving: no map (its workers, style and tiles would only be cancelled or refused, and logged).
  // Should they stay after all, it is built again.
  const [leaving, setLeaving] = useState(isLeavingPage);
  useEffect(() => onPageExit(setLeaving), []);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  // Create the map once.
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    if (leaving) return;
    // The compact embed (phones, tablets): one worker is plenty for a still view, and each one costs memory (Safari
    // otherwise starts up to three). Only before the first map, which the embed's is.
    if (props.viewFrame) setWorkerCount(1);
    let map: MlMap;
    try {
      map = new MaplibreMap({
        container: el,
        style: props.basemap?.style(themeKey) ?? BASEMAP_STYLE,
        pixelRatio: props.pixelRatio,
        center: view ? [view.lon, view.lat] : [125, 12],
        zoom: view && props.viewFrame ? coverZoom(view.zoom, props.viewFrame, el.clientWidth, el.clientHeight) : (view?.zoom ?? 4),
        interactive,
        attributionControl: { compact: true, customAttribution: "ERA5: Copernicus C3S · Track: IBTrACS (NOAA NCEI)" },
        cooperativeGestures: false,
        fadeDuration: 0,
        maxPitch: 0,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        renderWorldCopies: true,
      });
    } catch (e) {
      onUnavailable?.(e instanceof Error ? e.message : "WebGL2 unavailable");
      return;
    }
    mapRef.current = map;
    // Test hook: e2e tests and dev tools inspect the live maps (no effect in normal use).
    const w = window as unknown as { __trMaps?: MlMap[] };
    w.__trMaps = [...(w.__trMaps ?? []), map];
    if (interactive) map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.touchZoomRotate.disableRotation();
    map.getCanvas().setAttribute("aria-label", label);
    if (descriptionId) map.getCanvas().setAttribute("aria-describedby", descriptionId);

    // Fall back to the bundled coastline when the tile host fails before the style loads.
    let loaded = false;
    const switchToFallback = () => {
      // Leaving mid-load: the browser cancelled the style; loading the coastline now only logs an error.
      if (loaded || fallbackRef.current || latest.current.basemap || isLeavingPage()) return;
      fallbackRef.current = true;
      map.setStyle(fallbackStyle(latest.current.themeKey));
    };
    const timer = setTimeout(switchToFallback, 8000);
    map.on("error", (e) => {
      if (!loaded) switchToFallback();
      else if (!isLeavingPage()) console.warn("map:", e.error?.message);
    });
    map.on("style.load", () => {
      loaded = true;
      clearTimeout(timer);
      // Start with the attribution collapsed to its (i) button; it expands on demand.
      el.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
      setStyleVersion((v) => v + 1);
    });
    if (view && props.viewFrame) {
      const frame = props.viewFrame;
      map.on("resize", () => map.jumpTo({ center: [view.lon, view.lat], zoom: coverZoom(view.zoom, frame, el.clientWidth, el.clientHeight) }));
    }
    map.on("moveend", (e) => {
      if (!(e as { originalEvent?: unknown }).originalEvent) return; // only user moves update the URL
      const c = map.getCenter();
      latest.current.onViewChange?.({ lon: +c.lng.toFixed(3), lat: +c.lat.toFixed(3), zoom: +map.getZoom().toFixed(2) });
    });
    return () => {
      clearTimeout(timer);
      map.remove();
      mapRef.current = null;
      fieldRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaving]);

  // (Re)add overlays after each style load and when the track arrives.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleVersion) return;
    if (props.basemap) props.basemap.theme(map, themeKey);
    else themeBasemap(map, themeKey, fallbackRef.current);
    const firstSymbol = map
      .getStyle()
      .layers?.find((l) => l.type === "symbol" || (l.metadata as Record<string, unknown> | undefined)?.["replay:above-field"])?.id;
    if (!map.getLayer("era5-field")) {
      const fl = new FieldLayer("era5-field");
      fieldRef.current = fl;
      map.addLayer(fl, firstSymbol);
    }
    const ink = tokenColor("color.text", themeKey);
    const seal = tokenColor("component.seal.color", themeKey);
    const bg = tokenColor("color.bg", themeKey);
    const hours = track?.hours ?? [];
    const lineData = { type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: trackLine(hours) } };
    const fixData = {
      type: "FeatureCollection" as const,
      features: hours.filter((h) => h.observed).map((h) => ({ type: "Feature" as const, properties: {}, geometry: { type: "Point" as const, coordinates: [h.lon, h.lat] } })),
    };
    const src = map.getSource("track") as GeoJSONSource | undefined;
    if (src) {
      src.setData(lineData);
      (map.getSource("fixes") as GeoJSONSource).setData(fixData);
    } else {
      map.addSource("track", { type: "geojson", data: lineData });
      map.addSource("fixes", { type: "geojson", data: fixData });
      map.addSource("current", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "track-line", type: "line", source: "track", paint: { "line-color": ink, "line-width": 1.6, "line-opacity": 0.85 } });
      map.addLayer({ id: "track-fixes", type: "circle", source: "fixes", paint: { "circle-radius": 2.4, "circle-color": ink, "circle-stroke-color": bg, "circle-stroke-width": 0.8 } });
      map.addLayer({
        id: "current",
        type: "circle",
        source: "current",
        paint: {
          "circle-radius": 7,
          "circle-color": ["case", ["get", "observed"], seal, "rgba(0,0,0,0)"],
          "circle-stroke-color": seal,
          "circle-stroke-width": 2.5,
        },
      });
    }
    for (const id of ["track-line", "track-fixes"]) map.setLayoutProperty(id, "visibility", showTrack ? "visible" : "none");
    map.setPaintProperty("track-line", "line-color", ink);
    map.setPaintProperty("track-fixes", "circle-color", ink);
    map.setPaintProperty("track-fixes", "circle-stroke-color", bg);
    map.setPaintProperty("current", "circle-stroke-color", seal);
    map.setPaintProperty("current", "circle-color", ["case", ["get", "observed"], seal, "rgba(0,0,0,0)"]);
    if (!view) {
      const b = bounds(hours);
      if (b) map.fitBounds(b, { padding: 24, animate: false, maxZoom: 6 });
    }
    map.triggerRepaint();
    if (latest.current.onRendered && !renderedRef.current) {
      const check = () => {
        if (renderedRef.current || !map.loaded() || (latest.current.header && !fieldRef.current?.hasFrame)) return;
        renderedRef.current = true;
        map.off("idle", check);
        latest.current.onRendered?.();
      };
      map.on("idle", check);
    }
    // view only seeds the first fit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleVersion, track, themeKey, showTrack]);

  // Field style (layer, theme) and particles.
  useEffect(() => {
    const fl = fieldRef.current;
    if (!fl || !header) return;
    fl.setHeader(header);
  }, [header, styleVersion]);

  useEffect(() => {
    const fl = fieldRef.current;
    if (!fl || !header) return;
    const spec = layer === "none" ? FIELDS.wind : FIELDS[layer];
    const vi = Math.max(0, header.vars.findIndex((v) => v.name === spec.varName));
    const v = header.vars[vi]!;
    fl.setStyle({
      varIndex: vi,
      encoding: v.encoding === "sqrt" ? 1 : 0,
      scale: v.scale,
      offset: v.offset,
      domain: spec.domain,
      norm: spec.norm === "sqrt" ? 1 : spec.norm === "reverse" ? 2 : 0,
      lut: fieldLut(themeKey.startsWith("dark") ? "dark" : "light"),
      opacity: 1,
      visible: layer !== "none",
    });
    const particleInk = themeKey.startsWith("dark") ? [0.95, 0.95, 0.92, 0.7] : [0.1, 0.11, 0.13, 0.55];
    // Fewer particles on low-end devices and in the compact embed (phones, tablets), where 72² crowd the small map.
    const lowEnd = !!latest.current.viewFrame || (navigator.hardwareConcurrency ?? 8) <= 4 || ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) <= 4;
    fl.setParticles({ enabled: particles, color: particleInk as [number, number, number, number], res: lowEnd ? 48 : 72 });
  }, [header, layer, particles, themeKey, styleVersion]);

  // Drive the layer from the clock (fractional position, every animation frame).
  useEffect(() => {
    const apply = (pos: number) => {
      const map = mapRef.current;
      const fl = fieldRef.current;
      const p = latest.current;
      if (!map) return;
      const i = Math.floor(pos + 1e-6);
      const j = Math.min(i + 1, p.times.length - 1);
      const f = pos - i;
      if (fl && p.store && p.header) {
        const ra = p.store.frame(i), rb = p.store.frame(j);
        const ua = p.store.uv(i), ub = p.store.uv(j);
        fl.setFrames(ra && ua ? { index: i, raw: ra, uv: ua } : undefined, rb && ub ? { index: j, raw: rb, uv: ub } : undefined, f);
      }
      const t0 = p.times[i];
      if (t0 !== undefined && p.track) {
        const at = eyeAt(p.track.hours, t0 + f * ((p.times[j] ?? t0) - t0), clock.snapshot.playing);
        const src = map.getSource("current") as GeoJSONSource | undefined;
        if (at && src) src.setData({ type: "Feature", properties: { observed: at.filled }, geometry: { type: "Point", coordinates: [at.lon, at.lat] } });
      }
      map.triggerRepaint();
    };
    apply(clock.pos);
    const off = clock.onTick(apply);
    const offState = clock.subscribe(() => apply(clock.pos)); // fill the ring once playback pauses on a fix
    const unsub = store?.subscribe(() => apply(clock.pos));
    return () => {
      off();
      offState();
      unsub?.();
    };
  }, [clock, store, styleVersion, header, track]);

  // ERA5 centre marker: a DOM marker (an ✕, unlike the track's ring) with a visible label and an accessible name.
  const era5 = props.era5Centre;
  const markerRef = useRef<Marker | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleVersion) return;
    if (!era5) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) markerRef.current = new Marker({ element: era5Marker(), anchor: "left", offset: [-8, 0] }) // the ✕ (16 px) on the point;
    const el = markerRef.current.getElement();
    el.setAttribute("aria-label", era5.name);
    el.querySelector("[data-label]")!.textContent = era5.label;
    markerRef.current.setLngLat([era5.lon, era5.lat]).addTo(map);
  }, [era5?.lon, era5?.lat, era5?.label, era5?.name, styleVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => void markerRef.current?.remove(), []);

  // Particles need continuous frames even while paused; stop when hidden, offscreen, or paused by the embedding page.
  useEffect(() => {
    if (!particles) return;
    let raf = 0;
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = !!e?.isIntersecting));
    if (container.current) io.observe(container.current);
    let last = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden || hostPause.get() || now - last < 30) return; // ~30 fps cap
      last = now;
      mapRef.current?.triggerRepaint();
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [particles]);

  // MapLibre's (unlayered) CSS sets position on the map element, so layout classes go on a wrapper.
  return (
    <div className={className} data-testid="replay-map" data-field-layer={layer}>
      <div ref={container} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
