import { AppShell, Header, LangSwitch, Logo, ThemeToggle, useLang } from "@abrycta/akari/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useLocation } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { type ReactNode, useEffect } from "react";

import { selectBackend } from "@/api";
import { BackendSwitch, ServedByFooter } from "@/features/backend-switch";
import { Attribution, DataAsOf } from "@/features/dataset-info";
import { buildInfo, formatBuildInfo } from "@/shared/lib/build-info";
import { isLocale } from "@/shared/i18n/i18n";
import { AUTHOR, PORTFOLIO_HOST, PORTFOLIO_URL } from "@/shared/lib/site";
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

/** Back to the author's portfolio, in the same tab. The visible text is the host; screen readers also hear whose site it is. */
function PortfolioLink({ className }: { className?: string }) {
  const { t } = useLingui();
  return (
    <a href={PORTFOLIO_URL} className={className} data-testid="portfolio-link">
      <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
      {PORTFOLIO_HOST}
      <span className="sr-only"> ({t`${AUTHOR}'s portfolio`})</span>
    </a>
  );
}

const NAV_LINK = "rounded-sm px-1 py-0.5 whitespace-nowrap hover:text-foreground [&.active]:text-foreground [&.active]:underline underline-offset-4";
const PORTFOLIO_LINK = "items-center gap-1 rounded-sm px-1 py-0.5 text-xs whitespace-nowrap text-muted-foreground underline-offset-4 hover:text-foreground hover:underline";

export function Shell({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  useGlobalParams();
  // TanStack's <Link> sets aria-current="page" and the "active" class on the current section.
  const links = (
    <>
      <Link to="/" activeOptions={{ exact: true }} className={NAV_LINK} data-testid="nav-home">
        {t`Home`}
      </Link>
      <Link to="/storms" className={NAV_LINK}>
        {t`Storms`}
      </Link>
      <Link to="/compare" className={NAV_LINK}>
        {t`Compare`}
      </Link>
      <Link to="/town" className={NAV_LINK}>
        {t`My town`}
      </Link>
      <Link to="/about" className={NAV_LINK}>
        {t`About`}
      </Link>
    </>
  );
  return (
    <AppShell
      header={
        <>
          <Header
            brand={
              <>
                {/* Accessible name "Typhoon Replay home": the visible wordmark plus a screen-reader suffix (label-in-name). */}
                <Link to="/" activeOptions={{ exact: true }} className="rounded-sm" data-testid="brand-home">
                  <Logo name="Typhoon Replay" glyph="嵐" size="sm" />
                  <span className="sr-only"> {t({ message: "home", context: "brand link suffix" })}</span>
                </Link>
                {/* A labelled <nav> of our own (Akari's children slot renders an unlabelled one). Below md the row underneath takes over. */}
                <nav aria-label={t`Main`} className="hidden items-center gap-4 text-sm text-muted-foreground md:flex">
                  {links}
                </nav>
              </>
            }
            actions={
              <>
                <PortfolioLink className={`${PORTFOLIO_LINK} hidden md:inline-flex`} />
                <BackendSwitch />
                <ContrastToggle />
                <ThemeToggle variant="compact" />
                <LangSwitch />
              </>
            }
          />
          {/* Akari's header row does not wrap its nav, so on small screens the links get their own row. */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-2 md:hidden">
            <nav aria-label={t`Main`} className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {links}
            </nav>
            <PortfolioLink className={`${PORTFOLIO_LINK} inline-flex`} />
          </div>
        </>
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
            <p>
              <Trans>
                A project by{" "}
                <a href={PORTFOLIO_URL} className="underline underline-offset-4 hover:text-foreground" data-testid="footer-portfolio-link">
                  {AUTHOR} · {PORTFOLIO_HOST}
                </a>
              </Trans>
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
