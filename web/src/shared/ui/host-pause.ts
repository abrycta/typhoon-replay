// Paused by the page that frames this app (krtmtthw.dev, through src/embed/parent-bridge.ts): it pauses an embed
// while it is off-screen and, on touch devices, every embed but the one in view. The particle loop reads it; the
// embed's moment sequence subscribes to it.
// Outside an embed it is never set, so the app is unaffected.
let paused = false;
const listeners = new Set<() => void>();

export const hostPause = {
  get: (): boolean => paused,
  set(next: boolean) {
    paused = next;
    if (typeof document !== "undefined") document.documentElement.toggleAttribute("data-embed-paused", next);
    for (const l of listeners) l();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
