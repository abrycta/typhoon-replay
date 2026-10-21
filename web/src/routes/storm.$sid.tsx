import {
  Badge,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Page,
  Skeleton,
  useLang,
} from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
import { ArrowLeftIcon, CheckIcon, LinkIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { NotFound } from "@/app/errors";
import { DataError, useStormDetail } from "@/data";
import { type ReplayUrlState, StormReplay } from "@/features/replay";
import { AffectedPlaces } from "@/features/storm-places";
import { landfallSummary } from "@/shared/lib/landfalls";
import { formatDate } from "@/shared/lib/time";
import { ktToMs } from "@/shared/lib/units";
import { stormLabel } from "@/shared/lib/names";
import { StormName } from "@/shared/ui/storm-name";
import { useStormName } from "@/shared/ui/use-storm-name";
import { useDocumentTitle } from "@/shared/ui/use-title";

import { replayDefaults, replaySearch } from "./-search";

export const Route = createFileRoute("/storm/$sid")({
  validateSearch: replaySearch,
  search: { middlewares: [stripSearchParams(replayDefaults)] },
  component: StormPage,
});

function ShareButton() {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(location.href).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
      data-testid="share-link"
    >
      {copied ? <CheckIcon /> : <LinkIcon />}
      {copied ? t`Link copied` : t`Copy link to this hour`}
    </Button>
  );
}

/** Home › Storms › <storm>, the last crumb being the current page. */
function StormBreadcrumb({ current }: { current: string }) {
  const { t } = useLingui();
  return (
    <Breadcrumb aria-label={t`Breadcrumb`} data-testid="breadcrumb">
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to="/" className="rounded-sm">
              {t`Home`}
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to="/storms" className="rounded-sm">
              {t`Storms`}
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{current}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function BackToStorms() {
  const { t } = useLingui();
  return (
    <Button asChild variant="outline" size="sm">
      <Link to="/storms" data-testid="back-to-storms">
        <ArrowLeftIcon aria-hidden="true" />
        {t`Back to all storms`}
      </Link>
    </Button>
  );
}

function StormPage() {
  const { t } = useLingui();
  const { lang } = useLang();
  const { sid } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const d = useStormDetail(sid);
  const stormName = useStormName();
  useDocumentTitle(d.data ? `${stormName(d.data)} ${d.data.season}` : undefined);
  const onUrl = useCallback(
    (patch: Partial<ReplayUrlState>) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true, resetScroll: false }),
    [navigate],
  );

  if (d.error instanceof DataError && d.error.status === 404) return <NotFound />;
  if (d.error) {
    return (
      <Page eyebrow={sid} title={t`This storm could not be loaded`} lede={d.error.message} data-testid="storm-error">
        <div className="flex flex-wrap gap-3">
          <Button size="sm" onClick={() => location.reload()}>
            {t`Try again`}
          </Button>
          <BackToStorms />
          <Button asChild variant="outline" size="sm">
            <Link to="/">{t`Go to the home page`}</Link>
          </Button>
        </div>
      </Page>
    );
  }
  if (!d.data || !d.dataset) {
    return (
      <div className="mx-auto grid max-w-[1120px] gap-4 px-4 py-10">
        <StormBreadcrumb current={sid} />
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="aspect-[16/10]" />
      </div>
    );
  }
  const s = d.data;
  const jtwc = s.intensity.find((i) => i.agency === "jtwc");
  const jma = s.intensity.find((i) => i.agency === "jma");
  const peak = [
    jtwc?.maxWindKt !== undefined ? t`${jtwc.maxWindKt.toFixed(0)} kt (${ktToMs(jtwc.maxWindKt).toFixed(0)} m/s) JTWC 1-min` : undefined,
    jma?.maxWindKt !== undefined ? t`${jma.maxWindKt.toFixed(0)} kt JMA 10-min` : undefined,
    jma?.minPressureHpa !== undefined ? `${jma.minPressureHpa.toFixed(0)} hPa` : undefined,
  ].filter(Boolean);

  return (
    <div className="mx-auto grid max-w-[1120px] gap-8 px-4 py-8 md:py-12">
      <StormBreadcrumb current={`${stormName(s)} ${s.season}`} />
      <header className="-mt-4 grid gap-2">
        <p className="font-mono text-xs tracking-[0.08em] text-muted-foreground uppercase">
          {t`Typhoon replay`} · {s.season} · {s.sid}
        </p>
        <h1 className="font-heading text-[clamp(28px,4vw,40px)] leading-tight font-semibold">
          <StormName s={s} />
        </h1>
        {s.localNames?.ja && stormLabel(s).kind !== "jma" ? (
          <p lang="ja" className="text-muted-foreground">
            {s.localNames.ja}
          </p>
        ) : null}
        <p className="max-w-[68ch] text-muted-foreground" data-testid="storm-lede">
          {formatDate(s.startedAt, lang)} – {formatDate(s.endedAt, lang)}
          {peak.length ? ` · ${t`peak`} ${peak.join(" · ")}` : ""}
          {s.landfalls.length
            ? ` · ${landfallSummary(s.landfalls, lang, {
                lead: (g, dates) =>
                  g.count > 1
                    ? g.country === "PH"
                      ? t`landfalls in the Philippines ${dates} (${g.count})`
                      : t`landfalls in Japan ${dates} (${g.count})`
                    : g.country === "PH"
                      ? t`landfall in the Philippines ${dates}`
                      : t`landfall in Japan ${dates}`,
                more: (g, dates) =>
                  (g.country === "PH" ? t`Philippines ${dates}` : t`Japan ${dates}`) + (g.count > 1 ? ` (${g.count})` : ""),
              })}`
            : ""}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {s.replayAvailable ? <Badge>{t`ERA5 field replay`}</Badge> : <Badge variant="outline">{t`Track only: field frames not published yet`}</Badge>}
          <ShareButton />
        </div>
      </header>

      <StormReplay detail={s} dataset={d.dataset} url={search} onUrl={onUrl} pageKeyboard />

      <div className="grid gap-8 md:grid-cols-2">
        <AffectedPlaces detail={s} />
        <section aria-labelledby="sources-h" className="grid content-start gap-2">
          <h2 id="sources-h" className="text-lg font-semibold">
            {t`Sources`}
          </h2>
          <ul className="grid gap-1 text-sm">
            {s.sources.map((src) => (
              <li key={src.id}>
                <a href={src.url} className="text-ak-text-link underline-offset-4 hover:underline" rel="noreferrer">
                  {src.name}
                </a>
                {src.license ? <span className="text-muted-foreground"> · {src.license}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div>
        <BackToStorms />
      </div>
    </div>
  );
}
