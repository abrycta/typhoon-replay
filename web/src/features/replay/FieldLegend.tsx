import { useLingui } from "@lingui/react/macro";

import { FIELDS, type FieldLayer, legendGradient, rampPosition } from "@/shared/lib/fields";
import { msToKt, type SpeedUnit } from "@/shared/lib/units";
import { ContinuousLegend } from "@/shared/ui/continuous-legend";

import { useFieldLabels } from "./labels";

export function FieldLegend({ layer, units, theme }: { layer: FieldLayer; units: SpeedUnit; theme: "light" | "dark" }) {
  const { t } = useLingui();
  const spec = FIELDS[layer];
  const labels = useFieldLabels();
  const kt = spec.speed && units === "kt";
  const unit = kt ? "kt" : spec.units;
  const ticks = spec.ticks
    .map((v) => ({ at: rampPosition(spec, v), label: String(Math.round(kt ? msToKt(v) : v)) }))
    .sort((a, b) => a.at - b.at);
  const gradient = legendGradient(theme); // ticks sit at ramp positions, so one gradient fits every norm
  return (
    <ContinuousLegend
      title={labels[layer].long}
      unit={unit}
      gradient={gradient}
      ticks={ticks}
      note={t`ERA5 reanalysis, about 28 km grid. Same scale for every storm.`}
    />
  );
}
