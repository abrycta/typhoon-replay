import { Label, Page, ToggleGroup, ToggleGroupItem } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useCallback } from "react";

import { type CompareUrl, CompareView, type RenderReplay } from "@/features/compare";
import { StormReplay, useFieldLabels } from "@/features/replay";
import { useDocumentTitle } from "@/shared/ui/use-title";

import { compareSearch } from "./-search";

export const Route = createFileRoute("/compare")({
  validateSearch: compareSearch,
  search: { middlewares: [stripSearchParams({ layer: "wind", units: "ms" })] },
  component: ComparePage,
});

const renderReplay: RenderReplay = ({ detail, dataset, layer, units, syncIndex, onIndex }) => (
  <StormReplay
    detail={detail}
    dataset={dataset}
    url={{ layer, units, speed: 4, track: true, tz: "utc" }}
    onUrl={() => {}}
    compact
    showTable={false}
    syncIndex={syncIndex}
    onIndex={onIndex}
  />
);

function ComparePage() {
  const { t } = useLingui();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const labels = useFieldLabels();
  useDocumentTitle(t`Compare`);
  const onUrl = useCallback((p: Partial<CompareUrl>) => void navigate({ search: (prev) => ({ ...prev, ...p }), replace: true, resetScroll: false }), [navigate]);
  return (
    <Page eyebrow={t`Side by side`} title={t`Compare two storms`} lede={t`Same colour scale, same clock. The URL keeps both storms, the layer and the hour.`}>
      <div className="flex flex-wrap items-center gap-3">
        <Label id="cmp-layer">{t`Field`}</Label>
        <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={search.layer} onValueChange={(v) => v && onUrl({ layer: v as CompareUrl["layer"] })} aria-labelledby="cmp-layer">
          {(["wind", "gust", "rain", "pressure"] as const).map((l) => (
            <ToggleGroupItem key={l} value={l} className="px-2.5 text-xs">
              {labels[l].short}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <CompareView url={search} onUrl={onUrl} renderReplay={renderReplay} />
    </Page>
  );
}
