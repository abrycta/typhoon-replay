import { Button, Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle, Input, Label, NativeSelect, NativeSelectOption, Skeleton } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { type CatalogFilter, decades, filterStorms, seasons, useStormIndex } from "@/data";
import type { Country } from "@/shared/model/types";

import { StormList } from "./StormList";

export interface StormBrowserProps {
  filter: CatalogFilter;
  onFilter: (f: CatalogFilter) => void;
}

/** Search and browse the static catalogue by name, decade, season and landfall country (no API). */
export function StormBrowser({ filter, onFilter }: StormBrowserProps) {
  const { t } = useLingui();
  const index = useStormIndex();
  const storms = useMemo(() => index.data ?? [], [index.data]);
  const results = useMemo(() => filterStorms(storms, filter), [storms, filter]);

  if (index.error) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t`The storm catalogue could not be loaded`}</EmptyTitle>
          <EmptyDescription>{String(index.error.message)}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row flex-wrap justify-center">
          <Button size="sm" onClick={() => location.reload()}>
            {t`Try again`}
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link to="/">{t`Go to the home page`}</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <div className="grid gap-6">
      <form role="search" className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end" onSubmit={(e) => e.preventDefault()}>
        <div className="grid gap-1.5">
          <Label htmlFor="storm-q">{t`Storm name or year`}</Label>
          <Input
            id="storm-q"
            type="search"
            placeholder={t`Haiyan, Yolanda, 台風第19号, 2019…`}
            value={filter.q ?? ""}
            onChange={(e) => onFilter({ ...filter, q: e.target.value || undefined })}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="storm-decade">{t`Decade`}</Label>
          <NativeSelect id="storm-decade" value={filter.decade ? String(filter.decade) : ""} onChange={(e) => onFilter({ ...filter, decade: e.target.value ? Number(e.target.value) : undefined })}>
            <NativeSelectOption value="">{t`All`}</NativeSelectOption>
            {decades(storms).map((d) => (
              <NativeSelectOption key={d} value={String(d)}>
                {t`${d}s`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="storm-season">{t`Season`}</Label>
          <NativeSelect id="storm-season" value={filter.season ? String(filter.season) : ""} onChange={(e) => onFilter({ ...filter, season: e.target.value ? Number(e.target.value) : undefined })}>
            <NativeSelectOption value="">{t`All`}</NativeSelectOption>
            {seasons(storms).map((y) => (
              <NativeSelectOption key={y} value={String(y)}>
                {y}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="storm-country">{t`Landfall`}</Label>
          <NativeSelect id="storm-country" value={filter.country ?? ""} onChange={(e) => onFilter({ ...filter, country: (e.target.value || undefined) as Country | undefined })}>
            <NativeSelectOption value="">{t`Any`}</NativeSelectOption>
            <NativeSelectOption value="PH">{t`Philippines`}</NativeSelectOption>
            <NativeSelectOption value="JP">{t`Japan`}</NativeSelectOption>
          </NativeSelect>
        </div>
      </form>
      <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
        {index.isPending ? t`Loading the catalogue…` : t`${results.length} of ${storms.length} storms`}
      </p>
      {index.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : results.length ? (
        <StormList storms={results} label={t`Storms`} />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t`No storms match`}</EmptyTitle>
            <EmptyDescription>{t`Try another name (international, PAGASA or Japanese) or clear a filter.`}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  );
}
