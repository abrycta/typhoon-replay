// The frozen /embed page krtmtthw.dev frames (src/embed): no Header, a still map over the baked basemap, the
// "Open the live app" link, the ready message to the parent, and not one request off this origin.
import type { Page } from "@playwright/test";

import { expect, HAIYAN, test } from "./fixtures";

const EMBED = `/embed/storm/${HAIYAN}`;
test.use({ viewport: { width: 1440, height: 900 } });

function offOrigin(page: Page, origin: string) {
  const bad: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.protocol === "data:" || u.protocol === "blob:") return;
    if (u.origin !== origin || u.pathname.startsWith("/api/")) bad.push(r.url());
  });
  return bad;
}

test("embed: frozen storm view, no Header, link out, still map, ready message, own origin only", async ({ page, baseURL }) => {
  const bad = offOrigin(page, new URL(baseURL!).origin);
  // Framed by krtmtthw.dev: a stand-in parent records what the embed posts to it.
  await page.addInitScript(() => {
    const posted: unknown[] = [];
    Object.defineProperty(window, "__posted", { value: posted });
    Object.defineProperty(window, "parent", { get: () => ({ postMessage: (data: unknown, origin: string) => posted.push({ data, origin }) }) });
  });
  await page.goto(`${EMBED}?lang=en`);
  const replay = page.getByTestId("storm-replay");
  await expect(replay).toHaveAttribute("data-frame-ready", "true");
  await expect(page.getByTestId("era5-wind")).toContainText("26.9");
  await expect(page.locator("[data-akari-header]")).toHaveCount(0);
  await expect(page.locator("footer")).toHaveCount(0);

  const link = page.getByTestId("embed-open-live");
  await expect(link).toHaveText(/Open the live app ↗/);
  await expect(link).toHaveAttribute("href", `https://replay.krtmtthw.dev/storm/${HAIYAN}?t=2013-11-07T21:00Z&v=124.31,11.17,4.6&lang=en`);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener");

  // Still map: no controls, no interactive handlers, the canvas is not focusable.
  const map = page.getByTestId("replay-map");
  await expect(map.locator(".maplibregl-ctrl-zoom-in")).toHaveCount(0);
  await expect(map.locator(".maplibregl-interactive")).toHaveCount(0);
  await expect(map.locator("canvas")).not.toHaveAttribute("tabindex", "0");
  // The player is shown but inert; the page never scrolls.
  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight <= innerHeight || getComputedStyle(document.body).overflow === "hidden")).toBe(true);

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __posted: unknown[] }).__posted))
    .toContainEqual({ data: { type: "akari:embed-ready", app: "replay" }, origin: "https://krtmtthw.dev" });
  expect(bad, "requests off the app's origin or to /api/").toEqual([]);
});
