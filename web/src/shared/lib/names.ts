import type { LocalNames } from "../model/types";

export interface Named {
  name: string;
  localNames?: LocalNames;
  season?: number;
}

/** IBTrACS has no international name (the pipeline publishes "Unnamed" for NOT_NAMED/UNNAMED). */
export function isUnnamed(name: string | undefined): boolean {
  const n = (name ?? "").trim().toUpperCase();
  return n === "" || n === "UNNAMED" || n === "NOT_NAMED";
}

/** "台風第7号" or "昭和34年台風第15号" -> 7 / 15 (the JMA number within its season). */
export function jmaNumber(ja: string | undefined): number | undefined {
  const m = ja ? /台風第(\d+)号/.exec(ja) : null;
  return m ? Number(m[1]) : undefined;
}

/**
 * What a storm is called in lists, as data (features translate it):
 * - `international`: the WMO/RSMC name ("Haiyan"), PAGASA and Japanese names beside it as today;
 * - `pagasa`: no international name, but PAGASA named it ("Crising"): a local name;
 * - `jma`: no international or PAGASA name, but a JMA number ("台風第7号"): a local designation;
 * - `unnamed`: none of these; described by its start month, never shown as a bare "Unnamed".
 * `designation` is the JTWC number ("03W", from the index when the pipeline publishes it).
 */
export type StormLabel =
  | { kind: "international"; name: string }
  | { kind: "pagasa"; name: string; designation?: string }
  | { kind: "jma"; number: number; ja: string; designation?: string }
  | { kind: "unnamed"; startedAt: string; designation?: string };

export function stormLabel(s: Named & { startedAt: string; designation?: string }): StormLabel {
  if (!isUnnamed(s.name)) return { kind: "international", name: s.name };
  const designation = s.designation?.trim() || undefined;
  const ph = s.localNames?.ph?.trim();
  if (ph) return { kind: "pagasa", name: ph, designation };
  const ja = s.localNames?.ja?.trim();
  const n = jmaNumber(ja);
  if (ja && n !== undefined) return { kind: "jma", number: n, ja, designation };
  return { kind: "unnamed", startedAt: s.startedAt, designation };
}

/**
 * Display name rule: international name first, PAGASA name beside it ("Haiyan (Yolanda)");
 * in Japanese the JMA designation follows when known.
 */
export function stormTitle(s: Named, lang: "en" | "ja"): string {
  const ph = s.localNames?.ph;
  const base = ph ? `${s.name} (${ph})` : s.name;
  return lang === "ja" && s.localNames?.ja ? `${base} · ${s.localNames.ja}` : base;
}

/** Normalised search key: lower case, diacritics removed. */
export const searchKey = (s: string) => s.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase();
