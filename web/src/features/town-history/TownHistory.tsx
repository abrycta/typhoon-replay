import { Badge, Button, Empty, EmptyDescription, EmptyHeader, EmptyTitle, Input, Label, NativeSelect, NativeSelectOption, Skeleton, Spinner, useLang } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ApiError, type RadiusKm, usePlaceSearch, usePlaceStorms } from "@/api";
import { stormTitle } from "@/shared/lib/names";
import { formatDate } from "@/shared/lib/time";
import type { PlaceSummary } from "@/shared/model/types";

export interface TownUrl {
  q?: string;
  place?: string;
  radius: RadiusKm;
}

const RADII: RadiusKm[] = [50, 100, 200, 300, 500];

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const id = setTimeout(() => setD(v), ms);
    return () => clearTimeout(id);
  }, [v, ms]);
  return d;
}

function placeLabel(p: PlaceSummary, lang: "en" | "ja") {
  const name = lang === "ja" && p.nameJa ? p.nameJa : p.name;
  const region = lang === "ja" && p.admin1Ja ? p.admin1Ja : [p.admin2, p.admin1].filter(Boolean).join(", ");
  return `${name}, ${region}`;
}

function errorText(e: unknown, t: (s: TemplateStringsArray, ...v: unknown[]) => string): string {
  if (e instanceof ApiError) {
    if (e.code === "not-deployed") return t`This backend is not deployed at this address yet.`;
    if (e.status === 0) return t`The backend did not answer (network error).`;
    return `${e.message} (${e.status}${e.code ? `, ${e.code}` : ""})`;
  }
  return String(e);
}

/** "Typhoons that hit my town": place search and storm history from the selected API backend. */
export function TownHistory({ url, onUrl }: { url: TownUrl; onUrl: (p: Partial<TownUrl>) => void }) {
  const { t } = useLingui();
  const { lang } = useLang();
  const [text, setText] = useState(url.q ?? "");
  const q = useDebounced(text.trim(), 300);
  useEffect(() => {
    if (q !== (url.q ?? "")) onUrl({ q: q || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  const search = usePlaceSearch(q);
  const hits = usePlaceStorms(url.place, url.radius);
  const selected = search.data?.find((p) => p.id === url.place);

  return (
    <div className="grid gap-6">
      <form role="search" className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end" onSubmit={(e) => e.preventDefault()}>
        <div className="grid gap-1.5">
          <Label htmlFor="town-q">{t`City or municipality`}</Label>
          <Input id="town-q" type="search" autoComplete="off" placeholder={t`Tacloban, Naha, 那覇…`} value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="town-radius">{t`Within`}</Label>
          <NativeSelect id="town-radius" value={String(url.radius)} onChange={(e) => onUrl({ radius: Number(e.target.value) as RadiusKm })}>
            {RADII.map((r) => (
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
        <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {q.length < 2 ? t`Type at least two letters.` : search.isFetching ? <Spinner /> : search.error ? errorText(search.error, t) : t`${search.data?.length ?? 0} places found`}
        </div>
        {search.data?.length ? (
          <ul className="flex flex-wrap gap-2">
            {search.data.map((p) => (
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
          {hits.isPending ? (
            <Skeleton className="h-24" />
          ) : hits.error ? (
            <p className="text-sm text-destructive">{errorText(hits.error, t)}</p>
          ) : hits.data?.length ? (
            <ol className="grid gap-2" data-testid="town-hits">
              {hits.data.map((h) => (
                <li key={h.storm.sid} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-sm border border-border p-3">
                  <Link to="/storm/$sid" params={{ sid: h.storm.sid }} className="font-semibold underline-offset-4 hover:underline">
                    {stormTitle(h.storm, lang)} {h.storm.season}
                  </Link>
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {t`${h.closestApproachKm.toFixed(0)} km away on ${formatDate(h.closestApproachAt, lang)}`}
                    {h.maxWindKtWithinRadius !== undefined ? ` · ${t`${h.maxWindKtWithinRadius.toFixed(0)} kt max wind`}` : ""}
                    {` · ${t`${h.hoursWithinRadius} h within ${url.radius} km`}`}
                  </span>
                  {h.storm.landfallCountries.length ? <Badge variant="secondary">{h.storm.landfallCountries.join(" · ")}</Badge> : null}
                </li>
              ))}
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
