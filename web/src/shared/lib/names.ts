import type { LocalNames } from "../model/types";

export interface Named {
  name: string;
  localNames?: LocalNames;
  season?: number;
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
