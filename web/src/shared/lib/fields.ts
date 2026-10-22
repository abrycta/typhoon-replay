// Field layers and their fixed colour domains. Domains are the same for every storm, so colours are
// comparable across storms and decades (a 30 m/s wind is the same blue on Haiyan and on Vera).
import { markInk, scaleColors, type ThemeName } from "@abrycta/akari/maps";
import { map as mapTokens } from "@abrycta/akari/tokens";

import { buildLut, gradientCss, hexToRgb } from "./color";

export type FieldLayer = "wind" | "gust" | "rain" | "pressure";
export const FIELD_LAYERS: readonly FieldLayer[] = ["wind", "gust", "rain", "pressure"];

export interface FieldSpec {
  layer: FieldLayer;
  /** Variable name in the TYF frame file. */
  varName: string;
  units: "m/s" | "mm/h" | "hPa";
  domain: [number, number];
  /** Legend ticks in field units. */
  ticks: number[];
  /** Value -> 0..1 position on the colour ramp. */
  norm: "linear" | "sqrt" | "reverse";
  /** Speed fields can be shown in knots. */
  speed: boolean;
}

export const FIELDS: Record<FieldLayer, FieldSpec> = {
  wind: { layer: "wind", varName: "wind", units: "m/s", domain: [0, 40], ticks: [0, 10, 20, 30, 40], norm: "linear", speed: true },
  gust: { layer: "gust", varName: "gust", units: "m/s", domain: [0, 60], ticks: [0, 15, 30, 45, 60], norm: "linear", speed: true },
  rain: { layer: "rain", varName: "tp", units: "mm/h", domain: [0, 30], ticks: [0, 1, 5, 15, 30], norm: "sqrt", speed: false },
  pressure: { layer: "pressure", varName: "mslp", units: "hPa", domain: [950, 1015], ticks: [950, 970, 990, 1005, 1015], norm: "reverse", speed: false },
};

/** Position (0..1) of a value on the field's ramp. */
export function rampPosition(spec: FieldSpec, v: number): number {
  const [a, b] = spec.domain;
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  if (spec.norm === "sqrt") return Math.sqrt(t);
  if (spec.norm === "reverse") return 1 - t;
  return t;
}

export type MapTheme = "light" | "dark";

/** Akari's sequential data scale for the theme (high contrast shares the base data scales). */
export const fieldStops = (theme: MapTheme) => scaleColors("seq", theme).slice(1); // the lightest step is the basemap's own tone

/** Field opacity at ramp position t: calm values fade out so the basemap stays readable. */
const fieldAlpha = (t: number) => Math.min(0.9, 0.05 + t * 2);

/** 256-entry RGBA LUT indexed by ramp position. */
export function fieldLut(theme: MapTheme): Uint8Array {
  return buildLut(fieldStops(theme), fieldAlpha);
}

/** Wind particles are near-opaque so their heads keep ≥ 3:1 on the basemap and on every field colour. */
export const PARTICLE_ALPHA = 0.9;

/**
 * 256-entry RGBA LUT of particle ink by ramp position: for each field colour (composited on the basemap, as drawn),
 * Akari's markInk() picks map.particle or map.particle-strong, whichever contrasts more. With no field on show,
 * every entry is the ink for the bare basemap.
 */
export function particleInkLut(theme: ThemeName, noField = false): Uint8Array {
  const base = theme.startsWith("dark") ? "dark" : "light";
  const field = fieldLut(base);
  const ground = hexToRgb(mapTokens[theme].background);
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const a = noField ? 0 : field[i * 4 + 3]! / 255;
    const under = [0, 1, 2].map((c) => Math.round(field[i * 4 + c]! * a + ground[c]! * (1 - a)));
    const ink = hexToRgb(markInk(`#${under.map((x) => x.toString(16).padStart(2, "0")).join("")}`, theme));
    out.set([ink[0]!, ink[1]!, ink[2]!, 255], i * 4);
  }
  return out;
}

export function legendGradient(theme: MapTheme): string {
  return gradientCss(fieldStops(theme));
}
