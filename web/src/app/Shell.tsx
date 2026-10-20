import { AppShell, Header, LangSwitch, Logo, ThemeToggle, useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { Link, useLocation } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";

import { selectBackend } from "@/api";
import { BackendSwitch, ServedByFooter } from "@/features/backend-switch";
import { Attribution, DataAsOf } from "@/features/dataset-info";
import { buildInfo, formatBuildInfo } from "@/shared/lib/build-info";
import { isLocale } from "@/shared/i18n/i18n";
import { ContrastToggle } from "@/shared/ui/contrast-toggle";

/** `?backend=` and `?lang=` work on any page (share links, mock demo). */
function useGlobalParams() {
  const search = useLocation({ select: (l) => l.search as Record<string, unknown> });
  const { setLang } = useLang();
  useEffect(() => {
    const b = search.backend;
    if (b === "java" || b === "node" || b === "rust" || b === "go" || b === "mock") selectBackend(b);
    if (isLocale(search.lang)) setLang(search.lang);
  }, [search.backend, search.lang, setLang]);
}

export function Shell({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  useGlobalParams();
  const nav = "rounded-sm px-1 py-0.5 hover:text-foreground [&.active]:text-foreground [&.active]:underline underline-offset-4";
  return (
    <AppShell
      header={
        <Header
          brand={
            <Link to="/" aria-label={t`Typhoon Replay home`}>
              <Logo name="Typhoon Replay" glyph="嵐" size="sm" />
            </Link>
          }
          actions={
            <>
              <BackendSwitch />
              <ContrastToggle />
              <ThemeToggle variant="compact" />
              <LangSwitch />
            </>
          }
        >
          <Link to="/storms" className={nav}>
            {t`Storms`}
          </Link>
          <Link to="/compare" className={nav}>
            {t`Compare`}
          </Link>
          <Link to="/town" className={nav}>
            {t`My town`}
          </Link>
          <Link to="/about" className={nav}>
            {t`About`}
          </Link>
        </Header>
      }
      footer={
        <footer className="border-t border-border">
          <div className="mx-auto grid max-w-[1120px] gap-2 px-4 py-6 text-xs text-muted-foreground">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <DataAsOf />
              <ServedByFooter />
              <span>{formatBuildInfo(buildInfo)}</span>
            </div>
            <p>
              <Attribution />{" "}
              <Link to="/about" className="underline underline-offset-4">
                {t`Sources and licences`}
              </Link>
            </p>
          </div>
        </footer>
      }
    >
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:bg-background focus:p-2">
        {t`Skip to content`}
      </a>
      <div id="main" tabIndex={-1} className="outline-none">
        {children}
      </div>
    </AppShell>
  );
}
