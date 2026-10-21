// Paused by the page that frames this app (krtmtthw.dev, through src/embed/parent-bridge.ts): it pauses an embed
// while it is off-screen and, on touch devices, every embed but the one in view. The particle loop reads it.
// Outside an embed it is never set, so the app is unaffected.
let paused = false;

export const hostPause = {
  get: (): boolean => paused,
  set(next: boolean) {
    paused = next;
    if (typeof document !== "undefined") document.documentElement.toggleAttribute("data-embed-paused", next);
  },
};
