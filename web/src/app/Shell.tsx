import { AppShell, Header, useLang } from "@abrycta/akari/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { createLink, Link, useLocation } from "@tanstack/react-router";
import { type ComponentProps, type ReactNode, useEffect } from "react";

import { Attribution, DataAsOf } from "@/features/dataset-info";
import { buildInfo, formatBuildInfo } from "@/shared/lib/build-info";
import { isLocale } from "@/shared/i18n/i18n";
import { AUTHOR, PORTFOLIO_HOST, PORTFOLIO_URL } from "@/shared/lib/site";

/** `?lang=` works on any page (share links). */
function useGlobalParams() {
  const search = useLocation({ select: (l) => l.search as Record<string, unknown> });
  const { setLang } = useLang();
  useEffect(() => {
    if (isLocale(search.lang)) setLang(search.lang);
  }, [search.lang, setLang]);
}

/**
 * The anchor behind Akari's Header links: TanStack's <Link> marks every matching link aria-current="page"
 * (the brand link too) and adds an "active" class, so the Header's own `current` flag wins here: exactly one nav item is current.
 */
const HeaderAnchor = createLink(({ current, ...props }: ComponentProps<"a"> & { current?: "page" }) => <a {...props} aria-current={current} />);

export function Shell({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  useGlobalParams();
  const path = useLocation({ select: (l) => l.pathname });
  return (
    <AppShell
      header={
        <Header
          brand={{ name: "Replay", glyph: "嵐", href: "/", srSuffix: t({ message: "home", context: "brand link suffix" }) }}
          navLabel={t`Main`}
          nav={[
            { href: "/", label: t`Home`, current: path === "/" },
            { href: "/storms", label: t`Storms`, current: path.startsWith("/storms") || path.startsWith("/storm/") },
            { href: "/compare", label: t`Compare`, current: path.startsWith("/compare") },
            { href: "/town", label: t`My town`, current: path.startsWith("/town") },
            { href: "/about", label: t`About`, current: path.startsWith("/about") },
            { href: "/under-the-hood", label: t`Under the hood`, current: path.startsWith("/under-the-hood") },
          ]}
          portfolioLink
          languages
          renderLink={({ href, "aria-current": current, ...p }) => <HeaderAnchor to={href} activeProps={{}} current={current} {...p} />}
        />
      }
      footer={
        <footer className="border-t border-border">
          <div className="mx-auto grid max-w-[1120px] gap-2 px-4 py-6 text-xs text-muted-foreground">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <DataAsOf />
              <span data-testid="footer-hook">
                <Trans>
                  Data served statically · API in four languages →{" "}
                  <Link to="/under-the-hood" className="underline underline-offset-4 hover:text-foreground">
                    Under the hood
                  </Link>
                </Trans>
              </span>
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
