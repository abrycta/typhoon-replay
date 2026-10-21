/** ?pr= from the parent (0.5-2, the frame is shown scaled down), else the device's, at most 2. */
export function embedPixelRatio(search = location.search): number {
  const pr = Number(new URLSearchParams(search).get("pr"));
  if (Number.isFinite(pr) && pr > 0) return Math.min(2, Math.max(0.5, pr));
  return Math.min(window.devicePixelRatio || 1, 2);
}

