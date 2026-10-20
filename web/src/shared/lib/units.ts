export const MS_PER_KT = 0.514444;

export type SpeedUnit = "ms" | "kt";

export const ktToMs = (kt: number) => kt * MS_PER_KT;
export const msToKt = (ms: number) => ms / MS_PER_KT;

export function speed(ms: number, unit: SpeedUnit): number {
  return unit === "kt" ? msToKt(ms) : ms;
}

export const speedLabel = (unit: SpeedUnit) => (unit === "kt" ? "kt" : "m/s");

/** Saffir–Simpson-like category from 1-minute (JTWC) knots; used only as a label beside the number. */
export function jtwcCategory(kt: number | undefined): string | undefined {
  if (kt === undefined) return undefined;
  if (kt >= 137) return "Cat 5";
  if (kt >= 113) return "Cat 4";
  if (kt >= 96) return "Cat 3";
  if (kt >= 83) return "Cat 2";
  if (kt >= 64) return "Cat 1";
  if (kt >= 34) return "TS";
  return "TD";
}

/** Great-circle distance in km. */
export function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = 6371.0088;
  const toRad = Math.PI / 180;
  const dp = (lat2 - lat1) * toRad;
  const dl = (lon2 - lon1) * toRad;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

/** Normalise a longitude to (-180, 180]. */
export function lon180(lon: number): number {
  const x = ((((lon + 180) % 360) + 360) % 360) - 180;
  return x === -180 ? 180 : x;
}
