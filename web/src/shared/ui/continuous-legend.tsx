import { cn } from "@abrycta/akari/react";
import type { ReactNode } from "react";

export interface ContinuousLegendProps {
  title: ReactNode;
  /** CSS gradient for the ramp (left = ramp position 0). */
  gradient: string;
  /** Tick labels at ramp positions 0..1. */
  ticks: { at: number; label: string }[];
  unit: string;
  note?: ReactNode;
  className?: string;
}

/**
 * Continuous colour ramp with positioned ticks and a unit. Local wrapper: Akari's MapLegend is stepped
 * only (5 swatches, evenly spaced labels); see the Akari gaps in the frontend README.
 */
export function ContinuousLegend({ title, gradient, ticks, unit, note, className }: ContinuousLegendProps) {
  return (
    <figure className={cn("m-0 grid gap-1.5", className)} data-slot="continuous-legend">
      <figcaption className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
        {title} <span className="normal-case">({unit})</span>
      </figcaption>
      <div className="h-3 rounded-sm border border-border" style={{ background: gradient }} aria-hidden="true" />
      <div className="relative h-4 font-mono text-[11px] text-muted-foreground tabular-nums" aria-hidden="true">
        {ticks.map((t) => (
          <span
            key={t.label}
            className="absolute -translate-x-1/2 first:translate-x-0 last:-translate-x-full"
            style={{ left: `${(t.at * 100).toFixed(2)}%` }}
          >
            {t.label}
          </span>
        ))}
      </div>
      <p className="sr-only">
        {ticks.map((t) => t.label).join(", ")} {unit}
      </p>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </figure>
  );
}
