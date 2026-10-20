// Field layers and their fixed colour domains. Domains are the same for every storm, so colours are
// comparable across storms and decades (a 30 m/s wind is the same blue on Haiyan and on Vera).
import { scaleColors } from "@abrycta/akari/maps";

import { buildLut, gradientCss } from "./color";

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

/** 256-entry RGBA LUT indexed by ramp position. Calm values fade out so the basemap stays readable. */
export function fieldLut(theme: MapTheme): Uint8Array {
  return buildLut(fieldStops(theme), (t) => Math.min(0.9, 0.05 + t * 2));
}

export function legendGradient(theme: MapTheme): string {
  return gradientCss(fieldStops(theme));
}
