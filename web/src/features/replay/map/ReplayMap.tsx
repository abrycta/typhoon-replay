import { type GeoJSONSource, type ImageSource, type LngLatBoundsLike, Map as MaplibreMap, Marker, MercatorCoordinate, type Map as MlMap, NavigationControl } from "maplibre-gl";
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
import { ktToMs } from "@/shared/lib/units";
import { usePrefersReducedMotion } from "@/shared/ui/hooks";
import type { StormTrack, TrackHour } from "@/shared/model/types";

import type { PlayerClock } from "../player";
import { BASEMAP_STYLE, type CustomBasemap, fallbackStyle, themeBasemap, type ThemeKey, tokenColor } from "./basemap";
import { coverZoom } from "./cover-zoom";
import { eyeAt } from "./eye";
import { FieldLayer } from "./field-layer";
import { labelCandidates, overlaps, type Rect, sealAt } from "./seal";

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
  /** Called once, on the first idle map after the basemap, the track and (when one is expected) the current field
   * frame are drawn: the parent lifts its glyph still then. */
  onRendered?: () => void;
  /** A field frame is on its way (the storm has frames and none failed): wait for it before `onRendered`. */
  awaitField?: boolean;
  /** The map size `view` was framed for (the embed's baked basemap): at any other size the zoom changes so the map
   * still fills with the same area (cover), at creation and on every resize. */
  viewFrame?: readonly [number, number];
  /** The storm seal's label on wide maps (wind and time); default m/s and UTC. */
  sealLabel?: (kt: number | undefined, t: number) => string;
}

/** Maps narrower than this (phones, the compact embed) show the seal only, without its label. */
const SEAL_LABEL_MIN_WIDTH = 520;

const defaultSealLabel = (kt: number | undefined, t: number) => {
  const d = new Date(t * 1000);
  const when = `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${String(d.getUTCHours()).padStart(2, "0")}:00Z`;
  return kt === undefined ? when : `${Math.round(ktToMs(kt))} m/s · ${when}`;
};

/** The storm seal: a small 朱 square with the category, on a paper edge, and a mono label beside it (wide maps). */
function sealMarker(): HTMLElement {
  const el = document.createElement("div");
  el.dataset.testid = "storm-seal";
  el.setAttribute("aria-hidden", "true"); // the hour, wind and category are in the player and the timeline table
  el.className = "pointer-events-none relative h-0 w-0";
  el.innerHTML =
    '<span data-seal class="absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[2.5px] bg-seal font-mono leading-none font-bold text-ak-on-accent ring-2 ring-background"></span>' +
    '<span data-label class="absolute rounded-[3px] bg-background/90 px-1.5 py-0.5 font-mono text-ak-2xs leading-tight whitespace-nowrap text-foreground"></span>';
  return el;
}

/** Symbol (label) layers of the style, and raster label images drawn above the field (the embed's baked labels). */
function labelLayers(map: MlMap): { symbols: string[]; images: string[] } {
  const symbols: string[] = [], images: string[] = [];
  for (const l of map.getStyle().layers ?? []) {
    if (l.type === "symbol") symbols.push(l.id);
    else if (l.type === "raster" && (l.metadata as Record<string, unknown> | undefined)?.["replay:above-field"]) images.push(l.source);
  }
  return { symbols, images };
}

/** Alpha of a label image (an image source), read once per URL; undefined until loaded or when unreadable. */
const alphaCache = new Map<string, { w: number; h: number; a: Uint8ClampedArray } | null>();
function imageAlpha(url: string): { w: number; h: number; a: Uint8ClampedArray } | undefined {
  const hit = alphaCache.get(url);
  if (hit !== undefined) return hit ?? undefined;
  alphaCache.set(url, null);
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    try {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const a = new Uint8ClampedArray(c.width * c.height);
      for (let k = 0; k < a.length; k++) a[k] = d[k * 4 + 3]!;
      alphaCache.set(url, { w: c.width, h: c.height, a });
    } catch {
      /* unreadable (cross-origin): no collision data */
    }
  };
  img.src = url;
  return undefined;
}

