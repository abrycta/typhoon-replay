import { cn } from "@abrycta/akari/react";

/**
 * An inline loading mark (CLAUDE.md rule 29a: loading is always the muted glyph, never "…" or a spinner): Replay's
 * kanji glyph in a small muted tile, the size of the spinner it replaces (16px), so nothing shifts. Decorative: the
 * surrounding control says what is loading (`aria-busy`, or a live status line).
 */
export function GlyphLoading({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      lang="ja"
      data-testid="glyph-loading"
      className={cn("inline-grid size-4 shrink-0 place-items-center rounded-xs bg-muted font-heading text-[11px] leading-none font-bold text-muted-foreground", className)}
    >
      再
    </span>
  );
}
