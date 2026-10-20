import { Label, Switch, ToggleGroup, ToggleGroupItem } from "@abrycta/akari/react";
import { useLingui } from "@lingui/react/macro";

import type { FieldLayer } from "@/shared/lib/fields";
import type { SpeedUnit } from "@/shared/lib/units";

import { useFieldLabels } from "./labels";

export interface LayerPanelProps {
  layer: FieldLayer | "none";
  particles: boolean;
  track: boolean;
  units: SpeedUnit;
  tz: "local" | "utc";
  localZoneLabel: string;
  reducedMotion: boolean;
  hasFrames: boolean;
  onChange: (patch: Partial<{ layer: FieldLayer | "none"; particles: boolean; track: boolean; units: SpeedUnit; tz: "local" | "utc" }>) => void;
}

export function LayerPanel(p: LayerPanelProps) {
  const { t } = useLingui();
  const labels = useFieldLabels();
  return (
    <fieldset className="grid gap-3 rounded-sm border border-border p-3" data-testid="layer-panel">
      <legend className="px-1 font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">{t`Layers`}</legend>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        value={p.layer}
        onValueChange={(v) => v && p.onChange({ layer: v as FieldLayer | "none" })}
        aria-label={t`Field layer`}
        className="flex-wrap"
        disabled={!p.hasFrames}
      >
        {(["wind", "gust", "rain", "pressure"] as const).map((l) => (
          <ToggleGroupItem key={l} value={l} className="px-2.5 text-xs">
            {labels[l].short}
          </ToggleGroupItem>
        ))}
        <ToggleGroupItem value="none" className="px-2.5 text-xs">
          {t`Off`}
        </ToggleGroupItem>
      </ToggleGroup>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <div className="flex items-center gap-2">
          <Switch id="particles" checked={p.particles} onCheckedChange={(v) => p.onChange({ particles: v })} disabled={!p.hasFrames} />
          <Label htmlFor="particles">{t`Wind particles`}</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="track" checked={p.track} onCheckedChange={(v) => p.onChange({ track: v })} />
          <Label htmlFor="track">{t`Best track`}</Label>
        </div>
      </div>
      {p.reducedMotion && !p.particles ? <p className="text-xs text-muted-foreground">{t`Particles are off because your system asks for reduced motion. You can still turn them on.`}</p> : null}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={p.units} onValueChange={(v) => v && p.onChange({ units: v as SpeedUnit })} aria-label={t`Wind units`}>
          <ToggleGroupItem value="ms" className="px-2 text-xs">
            m/s
          </ToggleGroupItem>
          <ToggleGroupItem value="kt" className="px-2 text-xs">
            kt
          </ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={p.tz} onValueChange={(v) => v && p.onChange({ tz: v as "local" | "utc" })} aria-label={t`Time zone`}>
          <ToggleGroupItem value="local" className="px-2 text-xs">
            {p.localZoneLabel}
          </ToggleGroupItem>
          <ToggleGroupItem value="utc" className="px-2 text-xs">
            UTC
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </fieldset>
  );
}
