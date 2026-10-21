import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";

import type { StormDetail } from "@/shared/model/types";

/** What a storm's data lacks, in words (empty when nothing is missing). */
function useMissing() {
  const { t } = useLingui();
  return (d: StormDetail): string[] => {
    const out: string[] = [];
    const jtwc = d.intensity.find((i) => i.agency === "jtwc" && i.maxWindKt !== undefined);
    const jma = d.intensity.find((i) => i.agency === "jma" && (i.maxWindKt !== undefined || i.minPressureHpa !== undefined));
    if (!jtwc && !jma) out.push(t`no best-track wind`);
    else if (!jtwc) out.push(t`no JTWC wind (JMA's 10-minute wind is shown)`);
    if (!jma) out.push(d.season < 1951 ? t`no JMA data (JMA's best track starts in 1951)` : t`no JMA data`);
    if (!d.intensity.some((i) => i.minPressureHpa !== undefined)) out.push(t`no central pressure`);
    if (!d.frames) out.push(t`no ERA5 field replay (track only)`);
    return out;
  };
}

/** The data notes: one line under the maps, the rest in a collapsible panel. */
export function AboutComparison({ storms }: { storms: { name: string; detail: StormDetail }[] }) {
  const { t } = useLingui();
  const missing = useMissing();
  const both = storms.find(({ detail }) => detail.intensity.some((i) => i.agency === "jtwc" && i.maxWindKt) && detail.intensity.some((i) => i.agency === "jma" && i.maxWindKt));
  const example = both
    ? (() => {
        const name = both.name;
        const j = both.detail.intensity.find((i) => i.agency === "jtwc")!.maxWindKt;
        const m = both.detail.intensity.find((i) => i.agency === "jma")!.maxWindKt;
        return t`${name}: ${j} kt JTWC, ${m} kt JMA`;
      })()
    : undefined;
  const old = storms.some(({ detail }) => detail.season < 1970);
  return (
    <Collapsible className="grid max-w-[90ch] gap-2 text-sm" data-testid="about-comparison">
      <p className="text-muted-foreground">
        {t`Intensity on the cards and the timeline is the IBTrACS best track; the maps are ERA5 reanalysis, hourly, on a grid of about 28 km.`}{" "}
        <CollapsibleTrigger asChild>
          <Button variant="link" size="sm" className="h-auto p-0 align-baseline [&[data-state=open]>svg]:rotate-180">
            {t`About this comparison`}
            <ChevronDownIcon aria-hidden="true" />
          </Button>
        </CollapsibleTrigger>
      </p>
      <CollapsibleContent>
        <ul className="grid list-disc gap-1.5 pl-5 text-muted-foreground">
          <li>
            {t`Best-track wind is JTWC's 1-minute mean when JTWC reported one, else JMA's 10-minute mean, which reads lower.`}
            {example ? ` (${example})` : ""} {t`Pressure is the lowest central pressure in hPa.`}
          </li>
          <li>{t`The maps show ERA5 wind, gust, rain (mm/h) and sea-level pressure (hPa). Reanalysis smooths the eye wall, so its winds are well below the best track: use it for size and timing, not peak strength.`}</li>
          <li>{t`Time steps: best-track fixes are 3- or 6-hourly and the hours between are interpolated; ERA5 frames are hourly. Wind is in knots (kt) here; 1 kt = 0.514 m/s.`}</li>
          <li>{t`Lining up: 0 h is the moment you choose for both storms (first track point, peak wind or first landfall). The timeline runs from the earliest start to the latest end, so outside its own life a storm shows "not yet formed" or "ended".`}</li>
          <li className={old ? "font-medium text-foreground" : undefined}>
            {t`Before weather satellites (the 1960s), tracks come from ships, land stations and aircraft, so positions and winds are rougher and weak storms may be missing.`}
          </li>
          {storms.map(({ name, detail }) => {
            const m = missing(detail);
            const list = m.join("; ");
            return <li key={detail.sid}>{m.length ? t`${name}: ${list}.` : t`${name}: all fields present.`}</li>;
          })}
          <li>
            {t`Sources:`}{" "}
            <a className="underline underline-offset-2" href="https://www.ncei.noaa.gov/products/international-best-track-archive" target="_blank" rel="noreferrer">
              {t`IBTrACS v04r01 (NOAA NCEI)`}
            </a>
            {", "}
            <a className="underline underline-offset-2" href="https://doi.org/10.24381/cds.adbb2d47" target="_blank" rel="noreferrer">
              {t`ERA5 (Copernicus Climate Change Service, CC BY 4.0)`}
            </a>
            {". "}
            <Link to="/about" className="underline underline-offset-2">
              {t`More about the data`}
            </Link>
          </li>
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
