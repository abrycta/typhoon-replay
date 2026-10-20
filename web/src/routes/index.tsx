import { Button, Input, Label, Skeleton, useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { decades, sortStorms, useStormDetail, useStormIndex } from "@/data";
import { StormReplay } from "@/features/replay";
import { StormList } from "@/features/storm-search";
import { stormTitle } from "@/shared/lib/names";
import { useDocumentTitle } from "@/shared/ui/use-title";

const FEATURED_SID = "2013306N07162"; // Haiyan / Yolanda

export const Route = createFileRoute("/")({ component: Home });

function Featured() {
  const { t } = useLingui();
  const { lang } = useLang();
  const d = useStormDetail(FEATURED_SID);
  if (!d.data || !d.dataset) return <Skeleton className="aspect-[4/3] w-full sm:aspect-[16/10]" />;
  return (
    <figure className="m-0 grid gap-2" aria-label={t`Featured replay`}>
      <StormReplay
        detail={d.data}
        dataset={d.dataset}
        url={{ layer: "wind", speed: 8, track: true, units: "ms", tz: "local" }}
        onUrl={() => {}}
        compact
        autoplay
        loop
      />
      <figcaption className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>{t`${stormTitle(d.data, lang)}, ${d.data.season}: ERA5 10 m wind (reanalysis context) and the best track.`}</span>
        <Button asChild size="sm">
          <Link to="/storm/$sid" params={{ sid: FEATURED_SID }}>
            {t`Open the full replay`}
          </Link>
        </Button>
      </figcaption>
    </figure>
  );
}

function Home() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const index = useStormIndex();
  const [q, setQ] = useState("");
  useDocumentTitle(undefined);
  const storms = index.data ?? [];
  return (
    <div className="mx-auto grid max-w-[1120px] gap-12 px-4 py-10 md:py-14">
      <section className="grid items-start gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="grid gap-5">
          <p className="font-mono text-xs tracking-[0.08em] text-muted-foreground uppercase">{t`Philippines · Japan · since 1940`}</p>
          <h1 className="font-heading text-[clamp(32px,5vw,52px)] leading-[1.1] font-semibold text-balance">{t`Replay any typhoon, hour by hour`}</h1>
          <p className="text-muted-foreground">
            {t`Wind, gusts, rain and pressure from ERA5 reanalysis, with the official best track beside them. Search a storm, compare two, or see which typhoons passed your town.`}
          </p>
          <form
            role="search"
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void navigate({ to: "/storms", search: { q: q || undefined } });
            }}
          >
            <Label htmlFor="home-q">{t`Find a storm`}</Label>
            <div className="flex gap-2">
              <Input id="home-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t`Haiyan, Yolanda, Hagibis, 2019…`} />
              <Button type="submit">{t`Search`}</Button>
            </div>
          </form>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/town">{t`Typhoons that hit my town`}</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to="/compare" search={{ a: "2013306N07162", b: "2021346N05145" }}>
                {t`Compare Haiyan and Rai`}
              </Link>
            </Button>
          </div>
        </div>
        <Featured />
      </section>

      <section aria-labelledby="browse-h" className="grid gap-4">
        <h2 id="browse-h" className="font-heading text-2xl font-semibold">
          {t`Browse`}
        </h2>
        <nav aria-label={t`Browse by decade and country`} className="flex flex-wrap gap-2">
          {decades(storms).map((d) => (
            <Button key={d} asChild variant="outline" size="sm">
              <Link to="/storms" search={{ decade: d }}>
                {t`${d}s`}
              </Link>
            </Button>
          ))}
          <Button asChild variant="outline" size="sm">
            <Link to="/storms" search={{ country: "PH" }}>
              {t`Landfall in the Philippines`}
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/storms" search={{ country: "JP" }}>
              {t`Landfall in Japan`}
            </Link>
          </Button>
        </nav>
        {index.isPending ? <Skeleton className="h-40" /> : <StormList storms={sortStorms(storms, "newest").slice(0, 6)} label={t`Recent storms`} />}
        <p>
          <Link to="/storms" className="text-primary underline underline-offset-4">
            {t`All ${storms.length} storms`}
          </Link>
        </p>
      </section>
    </div>
  );
}
