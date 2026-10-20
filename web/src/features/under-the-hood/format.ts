/** "84 ms" below a second, else "61.4 s" (whole seconds while a clock is ticking). */
export function formatMs(ms: number, ticking = false): string {
  if (ms < 1000) return ticking ? "0 s" : `${Math.round(ms)} ms`;
  return ticking ? `${Math.floor(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`;
}
