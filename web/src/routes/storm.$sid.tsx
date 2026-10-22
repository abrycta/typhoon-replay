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
} from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
import { ArrowLeftIcon, CheckIcon, LinkIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { NotFound } from "@/app/errors";
import { usePageCrumbs } from "@/app/header-crumbs";
import { DataError, useStormDetail, useStormTrack } from "@/data";
import { type ReplayUrlState, StormHeading, StormReplay } from "@/features/replay";
import { loadReplayMap } from "@/features/replay/map/load";
import { AffectedPlaces } from "@/features/storm-places";
import { stormLabel } from "@/shared/lib/names";
import { MapGlyph } from "@/shared/ui/map-glyph";
import { useStormName } from "@/shared/ui/use-storm-name";
import { useDocumentTitle } from "@/shared/ui/use-title";

import { replayDefaults, replaySearch } from "./-search";

export const Route = createFileRoute("/storm/$sid")({
  validateSearch: replaySearch,
  search: { middlewares: [stripSearchParams(replayDefaults)] },
  // The map chunk downloads beside the storm's summary, not after it.
  loader: () => void loadReplayMap(),
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
  // The Header strip shows the same trail once this one has scrolled away.
  usePageCrumbs([{ href: "/", label: t`Home` }, { href: "/storms", label: t`Storms` }, { label: current }]);
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
  const { sid } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const d = useStormDetail(sid);
  // The track needs only the sid: fetch it beside the summary (the replay reads it from the same query).
  useStormTrack(sid);
  const stormName = useStormName();
  // An unnamed storm's name already carries its start month and year ("Unnamed storm · Feb 1940"): no second year.
  const titled = (x: NonNullable<typeof d.data>) => (stormLabel(x).kind === "unnamed" && x.startedAt ? stormName(x) : `${stormName(x)} ${x.season}`);
  useDocumentTitle(d.data ? titled(d.data) : undefined);
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
        <MapGlyph className="aspect-[16/10] rounded-sm" />
      </div>
    );
  }
  const s = d.data;
  return (
    <div className="mx-auto grid max-w-[1120px] gap-8 px-4 py-8 md:py-12">
      <StormBreadcrumb current={titled(s)} />
      <StormHeading s={s}>
        <div className="flex flex-wrap items-center gap-2">
          {s.replayAvailable ? <Badge>{t`ERA5 field replay`}</Badge> : <Badge variant="outline">{t`Track only: field frames not published yet`}</Badge>}
          <ShareButton />
        </div>
      </StormHeading>

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
