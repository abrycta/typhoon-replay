import { EMBED } from "./haiyan.generated";

/** ?pr= from the parent (0.5-2, the frame is shown scaled down), else the device's, at most 2. */
export function embedPixelRatio(search = location.search): number {
  const pr = Number(new URLSearchParams(search).get("pr"));
  if (Number.isFinite(pr) && pr > 0) return Math.min(2, Math.max(0.5, pr));
  return Math.min(window.devicePixelRatio || 1, 2);
}

/** The live app's view of the same hour (and language, when one was asked for). */
export function deepLink(search = location.search): string {
  const lang = new URLSearchParams(search).get("lang");
  return EMBED.deepLink + (lang === "en" || lang === "ja" ? `&lang=${lang}` : "");
}
