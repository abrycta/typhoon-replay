// The frozen /embed page krtmtthw.dev frames (src/embed): no Header, a still map over the baked basemap, no link
// out (the live app is reached only from the project page), the ready message to the parent, and not one request
// off this origin.
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

test("embed: frozen storm view, no Header, no link out, still map, ready message, own origin only", async ({ page, baseURL }) => {
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

  // No way out of the embed: the live app is linked only from its project page.
  await expect(page.getByRole("link", { name: /live app/i })).toHaveCount(0);
  await expect(page.locator('a[target="_blank"]')).toHaveCount(0);

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

// Phones and tablets: krtmtthw.dev gives the frame its picture slot's real size (16:10; 358×224 on a 390 px phone,
// the frame 1 px inside). The compact layout: the map filling the frame over a two-line caption at a readable size,
// never the desktop view scaled down; the same packed data, still nothing off this origin.
test.describe("compact (phone)", () => {
  test.use({ viewport: { width: 356, height: 222 } });

  test("embed: map over a two-line caption, no player or panels, ready message", async ({ page, baseURL }) => {
    const bad = offOrigin(page, new URL(baseURL!).origin);
    await page.addInitScript(() => {
      const posted: unknown[] = [];
      Object.defineProperty(window, "__posted", { value: posted });
      Object.defineProperty(window, "parent", { get: () => ({ postMessage: (data: unknown, origin: string) => posted.push({ data, origin }) }) });
    });
    await page.goto(`${EMBED}?lang=en`);
    await expect(page.locator('[data-layout="compact"]')).toBeVisible();
    await expect(page.getByTestId("storm-replay")).toHaveAttribute("data-frame-ready", "true");
    const caption = page.getByTestId("embed-caption");
    await expect(caption).toContainText("Haiyan");
    await expect(page.getByTestId("embed-caption-figures")).toContainText("ERA5 26.9 m/s");
    await expect(page.getByTestId("intensity-panel")).toHaveCount(0);
    await expect(page.getByTestId("play-toggle")).toHaveCount(0);
    // Readable at the slot's real size (14 px and 12 px lines); the map takes the rest, and nothing scrolls.
    expect(await caption.locator("p").evaluateAll((ps) => ps.map((p) => parseFloat(getComputedStyle(p).fontSize)))).toEqual([14, 12]);
    const map = (await page.getByTestId("replay-map").boundingBox())!;
    const box = (await caption.boundingBox())!;
    expect(map.height).toBeGreaterThan(140);
    expect(box.y + box.height).toBeLessThanOrEqual(222.5);
    expect(await page.evaluate(() => [document.documentElement.scrollHeight <= innerHeight, scrollY])).toEqual([true, 0]);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __posted: unknown[] }).__posted))
      .toContainEqual({ data: { type: "akari:embed-ready", app: "replay" }, origin: "https://krtmtthw.dev" });
    expect(bad, "requests off the app's origin or to /api/").toEqual([]);
  });
});

// The parent (krtmtthw.dev) starts the frame still (?paused=1) and pauses or resumes it by message; the wind
// particles stop while paused. A stand-in parent page on the real origin frames the local build (both on public
// https origins, proxied, since Chrome won't let a public page frame 127.0.0.1). Messages from elsewhere are ignored.
test("embed: the parent pauses and resumes the particles, and only the parent", async ({ page, baseURL }) => {
  const app = "https://replay.krtmtthw.dev";
  await page.route(`${app}/**`, async (r) => {
    const u = new URL(r.request().url());
    await r.fulfill({ response: await r.fetch({ url: `${baseURL}${u.pathname}${u.search}` }) });
  });
  const src = `${app}${EMBED}?lang=en&paused=1`;
  await page.route("https://krtmtthw.dev/", (r) =>
    r.fulfill({ contentType: "text/html", body: `<!doctype html><iframe src="${src}" width="1440" height="900"></iframe>` }),
  );
  await page.goto("https://krtmtthw.dev/");
  const embed = page.frameLocator("iframe");
  await expect(embed.getByTestId("storm-replay")).toHaveAttribute("data-frame-ready", "true", { timeout: 20_000 });
  const map = embed.getByTestId("replay-map");
  const still = async () => {
    const a = await map.screenshot();
    await page.waitForTimeout(600);
    return a.equals(await map.screenshot());
  };
  const send = (type: string) =>
    page.evaluate(([t, o]) => document.querySelector("iframe")!.contentWindow!.postMessage({ type: t }, o!), [type, app]);
  await page.waitForTimeout(500);
  expect(await still()).toBe(true);
  await send("akari:embed-resume");
  await expect.poll(still).toBe(false);
  await send("akari:embed-pause");
  await expect(embed.locator("html")).toHaveAttribute("data-embed-paused", "");
  await page.waitForTimeout(300);
  expect(await still()).toBe(true);
  // A message from the frame itself (not the parent) is ignored.
  await embed.locator("html").evaluate(() => window.postMessage({ type: "akari:embed-resume" }, "*"));
  await page.waitForTimeout(300);
  expect(await still()).toBe(true);
});
