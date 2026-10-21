import { AppShell, Header, useLang } from "@abrycta/akari/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { createLink, useElementScrollRestoration, useLocation } from "@tanstack/react-router";
import { type ComponentProps, type ReactNode, useEffect } from "react";

import { Attribution, DataAsOf } from "@/features/dataset-info";
import { buildInfo, formatBuildInfo } from "@/shared/lib/build-info";
import { isLocale } from "@/shared/i18n/i18n";
import { AUTHOR, PORTFOLIO_HOST, PORTFOLIO_URL } from "@/shared/lib/site";

import { useHeaderCrumbs } from "./header-crumbs";
import { settleScroll } from "./scroll-settle";
import { useIsNotFound } from "./not-found-state";

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
 * (the brand link too) and adds an "active" class, so Akari's own resolution wins here: at most one nav item is current.
 */
const HeaderAnchor = createLink(({ current, ...props }: ComponentProps<"a"> & { current?: "page" | "true" | "location" }) => <a {...props} aria-current={current} />);

/** Footer links: no automatic aria-current from the router (the Header is the only nav that says "current page"). */
const FooterLink = createLink((props: ComponentProps<"a">) => <a {...props} aria-current={undefined} />);

/**
 * Back/Forward to a page whose content loads after it renders (a storm, a list), and links to its #sections: keep the
 * restored position (TanStack's entry for this history entry) or the section in place while the page fills in.
 * Keyed by path and hash: the storm page's own `?t=` updates (replace) must not restart it.
 */
function useScrollSettle() {
  const { pathname, hash } = useLocation({ select: (l) => ({ pathname: l.pathname, hash: l.hash }) });
  const entry = useElementScrollRestoration({ getElement: () => (typeof window === "undefined" ? undefined : window) });
  const y = entry?.scrollY;
  useEffect(() => settleScroll({ y, hash: y === undefined ? hash || undefined : undefined }), [pathname, hash]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function Shell({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  useGlobalParams();
  useScrollSettle();
  const pathname = useLocation({ select: (l) => l.pathname });
  const notFound = useIsNotFound();
  const crumbs = useHeaderCrumbs();
  return (
    <AppShell
      header={
        <Header
          brand={{ name: "Replay", glyph: "嵐", href: "/", srSuffix: t({ message: "home", context: "brand link suffix" }) }}
          navLabel={t`Main`}
          nav={[
            { href: "/", label: t`Home` },
            { href: "/storms", label: t`Storms`, also: ["/storm/"] },
            { href: "/compare", label: t`Compare` },
            { href: "/town", label: t`My town` },
            { href: "/under-the-hood", label: t`Tech` },
            { href: "/about", label: t`About` },
          ]}
          location={{ pathname: notFound ? "/404" : pathname }}
          portfolioLink
          languages
          breadcrumb={crumbs}
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
                  <FooterLink to="/under-the-hood" activeProps={{}} className="underline underline-offset-4 hover:text-foreground">
                    Tech
                  </FooterLink>
                </Trans>
              </span>
              <span>{formatBuildInfo(buildInfo)}</span>
            </div>
            <p>
              <Attribution />{" "}
              <FooterLink to="/about" activeProps={{}} className="underline underline-offset-4">
                {t`Sources and licences`}
              </FooterLink>
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
