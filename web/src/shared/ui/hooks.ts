import { useTheme } from "@abrycta/akari/react";
import { type RefObject, useEffect, useState, useSyncExternalStore } from "react";

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
/** Workspace rule 6b: a wide screen with a fine pointer that hovers (not a phone or a touch-only tablet). */
const desktopClass = mediaStore("(min-width: 768px) and (hover: hover) and (pointer: fine)");
const saveData = () => (typeof navigator !== "undefined" && (navigator as { connection?: { saveData?: boolean } }).connection?.saveData) === true;

/** A desktop-class device without Save-Data (rule 6b); follows rotation, resizes and input changes. */
export function useDesktopClass(): boolean {
  return useSyncExternalStore(desktopClass.subscribe, desktopClass.get, () => false) && !saveData();
}

/** True once `ref`'s element has come within `margin` of the viewport (and stays true). */
export function useNearViewport(ref: RefObject<Element | null>, margin = "800px", skip = false): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (near || skip || !el) return;
    if (typeof IntersectionObserver === "undefined") {
      // The browser can't tell: load now rather than never.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNear(true);
      return;
    }
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: `${margin} 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, margin, near, skip]);
  return near;
}
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
