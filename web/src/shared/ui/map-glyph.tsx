import { cn } from "@abrycta/akari/react";

/**
 * The pre-load still of a map slot (Kurt, 2026-10-23): Replay's kanji glyph on the muted surface, the same quiet tile
 * as krtmtthw.dev's embed slots, until the map has drawn its first full frame with data. Never an empty map frame.
 * It fills the slot it is given (`absolute inset-0`, or the slot's own aspect box), so nothing shifts.
 */
export function MapGlyph({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      lang="ja"
      data-testid="map-glyph"
      className={cn("pointer-events-none grid place-items-center bg-muted font-heading text-[clamp(40px,7vw,64px)] leading-none font-bold whitespace-nowrap text-muted-foreground", className)}
    >
      {__NAME_JA__}
    </div>
  );
}
