export type TimeZoneChoice = "UTC" | "Asia/Manila" | "Asia/Tokyo";
export type Lang = "en" | "ja";

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(lang: Lang, timeZone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${lang}|${timeZone}|${JSON.stringify(opts)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-GB", { timeZone, ...opts });
    cache.set(key, f);
  }
  return f;
}

const toDate = (t: number | string | Date) => (t instanceof Date ? t : typeof t === "number" ? new Date(t * 1000) : new Date(t));

/** "7 Nov 2013, 21:00 GMT+8" / "2013年11月7日 21:00 GMT+8". */
export function formatDateTime(t: number | string | Date, lang: Lang, timeZone: TimeZoneChoice = "UTC"): string {
  return fmt(lang, timeZone, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: timeZone === "UTC" ? undefined : "shortOffset",
  }).format(toDate(t)) + (timeZone === "UTC" ? " UTC" : "");
}

/** Short form for dense tables: "7 Nov 21:00". */
export function formatShort(t: number | string | Date, lang: Lang, timeZone: TimeZoneChoice = "UTC"): string {
  return fmt(lang, timeZone, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(toDate(t));
}

export function formatDate(t: number | string | Date, lang: Lang): string {
  return fmt(lang, "UTC", { day: "numeric", month: "short", year: "numeric" }).format(toDate(t));
}

/** "Feb 1940" / "1940年2月" (UTC). */
export function formatMonth(t: number | string | Date, lang: Lang): string {
  return fmt(lang, "UTC", { month: "short", year: "numeric" }).format(toDate(t));
}

/** URL form of an hour: 2013-11-07T21:00Z. */
export function toUrlHour(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 16) + "Z";
}

export function fromUrlHour(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const ms = Date.parse(s.endsWith("Z") && s.length === 17 ? s.replace("Z", ":00Z") : s);
  return Number.isNaN(ms) ? undefined : Math.round(ms / 1000);
}

export const isoToUnix = (s: string) => Math.round(Date.parse(s) / 1000);
