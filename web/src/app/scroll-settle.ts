// Back/Forward and links to #sections land where they should, even though the page fills in after it renders.
//
// TanStack Router restores the window's scroll position (`scrollRestoration: true`) as soon as the route renders. On a
// storm page or a list most of the content arrives a moment later (config, dataset index, storm summary), so after a
// full-page Back the page is still short: the browser clamps the restored position near the top and nothing tries
// again. Likewise a link to /storm/<sid>#sources-h renders before the section exists, so the jump never happens.
//
// settleScroll keeps the target in place while the document grows, until it is reached and the page has stopped
// changing, the reader scrolls or presses a key themselves, or a few seconds have passed.

export interface SettleTarget {
  /** Window position to restore (Back/Forward, reload). */
  y?: number;
  /** Element id to bring under the Header (a link to #id), when there is no position to restore. */
  hash?: string;
}

/**
 * Is the page being shown by a history traversal (Back/Forward, or a reload), the only time a saved position should
 * be restored? True for this document if it was loaded that way, and after every popstate (in-app Back/Forward).
 * `takeTraversal` reads it and resets it, once per page shown.
 */
function loadedByTraversal(): boolean {
  if (typeof performance === "undefined" || !performance.getEntriesByType) return false;
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return nav?.type === "back_forward" || nav?.type === "reload";
}
let traversal = loadedByTraversal();
if (typeof window !== "undefined") window.addEventListener("popstate", () => (traversal = true));

export function takeTraversal(): boolean {
  const t = traversal;
  traversal = false;
  return t;
}

/** Give up after this long: the reader is better served by where they are than by a late jump. */
export const SETTLE_MS = 8000;

const USER_INPUT = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

export function settleScroll(target: SettleTarget, timeoutMs = SETTLE_MS): () => void {
  const { y, hash } = target;
  if (typeof window === "undefined" || (y === undefined && !hash)) return () => {};
  const root = document.documentElement;
  const padding = () => parseFloat(getComputedStyle(root).scrollPaddingTop) || 0;
  const apply = () => {
    if (y !== undefined) {
      if (Math.abs(window.scrollY - y) > 1) window.scrollTo({ top: y, behavior: "instant" });
      return;
    }
    const el = hash ? document.getElementById(hash) : null;
    if (el && Math.abs(el.getBoundingClientRect().top - padding()) > 1) el.scrollIntoView({ block: "start", behavior: "instant" });
  };
  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(apply);
  };
  const ro = new ResizeObserver(schedule);
  ro.observe(root);
  if (document.body) ro.observe(document.body);
  // A #section that is not rendered yet: watch for it (at most once a frame).
  const mo = y === undefined ? new MutationObserver(schedule) : null;
  mo?.observe(document.body, { childList: true, subtree: true });
  const stop = () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    ro.disconnect();
    mo?.disconnect();
    for (const ev of USER_INPUT) window.removeEventListener(ev, stop, true);
  };
  for (const ev of USER_INPUT) window.addEventListener(ev, stop, { capture: true, passive: true });
  const timer = setTimeout(stop, timeoutMs);
  schedule();
  return stop;
}
