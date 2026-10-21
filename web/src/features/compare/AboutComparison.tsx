import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";

import type { StormDetail } from "@/shared/model/types";

import type { Alignment } from "./align";
import { agencyWinds, type Gap, gapsOf } from "./data-notes";

function useGapText() {
  const { t } = useLingui();
  return (g: Gap) =>
    g === "no-wind"
      ? t`no wind estimate`
      : g === "no-jtwc"
        ? t`no JTWC wind`
        : g === "no-jma"
          ? t`no JMA data`
          : g === "no-pressure"
            ? t`no pressure`
            : t`no ERA5 maps`;
}

const linkCls = "text-ak-text-link underline underline-offset-2";

/** Under the data cards: what the maps show, how to read the line-up, and what this pair's data lacks. */
export function AboutComparison({ storms, alignment }: { storms: { name: string; detail: StormDetail; landfallPlace?: string }[]; alignment: Alignment }) {
  const { t } = useLingui();
  const gapText = useGapText();
  const gaps = storms.map((s) => ({ name: s.name, gaps: gapsOf(s.detail) })).filter((s) => s.gaps.length);
  const both = storms.find((s) => ["jtwc", "jma"].every((a) => agencyWinds(s.detail).some((w) => w.agency === a)));
  const example = both
    ? (() => {
        const w = agencyWinds(both.detail);
        const name = both.name;
        const j = w.find((x) => x.agency === "jtwc")!.kt;
        const m = w.find((x) => x.agency === "jma")!.kt;
        return t`${name}: ${j} kt JTWC, ${m} kt JMA`;
      })()
    : undefined;
  const old = storms.some((s) => s.detail.season < 1966);
  const [a, b] = storms;
  const lineUp =
    alignment === "landfall" && a?.landfallPlace && b?.landfallPlace && b
      ? (() => {
          const [na, pa, nb, pb] = [a.name, a.landfallPlace, b.name, b.landfallPlace];
          return t`hour 0 is ${na} at ${pa} and ${nb} at ${pb}.`;
        })()
      : alignment === "landfall"
        ? t`hour 0 is each storm's first landfall.`
        : alignment === "peak"
          ? t`hour 0 is each storm at its strongest best-track wind.`
          : t`hour 0 is each storm's first track point.`;
  const lineUpHead = alignment === "landfall" ? t`Lined up at first landfall:` : alignment === "peak" ? t`Lined up at peak wind:` : t`Lined up at formation:`;

  return (
    <section aria-labelledby="about-cmp-h" className="grid gap-3.5 rounded-md border border-border bg-card px-4 py-4 text-card-foreground sm:px-6 sm:py-5" data-testid="about-comparison">
      <h2 id="about-cmp-h" className="font-heading text-xl font-semibold">
        {t`About this comparison`}
      </h2>
      <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
        <div className="grid content-start gap-2">
          <h3 className="font-mono text-xs uppercase tracking-wider text-muted-foreground">{t`What you're seeing`}</h3>
          <p className="text-sm leading-relaxed">
            <b className="font-semibold">{t`The line:`}</b> {t`each storm's official best track (IBTrACS), with dots at the observed fixes and the hours between interpolated.`}
          </p>
          <p className="text-sm leading-relaxed">
            <b className="font-semibold">{t`The colours:`}</b>{" "}
            {t`ERA5 reanalysis, a global weather model's hourly rebuild of wind, gust, rain and sea-level pressure on a grid of about 28 km. It can place a storm tens of km off the track and smooths the eye wall, so use it for size and timing, not peak strength. Both maps use the same colour scale.`}
          </p>
        </div>
        <div className="grid content-start gap-2">
          <h3 className="font-mono text-xs uppercase tracking-wider text-muted-foreground">{t`How to read it`}</h3>
          <p className="text-sm leading-relaxed">
            <b className="font-semibold">{lineUpHead}</b> {lineUp} {t`Outside its own life a storm shows "not yet formed" or "ended".`}
          </p>
          <p className="text-sm leading-relaxed">
            <b className="font-semibold">{t`Wind speeds depend on the agency.`}</b>{" "}
            {example ? t`JTWC averages over 1 minute; JMA over 10 minutes, which reads lower (${example}).` : t`JTWC averages over 1 minute; JMA over 10 minutes, which reads lower.`}{" "}
            {t`The cards and the timeline use JTWC when it reported, else JMA. 1 kt = 0.514 m/s.`}
          </p>
          {old ? (
            <p className="text-sm leading-relaxed">
              <b className="font-semibold">{t`Older storms are rougher.`}</b>{" "}
              {t`Before weather satellites (the 1960s), positions and winds come from ships, land stations and aircraft, so tracks are sparser and weak storms may be missing.`}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[13px]" data-testid="pair-gaps">
        <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">{t`Gaps for this pair`}</span>
        {gaps.length ? (
          gaps.map((s) => {
            const name = s.name;
            const list = s.gaps.map(gapText).join(", ");
            return (
              <span key={name} className="rounded-full border border-border bg-muted px-2.5 py-1 text-foreground" data-testid="gap-chip">
                {t`${name}: ${list}`}
              </span>
            );
          })
        ) : (
          <span className="rounded-full border border-border bg-muted px-2.5 py-1 text-foreground" data-testid="gap-chip">
            {t`None: both have pressure, JTWC and JMA winds and ERA5 maps`}
          </span>
        )}
      </div>
      <p className="text-[13px] text-muted-foreground">
        {t`Sources:`}{" "}
        <a className={linkCls} href="https://www.ncei.noaa.gov/products/international-best-track-archive" target="_blank" rel="noreferrer">
          {t`IBTrACS v04r01 (NOAA National Centers for Environmental Information)`}
        </a>
        {" · "}
        <a className={linkCls} href="https://doi.org/10.24381/cds.adbb2d47" target="_blank" rel="noreferrer">
          {t`ERA5 (Copernicus Climate Change Service, CC BY 4.0)`}
        </a>
        {" · "}
        <Link to="/about" className={linkCls}>
          {t`More about the data`}
        </Link>
      </p>
    </section>
  );
}
