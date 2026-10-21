// "The reader is leaving this page": set from `beforeunload`, the first event of a navigation away.
//
// Why: when the reader leaves mid-load, the browser cancels the page's requests at once (WebKit right after
// `beforeunload`, before `pagehide`). Code that answers a failed request by starting another one (the dataset's
// fallback host, the .tyf after the WebP frames, the bundled coastline after the basemap) would then start a request
// on a page that is going away, and WebKit logs each one as "Fetch API cannot load ... due to access control checks".
// Those fallbacks ask `isLeavingPage()` first and stop quietly instead.
//
// No unload handler and nothing that blocks the back/forward cache. When the reader stays after all (a download, a
// cancelled navigation), the flag clears after a few seconds; it also clears when the page comes back from the
// back/forward cache (`pageshow`).

type Listener = (leaving: boolean) => void;

let leaving = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<Listener>();

function set(v: boolean) {
  if (leaving === v) return;
  leaving = v;
  for (const l of listeners) l(v);
}

/** True from the moment the reader starts leaving the page until it is gone (or they stay after all). */
export function isLeavingPage(): boolean {
  return leaving;
}

/** Called with true when the reader starts leaving, and false if they stay or come back. Returns an unsubscribe. */
export function onPageExit(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Still here this long after `beforeunload`: the navigation did not happen (a download, a cancelled navigation). */
export const STAY_MS = 4000;

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    set(true);
    clearTimeout(timer);
    timer = setTimeout(() => set(false), STAY_MS);
  });
  window.addEventListener("pageshow", () => {
    clearTimeout(timer);
    set(false);
  });
}

/**
 * Requests started on this page while it is being left fail at once, quietly, as aborted (AbortError, which callers
 * and MapLibre already treat as "cancelled, say nothing"), instead of reaching the browser, which would refuse them and
 * log an error. This covers code that is not ours: MapLibre asks for glyphs as it finishes the tiles it was parsing.
 * Call once at startup.
 */
export function guardFetchWhileLeaving(): void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  const fetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    leaving ? Promise.reject(new DOMException("The page is being left", "AbortError")) : fetch(input, init);
}
