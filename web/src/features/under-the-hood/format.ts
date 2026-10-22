/** "84 ms" below a second, else "61.4 s" (whole seconds while a clock is ticking). */
export function formatMs(ms: number, ticking = false): string {
  if (ms < 1000) return ticking ? "0 s" : `${Math.round(ms)} ms`;
  return ticking ? `${Math.floor(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;
}

/** An age in seconds, coarsely: "40 s", "12 min", "11 h", "3 d". */
export function formatAge(s: number): string {
  if (s < 60) return `${Math.max(0, Math.round(s))} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} d`;
}
