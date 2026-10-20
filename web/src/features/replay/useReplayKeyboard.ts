import { useEffect } from "react";

import type { PlayerClock } from "./player";

const TYPING = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * Page-level replay keys: Space/K play-pause, ←/→ one hour, PageUp/PageDown six hours, Home/End.
 * Ignored while typing or when a focused control handles the key itself (buttons, the scrubber).
 */
export function useReplayKeyboard(clock: PlayerClock, seek: (i: number) => void, index: () => number, enabled: boolean, frames: number) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (TYPING.has(el.tagName) || el.isContentEditable || el.getAttribute("role") === "slider")) return;
      const onButton = el?.tagName === "BUTTON" || el?.getAttribute("role") === "radio" || el?.getAttribute("role") === "switch";
      switch (e.key) {
        case " ":
        case "k":
          if (onButton && e.key === " ") return;
          e.preventDefault();
          clock.toggle();
          break;
        case "ArrowLeft":
        case "ArrowRight":
          if (onButton && el?.getAttribute("role") === "radio") return;
          e.preventDefault();
          seek(index() + (e.key === "ArrowRight" ? 1 : -1));
          break;
        case "PageUp":
        case "PageDown":
          e.preventDefault();
          seek(index() + (e.key === "PageUp" ? 6 : -6));
          break;
        case "Home":
          e.preventDefault();
          seek(0);
          break;
        case "End":
          e.preventDefault();
          seek(frames - 1);
          break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [clock, seek, index, enabled, frames]);
}
