// The static page shell written into index.html at build time (scripts/prerender-shell.mjs), so the first paint is
// the real Header and an empty page area instead of a blank page while the scripts load (Kurt, 2026-10-23: the page
// renders at once, no loader). React's first render replaces it in place; it is the same Header markup at the same
// size, so nothing shifts. Not part of the app bundle.
import { AkariProvider, AppShell, Header } from "@abrycta/akari/react";
import { renderToStaticMarkup } from "react-dom/server";

const COPY = {
  en: { home: "home", main: "Main", nav: ["Home", "Storms", "Compare", "My town", "Tech", "About"], skip: "Skip to content" },
  ja: { home: "ホーム", main: "メイン", nav: ["ホーム", "台風", "比較", "わが町", "技術", "概要"], skip: "本文へスキップ" },
} as const;
const HREFS = ["/", "/storms", "/compare", "/town", "/under-the-hood", "/about"] as const;

export function staticShell(lang: "en" | "ja"): string {
  const c = COPY[lang];
  return renderToStaticMarkup(
    <AkariProvider defaultLang={lang} toaster={false} sharedCookieDomain="krtmtthw.dev" inlineScript={false}>
      <AppShell
        header={
          <Header
            brand={{ name: "Replay", glyph: "再", href: "/", srSuffix: c.home }}
            navLabel={c.main}
            nav={HREFS.map((href, i) => ({ href, label: c.nav[i]!, ...(href === "/storms" ? { also: ["/storm/"] } : {}) }))}
            location={{ pathname: "/" }}
            portfolioLink
            languages
          />
        }
      >
        <a href="#main" className="sr-only">
          {c.skip}
        </a>
        <div id="main" tabIndex={-1} className="min-h-dvh outline-none" />
      </AppShell>
    </AkariProvider>,
  );
}
