import { useTheme } from "@abrycta/akari/react";
import { useEffect, useState, useSyncExternalStore } from "react";

function mediaStore(query: string) {
  return {
    subscribe(fn: () => void) {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const m = window.matchMedia(query);
      m.addEventListener("change", fn);
      return () => m.removeEventListener("change", fn);
    },
    get: () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false),
  };
}

const reduced = mediaStore("(prefers-reduced-motion: reduce)");
const moreContrast = mediaStore("(prefers-contrast: more)");

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(reduced.subscribe, reduced.get, () => false);
}

/** Akari high contrast: the OS setting, or data-contrast="more" on <html> (ContrastToggle). */
export function useHighContrast(): boolean {
  const os = useSyncExternalStore(moreContrast.subscribe, moreContrast.get, () => false);
  const [attr, setAttr] = useState(() => typeof document !== "undefined" && document.documentElement.dataset.contrast);
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setAttr(el.dataset.contrast));
    obs.observe(el, { attributes: true, attributeFilter: ["data-contrast"] });
    return () => obs.disconnect();
  }, []);
  if (attr === "more") return true;
  if (attr === "normal") return false;
  return os;
}

/** "light" | "dark" for the map and colour scales, following Akari's theme. */
export function useMapTheme(): "light" | "dark" {
  return useTheme().resolvedTheme;
}
