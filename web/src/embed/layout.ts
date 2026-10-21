// The embed's two layouts, chosen by the frame's own width:
// - desktop: krtmtthw.dev shows a fixed 1440×900 frame scaled to its picture slot (mouse and trackpad devices);
// - compact: phones and tablets get the frame at the slot's real size (at most about 960 px wide), laid out for
//   that size: the map, then a two-line caption. Never the desktop view scaled down.
import { useSyncExternalStore } from "react";

export const COMPACT_QUERY = "(max-width: 1100px)";

export function useCompact(): boolean {
  return useSyncExternalStore(
    (on) => {
      const m = matchMedia(COMPACT_QUERY);
      m.addEventListener("change", on);
      return () => m.removeEventListener("change", on);
    },
    () => matchMedia(COMPACT_QUERY).matches,
  );
}