/** Does a screen box cover text in a label image source? Samples every 2 px. */
function imageLabelsIn(map: MlMap, sourceId: string, r: Rect): boolean {
  const src = map.getSource(sourceId) as ImageSource | undefined;
  if (!src?.url || !src.coordinates) return false;
  const px = imageAlpha(src.url);
  if (!px) return false;
  const [tl, tr, , bl] = src.coordinates.map((c) => MercatorCoordinate.fromLngLat({ lng: c[0], lat: c[1] }));
  const x0 = tl!.x, dx = tr!.x - tl!.x, y0 = tl!.y, dy = bl!.y - tl!.y;
  let hits = 0;
  for (let y = r.y; y <= r.y + r.h; y += 2) {
    for (let x = r.x; x <= r.x + r.w; x += 2) {
      const m = MercatorCoordinate.fromLngLat(map.unproject([x, y]));
      let mx = m.x;
      if (mx < x0) mx += 1;
      else if (mx > x0 + dx) mx -= 1;
      const u = Math.floor(((mx - x0) / dx) * px.w), v = Math.floor(((m.y - y0) / dy) * px.h);
      if (u < 0 || v < 0 || u >= px.w || v >= px.h) continue;
      if (px.a[v * px.w + u]! > 96 && ++hits >= 3) return true;
    }
  }
  return false;
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
    '<path d="M3 3l10 10M13 3L3 13" stroke="var(--background)" stroke-width="5" stroke-linecap="round"/>' +
    '<path d="M3 3l10 10M13 3L3 13" stroke="var(--foreground)" stroke-width="2.25" stroke-linecap="round"/></svg>' +
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
  // Reduced motion: the seal steps hour by hour, and its label changes once per hour, never per frame.
  const reducedMotion = usePrefersReducedMotion();
  const reducedRef = useRef(reducedMotion);
  useEffect(() => {
    reducedRef.current = reducedMotion;
  }, [reducedMotion]);

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
      map.addLayer({ id: "track-line", type: "line", source: "track", paint: { "line-color": ink, "line-width": 1.6, "line-opacity": 0.85 } });
      map.addLayer({ id: "track-fixes", type: "circle", source: "fixes", paint: { "circle-radius": 2.4, "circle-color": ink, "circle-stroke-color": bg, "circle-stroke-width": 0.8 } });
    }
    for (const id of ["track-line", "track-fixes"]) map.setLayoutProperty(id, "visibility", showTrack ? "visible" : "none");
    map.setPaintProperty("track-line", "line-color", ink);
    map.setPaintProperty("track-fixes", "circle-color", ink);
    map.setPaintProperty("track-fixes", "circle-stroke-color", bg);
    if (!view) {
      const b = bounds(hours);
      if (b) map.fitBounds(b, { padding: 24, animate: false, maxZoom: 6 });
    }
    map.triggerRepaint();
    if (!renderedRef.current) {
      const check = () => {
        const p = latest.current;
        if (renderedRef.current || !map.loaded() || !p.track?.hours.length) return;
        if ((p.header || p.awaitField) && !fieldRef.current?.hasFrame) return;
        renderedRef.current = true;
        map.off("idle", check);
        latest.current.onRendered?.();
      };
      map.on("idle", check);
    }
    // view only seeds the first fit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleVersion, track, themeKey, showTrack]);

  // A late header, field failure or track: one more idle for the first-frame check above.
  useEffect(() => {
    if (!renderedRef.current) mapRef.current?.triggerRepaint();
  }, [header, props.awaitField, track]);

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

  // The storm seal (a DOM marker, above every map layer) and where its label goes.
  const sealRef = useRef<Marker | null>(null);
  const sealDraw = useRef<((lon: number, lat: number, t: number, prevT: number, nextT: number) => void) | undefined>(undefined);
  const placeRef = useRef<{ x: number; y: number; text: string; k: number; dirty: boolean }>({ x: 0, y: 0, text: "", k: 0, dirty: true });
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleVersion) return;
    const layers = labelLayers(map);
    const marker = (sealRef.current ??= new Marker({ element: sealMarker(), anchor: "center" }));
    const place = placeRef.current;
    const dirty = () => (place.dirty = true);
    // Place labels appear as tiles load and after moves: once the map settles, place the label again.
    let last: Parameters<NonNullable<typeof sealDraw.current>> | undefined;
    const settle = () => {
      if (!last) return;
      place.dirty = true;
      sealDraw.current?.(...last);
    };
    map.on("moveend", dirty);
    map.on("resize", dirty);
    map.on("idle", settle);
    place.dirty = true;
    const el = marker.getElement();
    const square = el.querySelector<HTMLElement>("[data-seal]")!;
    const label = el.querySelector<HTMLElement>("[data-label]")!;
    let size = 0, text = "", added = false;
    sealDraw.current = (lon, lat, t, prevT, nextT) => {
      last = [lon, lat, t, prevT, nextT];
      const p = latest.current;
      const hours = p.track?.hours ?? [];
      const s = sealAt(hours, t);
      if (s.size !== size) {
        size = s.size;
        Object.assign(square.style, { width: `${size}px`, height: `${size}px` });
      }
      if (s.text !== text) {
        text = s.text;
        square.textContent = text;
        square.style.fontSize = text.length > 1 ? "7.5px" : "11px";
      }
      marker.setLngLat([lon, lat]);
      if (!added) {
        marker.addTo(map);
        added = true;
      }
      // Label: wide maps only; on the side of the track facing up, moved off place labels and the map edge.
      const container = map.getContainer();
      const wide = !p.viewFrame && container.clientWidth >= SEAL_LABEL_MIN_WIDTH;
      label.hidden = !wide;
      if (!wide) return;
      const txt = (p.sealLabel ?? defaultSealLabel)(s.kt, t);
      if (label.textContent !== txt) label.textContent = txt;
      const pt = map.project([lon, lat]);
      if (!place.dirty && txt.length === place.text.length && Math.hypot(pt.x - place.x, pt.y - place.y) < 6) return;
      const a = map.project(eyeAt(hours, prevT, true) ?? { lon, lat }), b = map.project(eyeAt(hours, nextT, true) ?? { lon, lat });
      const w = label.offsetWidth, h = label.offsetHeight;
      const cands = labelCandidates(pt.x, pt.y, [b.x - a.x, b.y - a.y], size / 2 + 2, w, h);
      const W = container.clientWidth, H = container.clientHeight, m = 4;
      const showTrack = map.getLayoutProperty("track-line", "visibility") !== "none";
      const score = (r: Rect, k: number) => {
        let v = r.x < m || r.y < m || r.x + r.w > W - m || r.y + r.h > H - m ? 1000 : 0;
        // Place labels count with a few px of clearance, so the label never hugs a town name.
        const pad = { x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8 };
        const box: [[number, number], [number, number]] = [[pad.x, pad.y], [pad.x + pad.w, pad.y + pad.h]];
        if (layers.symbols.length && map.queryRenderedFeatures(box, { layers: layers.symbols }).length) v += 100;
        else if (layers.images.some((id) => imageLabelsIn(map, id, pad))) v += 100;
        if (showTrack && map.queryRenderedFeatures(box, { layers: ["track-line"] }).length) v += 10;
        if (overlaps(r, { x: pt.x - size / 2 - 2, y: pt.y - size / 2 - 2, w: size + 4, h: size + 4 })) v += 1000;
        return v + (k === place.k ? 0 : 1); // keep the current side unless another is clearer
      };
      let best = 0, bestScore = Infinity;
      cands.forEach((r, k) => {
        const v = score(r, k);
        if (v < bestScore) [best, bestScore] = [k, v];
      });
      const r = cands[best]!;
      Object.assign(label.style, { left: `${Math.round(r.x - pt.x)}px`, top: `${Math.round(r.y - pt.y)}px` });
      Object.assign(place, { x: pt.x, y: pt.y, text: txt, k: best, dirty: false });
    };
    return () => {
      map.off("moveend", dirty);
      map.off("resize", dirty);
      map.off("idle", settle);
      sealDraw.current = undefined;
    };
  }, [styleVersion]);
  useEffect(() => () => void sealRef.current?.remove(), []);

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
        const t = reducedRef.current ? (p.times[Math.round(pos)] ?? t0) : t0 + f * ((p.times[j] ?? t0) - t0);
        const at = eyeAt(p.track.hours, t, clock.snapshot.playing);
        if (at) sealDraw.current?.(at.lon, at.lat, t, t - 3600, t + 3600);
      }
      map.triggerRepaint();
    };
    apply(clock.pos);
    const off = clock.onTick(apply);
    const offState = clock.subscribe(() => apply(clock.pos));
    const unsub = store?.subscribe(() => apply(clock.pos));
    return () => {
      off();
      offState();
      unsub?.();
    };
  }, [clock, store, styleVersion, header, track, reducedMotion]);

  // ERA5 centre marker: a DOM marker (an ✕, unlike the track's seal) with a visible label and an accessible name.
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
