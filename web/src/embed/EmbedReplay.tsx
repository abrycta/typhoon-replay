// The frozen storm page krtmtthw.dev frames: the real storm-page parts (title block, replay map, intensity panel)
// for one hour, without the Header, the footer or anything below the replay. Nothing leaves this origin.
import {
  Badge,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
} from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { LinkIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type { ResolvedDataset } from "@/data";
import { type FrozenReplay, type ReplayUrlState, StormHeading, StormReplay } from "@/features/replay";
import { useStormName } from "@/shared/ui/use-storm-name";

import { bakedBasemap } from "./basemap";
import { EMBED } from "./haiyan.generated";
import { embedPixelRatio } from "./link";
import type { EmbedData } from "./pack";
import { postReady } from "./parent-bridge";

export function EmbedReplay({ data, dataset }: { data: EmbedData; dataset: ResolvedDataset }) {
  const { t } = useLingui();
  const stormName = useStormName();
  const s = data.detail;
  // The panels stay usable (layer, units, time zone); the hour and the view are fixed.
  const [url, setUrl] = useState<ReplayUrlState>({
    t: EMBED.t,
    v: `${EMBED.view.lon},${EMBED.view.lat},${EMBED.view.zoom}`,
    layer: "wind",
    speed: 4,
    track: true,
    units: "ms",
    tz: "local",
  });
  const frozen = useMemo<FrozenReplay>(
    () => ({ store: data.store, basemap: bakedBasemap, pixelRatio: embedPixelRatio(), onRendered: () => postReady("replay") }),
    [data.store],
  );

  return (
    <>
      <div className="mx-auto grid max-w-[1120px] gap-8 px-4 py-8 md:py-12" data-testid="embed-replay">
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
          <div className="flex flex-wrap items-center gap-2" inert>
            <Badge>{t`ERA5 field replay`}</Badge>
            <Button variant="outline" size="sm" tabIndex={-1} aria-hidden="true">
              <LinkIcon />
              {t`Copy link to this hour`}
            </Button>
          </div>
        </StormHeading>
        <StormReplay detail={s} dataset={dataset} url={url} onUrl={(p) => setUrl((u) => ({ ...u, ...p, t: u.t, v: u.v }))} frozen={frozen} />
      </div>
    </>
  );
}
