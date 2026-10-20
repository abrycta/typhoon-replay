// Lingui runtime: app strings are ICU messages compiled at build time (lingui.config.ts, *.po catalogs).
// Akari's own components keep their <T en ja> strings; Akari's useLang() is the single source of the
// current language and LinguiBridge (./bridge.tsx) follows it.
import { i18n } from "@lingui/core";

export type Locale = "en" | "ja";
export const LOCALES: readonly Locale[] = ["en", "ja"];

const loaders: Record<Locale, () => Promise<{ messages: Record<string, unknown> }>> = {
  en: () => import("./locales/en.po"),
  ja: () => import("./locales/ja.po"),
};

export function isLocale(x: unknown): x is Locale {
  return x === "en" || x === "ja";
}

export async function activateLocale(locale: Locale): Promise<void> {
  if (i18n.locale === locale) return;
  const { messages } = await loaders[locale]();
  i18n.loadAndActivate({ locale, messages: messages as never });
}

/** Saved language (Akari's LangProvider key), else the browser's. */
export function initialLocale(): Locale {
  try {
    const url = new URLSearchParams(location.search).get("lang");
    if (isLocale(url)) return url;
    const saved = localStorage.getItem("lang");
    if (isLocale(saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  return typeof navigator !== "undefined" && navigator.language?.startsWith("ja") ? "ja" : "en";
}

export { i18n };
