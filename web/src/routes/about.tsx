import { Page } from "@abrycta/akari/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { SourcesList } from "@/features/dataset-info";
import { useDocumentTitle } from "@/shared/ui/use-title";

export const Route = createFileRoute("/about")({ component: About });

function About() {
  const { t } = useLingui();
  useDocumentTitle(t`About`);
  return (
    <Page eyebrow={t`About`} title={t`About Replay`} lede={t`Where the data comes from, what it can and cannot tell you, and the licences that apply.`}>
      <div className="grid max-w-[68ch] gap-8">
        <section className="grid gap-2" aria-labelledby="h-data">
          <h2 id="h-data" className="text-xl font-semibold">
            {t`Data sources`}
          </h2>
          <SourcesList />
        </section>
        <section className="grid gap-2" aria-labelledby="h-honesty">
          <h2 id="h-honesty" className="text-xl font-semibold">
            {t`Reanalysis is context, not the storm's strength`}
          </h2>
          <p>
            <Trans>
              The wind, gust, rain and pressure fields come from ERA5 reanalysis, on a grid of about 28 km. Reanalysis smooths the eye wall of intense
              typhoons. At Haiyan's peak, the field's strongest 10 m wind was 0.31× the JTWC 1-minute best-track wind and 0.42× JMA's 10-minute wind.
              So every replay shows the best-track intensity beside the field, names the agency and its averaging period, and marks the hours
              interpolated between best-track fixes.
            </Trans>
          </p>
          <p>
            <Trans>
              JTWC winds are 1-minute means. JMA and PAGASA winds are 10-minute means, so the two sets of numbers cannot be compared directly. Every
              storm uses the same fixed colour scales, so storms from different decades can be compared.
            </Trans>
          </p>
        </section>
        <section className="grid gap-2" aria-labelledby="h-tech">
          <h2 id="h-tech" className="text-xl font-semibold">
            {t`How it works`}
          </h2>
          <p>
            <Trans>
              Replay is a static site. Frames, tracks and the storm index are files on a public dataset host; your browser decodes them in a web
              worker and draws them with WebGL. Place search ("hit my town") also runs in your browser, over a static place index. Separately, one API
              contract is built four times, in Java, Node, Rust and Go. The Tech page races the four builds, and no other page depends on them.
            </Trans>
          </p>
        </section>
        <section className="grid gap-2" aria-labelledby="h-lic">
          <h2 id="h-lic" className="text-xl font-semibold">
            {t`Licences`}
          </h2>
          <ul className="list-disc pl-5 text-sm">
            <li>{t`ERA5: Copernicus Climate Change Service, CC BY 4.0. Contains modified Copernicus Climate Change Service information.`}</li>
            <li>{t`IBTrACS v04r01: NOAA National Centers for Environmental Information, public domain.`}</li>
            <li>{t`PAGASA local names: compiled from Wikipedia, CC BY-SA 4.0.`}</li>
            <li>{t`Basemap: OpenFreeMap, © OpenStreetMap contributors (ODbL); fallback coastline from Natural Earth (public domain).`}</li>
            <li>{t`Map rendering: MapLibre GL JS (BSD-3-Clause). Particle technique after mapbox/webgl-wind (ISC).`}</li>
          </ul>
        </section>
      </div>
    </Page>
  );
}
