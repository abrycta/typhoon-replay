// The embed's side of the krtmtthw.dev iframe contract: tell the parent when the first full frame is painted,
// follow its scale (the frame is shown scaled down) and its theme. Only messages from the portfolio itself count.
import { cookieDomainApplies, THEME_STORE_EVENT, writeContrast, writeTheme } from "@abrycta/akari/react";

export const PARENT_ORIGIN = "https://krtmtthw.dev";
const COOKIE_DOMAIN = "krtmtthw.dev";

const framed = () => window.parent !== window;

/** Once the first full frame is painted (map idle, basemap loaded, data drawn). */
export function postReady(app: "replay" | "lights") {
  if (framed()) window.parent.postMessage({ type: "akari:embed-ready", app }, PARENT_ORIGIN);
}

type ParentMessage =
  | { type: "akari:embed-scale"; scale: number }
  | { type: "akari:theme"; theme: "light" | "dark" | null; contrast: "more" | "normal" | null };

export function handleParentMessage(data: unknown, root: HTMLElement = document.documentElement) {
  const m = data as ParentMessage | null;
  if (m?.type === "akari:embed-scale") {
    if (typeof m.scale === "number" && m.scale > 0 && m.scale <= 1) root.style.setProperty("--embed-scale", String(m.scale));
  } else if (m?.type === "akari:theme") {
    if (cookieDomainApplies(location.hostname, COOKIE_DOMAIN)) {
      // The shared cookie already holds the parent's choice: Akari's ThemeProvider re-reads it.
      window.dispatchEvent(new Event(THEME_STORE_EVENT));
    } else {
      // Local or preview hosts: this origin's storage only (both notify the provider).
      writeTheme(m.theme === "light" || m.theme === "dark" ? m.theme : null, {});
      writeContrast(m.contrast === "more" || m.contrast === "normal" ? m.contrast : null, {});
    }
  }
}

/** Listens for the parent's messages; returns the cleanup. */
export function listenToParent(): () => void {
  const on = (e: MessageEvent) => {
    if (e.origin !== PARENT_ORIGIN || e.source !== window.parent) return;
    handleParentMessage(e.data);
  };
  window.addEventListener("message", on);
  return () => window.removeEventListener("message", on);
}
