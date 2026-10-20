import { useLingui } from "@lingui/react/macro";

import type { FieldLayer } from "@/shared/lib/fields";

export function useFieldLabels(): Record<FieldLayer, { short: string; long: string }> {
  const { t } = useLingui();
  return {
    wind: { short: t`Wind`, long: t`10 m wind speed` },
    gust: { short: t`Gust`, long: t`10 m wind gust` },
    rain: { short: t`Rain`, long: t`Rainfall rate` },
    pressure: { short: t`Pressure`, long: t`Sea-level pressure` },
  };
}

export function useAgencyLabel() {
  const { t } = useLingui();
  return (agency: string) =>
    agency === "jtwc" ? t`JTWC (1-min mean)` : agency === "jma" ? t`JMA (10-min mean)` : agency.toUpperCase();
}
