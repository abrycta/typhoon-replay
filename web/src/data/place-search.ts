// In-browser place search over the static index: English and Japanese names, typo-tolerant, fast enough
// to run on every keystroke over ~3,500 places (one pass, no allocation per place after `prepare`).
import { searchKey } from "@/shared/lib/names";

import type { PlaceEntry } from "./places";

export interface PreparedPlace {
  place: PlaceEntry;
  /** Romanised name keys: full ("city of manila"), and without "city"/"city of" ("manila"). */
  keys: string[];
  /** Japanese name keys: full ("那覇市") and without the municipal suffix ("那覇"). */
  ja: string[];
  admin: string;
}

const STRIP_EN = /^(city of |municipality of )|( city| municipality)$/g;
const STRIP_JA = /(市|区|町|村)$/;

/** Search key for Japanese text: NFKC (full-width ASCII, half-width kana) and katakana as hiragana. */
export function jaKey(s: string): string {
  return s.normalize("NFKC").replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

export function preparePlaces(places: readonly PlaceEntry[]): PreparedPlace[] {
  return places.map((place) => {
    const full = searchKey(place.name).replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
    const short = full.replace(STRIP_EN, "").trim();
    const ja = place.nameJa ? jaKey(place.nameJa) : "";
    return {
      place,
      keys: short && short !== full ? [full, short] : [full],
      ja: ja ? [ja, ja.replace(STRIP_JA, "")].filter((x, i, a) => x && a.indexOf(x) === i) : [],
      admin: searchKey([place.admin2, place.admin1, place.admin1Ja].filter(Boolean).join(" ")),
    };
  });
}

/** Levenshtein distance, giving up (returning max + 1) as soon as it must exceed `max`. */
export function boundedDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

function scoreKey(key: string, q: string): number {
  if (key === q) return 100;
  if (key.startsWith(q)) return 90 - Math.min(10, key.length - q.length);
  if (key.split(" ").some((w) => w.startsWith(q))) return 75;
  if (key.includes(q)) return 60;
  if (q.length >= 4) {
    // Typos: compare with the key's prefix of about the query's length ("tacloben" ~ "tacloban").
    const max = q.length >= 7 ? 2 : 1;
    for (const len of [q.length, q.length - 1, q.length + 1]) {
      if (len > key.length || len < 1) continue;
      const d = boundedDistance(key.slice(0, len), q, max);
      if (d <= max) return 45 - d * 10;
    }
  }
  return 0;
}

/**
 * Best matches for `query`, best first. Ranking: exact > prefix > word prefix > substring > near miss, then
 * places more storms passed near, then shorter names. Province/prefecture names match last (all their places).
 */
export function searchPlaces(prepared: readonly PreparedPlace[], query: string, limit = 10): PlaceEntry[] {
  const raw = query.trim();
  if (!raw) return [];
  const q = searchKey(raw).replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
  const qj = jaKey(raw);
  const hasJa = /[぀-ヿ㐀-鿿]/.test(qj);
  const scored: { p: PlaceEntry; s: number }[] = [];
  for (const e of prepared) {
    let s = 0;
    if (hasJa) {
      for (const k of e.ja) s = Math.max(s, k === qj ? 100 : k.startsWith(qj) ? 85 : k.includes(qj) ? 60 : 0);
    } else if (q) {
      for (const k of e.keys) s = Math.max(s, scoreKey(k, q));
    }
    if (!s && (q.length >= 3 || hasJa) && (e.admin.includes(q) || (hasJa && e.admin.includes(qj)))) s = 20;
    if (s) scored.push({ p: e.place, s });
  }
  scored.sort((a, b) => b.s - a.s || (b.p.storms100 ?? 0) - (a.p.storms100 ?? 0) || a.p.name.length - b.p.name.length || a.p.id.localeCompare(b.p.id));
  return scored.slice(0, limit).map((x) => x.p);
}
