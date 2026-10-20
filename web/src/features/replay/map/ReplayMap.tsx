import { type GeoJSONSource, type LngLatBoundsLike, Map as MaplibreMap, type Map as MlMap, NavigationControl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// MapLibre 6 derives its worker URL at runtime from import.meta.url, which bundlers cannot see, so the
// self-contained worker file is emitted as an asset and handed to MapLibre explicitly.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { setWorkerUrl } from "maplibre-gl";

setWorkerUrl(workerUrl);

import { useEffect, useRef, useState } from "react";

import { type FrameStore, hourAt, type TyfHeader } from "@/data";
import { FIELDS, fieldLut, type FieldLayer as FieldLayerId } from "@/shared/lib/fields";
import type { StormTrack, TrackHour } from "@/shared/model/types";

import type { PlayerClock } from "../player";
import { BASEMAP_STYLE, fallbackStyle, themeBasemap, type ThemeKey, tokenColor } from "./basemap";
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
  onViewChange?: (v: MapView) => void;
  interactive?: boolean;
  className?: string;
  onUnavailable?: (reason: string) => void;
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

function bounds(hours: readonly TrackHour[]): LngLatBoundsLike | undefined {
  const line = trackLine(hours);
  if (!line.length) return undefined;
  const lons = line.map((p) => p[0]), lats = line.map((p) => p[1]);
  return [Math.min(...lons) - 2, Math.min(...lats) - 2, Math.max(...lons) + 2, Math.max(...lats) + 2];
}

function positionAt(hours: readonly TrackHour[], t: number): { lon: number; lat: number; observed: boolean } | undefined {
  const a = hourAt(hours, t);
  if (!a) return undefined;
  const b = hourAt(hours, a.t + 3600);
  if (!b || b.t === a.t) return { lon: a.lon, lat: a.lat, observed: a.observed };
  const f = Math.min(1, Math.max(0, (t - a.t) / 3600));
  let dl = b.lon - a.lon;
  if (dl > 180) dl -= 360;
  if (dl < -180) dl += 360;
  return { lon: a.lon + dl * f, lat: a.lat + (b.lat - a.lat) * f, observed: f < 0.02 ? a.observed : f > 0.98 ? b.observed : false };
}

export default function ReplayMap(props: ReplayMapProps) {
  const { label, descriptionId, header, store, clock, track, layer, particles, showTrack, themeKey, view, interactive = true, className, onUnavailable } = props;
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const fieldRef = useRef<FieldLayer | null>(null);
  const fallbackRef = useRef(false);
  const [styleVersion, setStyleVersion] = useState(0);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  // Create the map once.
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    let map: MlMap;
    try {
      map = new MaplibreMap({
        container: el,
        style: BASEMAP_STYLE,
        center: view ? [view.lon, view.lat] : [125, 12],
        zoom: view?.zoom ?? 4,
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
      if (loaded || fallbackRef.current) return;
      fallbackRef.current = true;
      map.setStyle(fallbackStyle(latest.current.themeKey));
    };
    const timer = setTimeout(switchToFallback, 8000);
    map.on("error", (e) => {
      if (!loaded) switchToFallback();
      else console.warn("map:", e.error?.message);
    });
    map.on("style.load", () => {
      loaded = true;
      clearTimeout(timer);
      // Start with the attribution collapsed to its (i) button; it expands on demand.
      el.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
      setStyleVersion((v) => v + 1);
    });
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
  }, []);

  // (Re)add overlays after each style load and when the track arrives.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleVersion) return;
    themeBasemap(map, themeKey, fallbackRef.current);
    const firstSymbol = map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
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
    const lowEnd = (navigator.hardwareConcurrency ?? 8) <= 4 || ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) <= 4;
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
        const at = positionAt(p.track.hours, t0 + f * ((p.times[j] ?? t0) - t0));
        const src = map.getSource("current") as GeoJSONSource | undefined;
        if (at && src) src.setData({ type: "Feature", properties: { observed: at.observed }, geometry: { type: "Point", coordinates: [at.lon, at.lat] } });
      }
      map.triggerRepaint();
    };
    apply(clock.pos);
    const off = clock.onTick(apply);
    const unsub = store?.subscribe(() => apply(clock.pos));
    return () => {
      off();
      unsub?.();
    };
  }, [clock, store, styleVersion, header, track]);

  // Particles need continuous frames even while paused; stop when hidden or offscreen.
  useEffect(() => {
    if (!particles) return;
    let raf = 0;
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = !!e?.isIntersecting));
    if (container.current) io.observe(container.current);
    let last = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden || now - last < 30) return; // ~30 fps cap
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
