// Colour maths for continuous field scales: Akari's stepped data scales are interpolated in OKLab
// (perceptually even) into a 256-entry lookup table the WebGL layer samples, and into CSS gradients
// for the legend, so the map and its legend always agree.

type Rgb = [number, number, number];
type Lab = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? [...h].map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toLinear = (c: number) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (x: number) => {
  const c = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
};

export function rgbToOklab([r8, g8, b8]: Rgb): Lab {
  const r = toLinear(r8), g = toLinear(g8), b = toLinear(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb([L, A, B]: Lab): Rgb {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** Colour at t in [0, 1] along evenly spaced stops, interpolated in OKLab. */
export function sampleScale(stops: readonly string[], t: number): Rgb {
  const labs = stops.map((s) => rgbToOklab(hexToRgb(s)));
  const x = Math.min(1, Math.max(0, t)) * (labs.length - 1);
  const i = Math.min(Math.floor(x), labs.length - 2);
  const f = x - i;
  const a = labs[i]!, b = labs[i + 1]!;
  return oklabToRgb([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
}

/** 256 RGBA entries: colour from the stops, alpha from `alpha(t)` (0..1). */
export function buildLut(stops: readonly string[], alpha: (t: number) => number): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const [r, g, b] = sampleScale(stops, t);
    lut.set([r, g, b, Math.round(Math.min(1, Math.max(0, alpha(t))) * 255)], i * 4);
  }
  return lut;
}

export const rgbCss = ([r, g, b]: Rgb, a = 1) => (a >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${a.toFixed(3)})`);

/** CSS linear-gradient matching buildLut (colour only; the legend shows opaque colours). */
export function gradientCss(stops: readonly string[], steps = 12, reverse = false): string {
  const parts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    parts.push(`${rgbCss(sampleScale(stops, reverse ? 1 - t : t))} ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${parts.join(", ")})`;
}
