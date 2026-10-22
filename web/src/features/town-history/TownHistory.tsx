import { Badge, Button, Empty, EmptyDescription, EmptyHeader, EmptyTitle, Input, Label, NativeSelect, NativeSelectOption, Skeleton, useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { EXPOSURE_RADII, type ExposureRadiusKm, exposureWithin, type PlaceEntry, usePlaceSearch, usePlaceShard, useStormIndex } from "@/data";
import { formatDate } from "@/shared/lib/time";
import type { StormSummary } from "@/shared/model/types";
import { GlyphLoading } from "@/shared/ui/glyph-loading";
import { useStormName } from "@/shared/ui/use-storm-name";

export interface TownUrl {
  q?: string;
  place?: string;
  radius: ExposureRadiusKm;
}

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const id = setTimeout(() => setD(v), ms);
    return () => clearTimeout(id);
  }, [v, ms]);
  return d;
}

function placeLabel(p: PlaceEntry, lang: "en" | "ja") {
  const name = lang === "ja" && p.nameJa ? p.nameJa : p.name;
  const region = lang === "ja" && p.admin1Ja ? p.admin1Ja : [p.admin2, p.admin1].filter(Boolean).join(", ");
  return region ? `${name}, ${region}` : name;
}

/**
 * "Typhoons that hit my town", entirely from static files: the place index is searched in the browser and the
 * chosen place's exposure comes from its province/prefecture shard. No API call, so it works with every backend asleep.
 */
export function TownHistory({ url, onUrl }: { url: TownUrl; onUrl: (p: Partial<TownUrl>) => void }) {
  const { t } = useLingui();
  const { lang } = useLang();
  const stormName = useStormName();
  const [text, setText] = useState(url.q ?? "");
  const q = text.trim();
  const debounced = useDebounced(q, 300);
  useEffect(() => {
    if (debounced !== (url.q ?? "")) onUrl({ q: debounced || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const index = usePlaceSearch(q, url.place);
  const { results, selected } = index;
  const shard = usePlaceShard(selected?.shard);
  const storms = useStormIndex();
  const bySid = useMemo(() => new Map((storms.data ?? []).map((s) => [s.sid, s])), [storms.data]);
  const hits = useMemo(() => (shard.data && url.place ? exposureWithin(shard.data, url.place, url.radius) : undefined), [shard.data, url.place, url.radius]);

  const status =
    q.length < 2
      ? t`Type at least two letters.`
      : index.isPending
        ? t`Loading the place list…`
        : index.error
          ? t`The place list could not be loaded.`
          : t`${results.length} places found`;

  return (
    <div className="grid gap-6">
      <form role="search" className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end" onSubmit={(e) => e.preventDefault()}>
        <div className="grid gap-1.5">
          <Label htmlFor="town-q">{t`City or municipality`}</Label>
          <Input id="town-q" type="search" autoComplete="off" placeholder={t`Tacloban, Naha, 那覇…`} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="town-radius">{t`Within`}</Label>
          <NativeSelect id="town-radius" value={String(url.radius)} onChange={(e) => onUrl({ radius: Number(e.target.value) as ExposureRadiusKm })}>
            {EXPOSURE_RADII.map((r) => (
              <NativeSelectOption key={r} value={String(r)}>
                {r} km
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </form>

      <section aria-labelledby="places-h" className="grid gap-2">
        <h2 id="places-h" className="text-sm font-semibold">
          {t`Places`}
        </h2>
        <div role="status" aria-live="polite" className="text-sm text-muted-foreground" data-testid="town-status">
          {q.length >= 2 && index.isPending ? <GlyphLoading className="mr-2 align-[-0.15em]" /> : null}
          {status}
        </div>
        {results.length ? (
          <ul className="flex flex-wrap gap-2">
            {results.map((p) => (
              <li key={p.id}>
                <Button size="sm" variant={p.id === url.place ? "default" : "outline"} aria-pressed={p.id === url.place} onClick={() => onUrl({ place: p.id })}>
                  {placeLabel(p, lang)}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {url.place ? (
        <section aria-labelledby="hits-h" className="grid gap-3">
          <h2 id="hits-h" className="text-lg font-semibold">
            {selected ? t`Storms within ${url.radius} km of ${placeLabel(selected, lang)}` : t`Storms within ${url.radius} km`}
          </h2>
          <p className="text-xs text-muted-foreground">{t`Closest approach of the best-track centre. Wind values are best-track (agency winds), not the ERA5 field.`}</p>
          {index.isPending || shard.isLoading ? (
            <Skeleton className="h-24" />
          ) : !selected ? (
            <p className="text-sm text-muted-foreground">{t`This place is not in the dataset.`}</p>
          ) : shard.error ? (
            <p className="text-sm text-destructive">{t`The storm list for this place could not be loaded.`}</p>
          ) : hits?.length ? (
            <ol className="grid gap-2" data-testid="town-hits">
              {hits.map((h) => {
                const s: Pick<StormSummary, "sid" | "name" | "localNames" | "season" | "landfallCountries" | "startedAt" | "designation"> = bySid.get(h.sid) ?? {
                  sid: h.sid,
                  name: h.name ?? "",
                  startedAt: "",
                  season: h.season ?? Number(h.sid.slice(0, 4)),
                  landfallCountries: [],
                };
                return (
                  <li key={h.sid} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-sm border border-border p-3">
                    <Link to="/storm/$sid" params={{ sid: h.sid }} className="font-semibold underline-offset-4 hover:underline">
                      {stormName(s)} {s.season}
                    </Link>
                    <span className="text-sm tabular-nums text-muted-foreground">
                      {t`${h.closestApproachKm.toFixed(0)} km away on ${formatDate(h.closestApproachAt, lang)}`}
                      {h.maxWindKtWithinRadius !== undefined ? ` · ${t`${h.maxWindKtWithinRadius.toFixed(0)} kt max wind`}` : ""}
                      {` · ${t`${h.hoursWithinRadius} h within ${url.radius} km`}`}
                    </span>
                    {s.landfallCountries.length ? <Badge variant="secondary">{s.landfallCountries.join(" · ")}</Badge> : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t`No storms in the archive passed this close`}</EmptyTitle>
                <EmptyDescription>{t`Try a larger radius.`}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </section>
      ) : null}
    </div>
  );
}
