// The storm page krtmtthw.dev frames: the real storm-page parts (title block, replay map, intensity panel) stepping
// through the storm's richest moments (./moments.tsx), each captioned, without the Header, the footer or anything below
// the replay. Nothing leaves this origin.
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";

import type { ResolvedDataset } from "@/data";
import { type FrozenReplay, type ReplayUrlState, StormHeading, StormReplay } from "@/features/replay";
import { localZone } from "@/features/replay/url";
import { useStormName } from "@/shared/ui/use-storm-name";

import { bakedBasemap } from "./basemap";
import { EMBED } from "./haiyan.generated";
import { useCompact } from "./layout";
import { embedPixelRatio } from "./link";
import { MomentCaption } from "./MomentCaption";
import { MOMENTS, useFactText, useMomentBeat } from "./moments";
import type { EmbedData } from "./pack";
import { postReady } from "./parent-bridge";

export function EmbedReplay({ data, dataset }: { data: EmbedData; dataset: ResolvedDataset }) {
  const { t } = useLingui();
  const stormName = useStormName();
  const s = data.detail;
  // The panels stay usable (layer, units, time zone); the view is fixed and the hour is the moment's.
  const beat = useMomentBeat();
  const moment = MOMENTS[beat.moment]!;
  const [state, setUrl] = useState<ReplayUrlState>({
    v: `${EMBED.view.lon},${EMBED.view.lat},${EMBED.view.zoom}`,
    layer: "wind",
    speed: 4,
    track: true,
    units: "ms",
    tz: "local",
  });
  const url: ReplayUrlState = { ...state, t: moment.t };
  const tz = url.tz === "utc" ? "UTC" : localZone(s);
  const factText = useFactText(url.units, tz);
  const lead = factText(moment.facts[beat.fact] ?? moment.facts[0]!, moment.t);
  const compact = useCompact();
  const frozen = useMemo<FrozenReplay>(
    () => ({
      store: data.store,
      basemap: bakedBasemap,
      pixelRatio: embedPixelRatio(),
      onRendered: () => postReady("replay"),
      // The baked basemap covers exactly the desktop map's view (EMBED.mapSize): smaller maps zoom out to keep it.
      compact: compact ? { viewFrame: EMBED.mapSize, lead } : undefined,
    }),
    [data.store, compact, lead],
  );
  const onUrl = (p: Partial<ReplayUrlState>) => setUrl((u) => ({ ...u, ...p, t: u.t, v: u.v }));

  // Phones and tablets (src/embed/layout.ts): the map over a three-line caption (the moment's fact, the storm and the
  // hour, the intensities), edge to edge.
  if (compact)
    return (
      <div className="h-dvh" data-testid="embed-replay" data-layout="compact" data-moment={beat.moment}>
        <StormReplay
          detail={s}
          dataset={dataset}
          url={url}
          onUrl={onUrl}
          frozen={frozen}
          compact
          showTable={false}
          mapClassName="relative h-[calc(100dvh-68px)] w-full overflow-hidden"
        />
      </div>
    );

  return (
    <>
      <div className="mx-auto grid max-w-[1120px] gap-8 px-4 pt-2 pb-8 md:pt-6 md:pb-12" data-testid="embed-replay" data-moment={beat.moment}>
        <div inert>
          <Breadcrumb aria-label={t`Breadcrumb`}>
            <BreadcrumbList>
              <BreadcrumbItem>
                <span>{t`Home`}</span>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <span>{t`Storms`}</span>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{`${stormName(s)} ${s.season}`}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
        <StormHeading s={s}>
          <MomentCaption moment={beat.moment} units={url.units} tz={tz} />
        </StormHeading>
        <StormReplay detail={s} dataset={dataset} url={url} onUrl={onUrl} frozen={frozen} />
      </div>
    </>
  );
}
