import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, GONI, HAIYAN, RAI, test } from "./fixtures";

const MANGKHUT = "2018250N12170";
const UNNAMED = { sid: "1940032N08122", name: "Unnamed", localNames: {}, season: 1940, basin: "WP", startedAt: "1940-02-01T00:00:00Z", endedAt: "1940-02-05T00:00:00Z", landfallCountries: [] };

/** Gertrude 1948 and Faye 1949 as published in data v3 (track only here), with v4's `peakAt` in their index rows. */
const GERTRUDE = "1948240N14139";
const FAYE = "1949192N19142";
const OLD_PAIR = [
  { sid: GERTRUDE, name: "Gertrude", localNames: {}, designation: "12W", season: 1948, basin: "WP", startedAt: "1948-08-26T12:00:00Z", endedAt: "1948-09-04T00:00:00Z", peakWindKt: 85, peakWindAgency: "jtwc", peakAt: "1948-08-28T12:00:00Z", landfallCountries: ["PH"], saffirSimpson: "cat2" },
  { sid: FAYE, name: "Faye", localNames: {}, designation: "04W", season: 1949, basin: "WP", startedAt: "1949-07-10T18:00:00Z", endedAt: "1949-07-19T06:00:00Z", peakWindKt: 90, peakWindAgency: "jtwc", peakAt: "1949-07-14T18:00:00Z", landfallCountries: ["JP"], saffirSimpson: "cat2" },
];

/** The fixture index has no unnamed storm nor Kurt's 1948/1949 pair: add them, and block every API (Compare reads static data only). */
async function setup(page: Page) {
  await page.route("**/api/**", (r) => r.abort());
  await page.route("**/fixtures/v1/index.json", async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    body.storms.push(UNNAMED, ...OLD_PAIR);
    await r.fulfill({ response: res, json: body });
  });
  for (const sid of [GERTRUDE, FAYE]) {
    await page.route(`**/fixtures/v1/storms/${sid}/summary.json`, (r) => r.fulfill({ path: `e2e/data/${sid}.summary.json` }));
    await page.route(`**/fixtures/v1/storms/${sid}/track.json`, (r) => r.fulfill({ path: `e2e/data/${sid}.track.json` }));
  }
}

test("picker: search by PAGASA name and 台風第…号; unnamed storms only when asked", async ({ page }) => {
  await setup(page);
  await page.goto(`/compare?a=${HAIYAN}`);
  await page.getByRole("button", { name: "Choose storm B" }).click();
  const search = page.getByRole("combobox", { name: "Search storms" });
  await search.fill("odette");
  await expect(page.getByTestId("picker-count")).toHaveText("1 storms found");
  await search.fill("台風第22号");
  await expect(page.getByTestId("picker-count")).toHaveText("3 storms found"); // Rai, Mangkhut and Ida (昭和33年台風第22号)
  await expect(page.getByRole("option", { name: /Mangkhut/ })).toBeVisible();
  await search.fill("1940");
  await expect(page.getByTestId("picker-count")).toContainText("1 unnamed hidden");
  await page.getByLabel(/Include unnamed storms \(1/).check();
  await expect(page.getByRole("option", { name: /Unnamed storm · Feb 1940/ })).toBeVisible();
  await search.fill("odette");
  await page.getByRole("option", { name: /Rai/ }).click();
  await expect(page).toHaveURL(new RegExp(`b=${RAI}`));
  await expect(page.getByTestId("slot-B")).toContainText("Odette");
});

test("suggested pairs load both storms and their line-up; the current pair is marked", async ({ page }) => {
  await setup(page);
  await page.goto("/compare");
  const card = page.getByTestId("suggested-pair").filter({ hasText: "Haiyan vs Mangkhut" });
  await expect(card).toContainText("170 kt vs 155 kt");
  await card.click();
  await expect(page).toHaveURL(new RegExp(`a=${HAIYAN}.*b=${MANGKHUT}.*al=landfall|al=landfall.*a=${HAIYAN}`));
  await expect(card).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("zero-line")).toContainText("first landfall");
});

test("unequal lengths: one shared clock, before/after states, alignment and hour in the URL", async ({ page }) => {
  await setup(page);
  // Haiyan's fixture replay is 72 h; Rai (track only) about 240 h.
  await page.goto(`/compare?a=${HAIYAN}&b=${RAI}`);
  const head = page.getByTestId("playhead");
  // Both storms on the timeline (the clock is rebuilt when the second one arrives).
  await expect(page.getByTestId("lane-A")).toBeVisible();
  await expect(page.getByTestId("lane-B")).toBeVisible();
  await expect(page.getByTestId("zero-line")).toContainText("peak wind");
  await expect(head).toHaveAttribute("aria-valuenow", "0");
  await head.focus();
  await page.keyboard.press("Home");
  await expect(page.getByTestId("map-A").getByTestId("side-overlay")).toContainText("Not yet formed");
  await expect(page.getByTestId("map-B").getByTestId("side-overlay")).toHaveCount(0);
  await page.keyboard.press("End");
  await expect(page.getByTestId("map-A").getByTestId("side-overlay")).toContainText("Ended");
  await expect(page).toHaveURL(/h=\d+/);
  // Formation: both start at 0 h; Shift+→ moves six hours.
  await page.getByRole("radio", { name: "Formation" }).click();
  await expect(page).toHaveURL(/al=formation/);
  await head.focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(head).toHaveAttribute("aria-valuenow", "6");
  await expect(page).toHaveURL(/h=6/);
  await expect(page.getByTestId("side-overlay")).toHaveCount(0);
  // Reload keeps the line-up and the hour.
  await page.reload();
  await expect(page.getByTestId("playhead")).toHaveAttribute("aria-valuenow", "6");
  // Play moves both storms on the one clock.
  await page.getByTestId("play-both").click();
  await expect.poll(async () => Number(await page.getByTestId("playhead").getAttribute("aria-valuenow")), { timeout: 15_000 }).toBeGreaterThan(8);
  await page.getByTestId("play-both").click();
});

test("axe: compare with the picker open", async ({ page }) => {
  await setup(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/compare?a=${HAIYAN}&b=${RAI}`);
  await expect(page.getByTestId("lineup")).toBeVisible();
  await page.getByRole("button", { name: "Change storm A" }).click();
  await expect(page.getByRole("combobox", { name: "Search storms" })).toBeFocused();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).exclude(".maplibregl-ctrl-attrib").analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`)).toEqual([]);
});

test("data cards and About: a modern pair with full data", async ({ page }) => {
  await setup(page);
  await page.goto(`/compare?a=${HAIYAN}&b=${GONI}`);
  const a = page.getByTestId("map-A").getByTestId("data-card-A");
  await expect(a.getByRole("heading")).toHaveText("Haiyan's data");
  await expect(a.getByTestId("data-track")).toContainText("IBTrACS, 3-hourly fixes, shown hourly");
  await expect(a.getByTestId("data-wind")).toContainText("170 kt JTWC (1-min) · 125 kt JMA (10-min)");
  await expect(a.getByTestId("data-pressure")).toContainText("895 hPa");
  await expect(a.getByTestId("data-maps")).toContainText("ERA5, hourly, about 28 km grid");
  await expect(a.getByTestId("data-offset")).toContainText("Not measured");
  await expect(a.getByTestId("data-era")).toContainText("Weather satellites");
  await expect(page.getByTestId("map-B").getByTestId("data-wind")).toContainText("170 kt JTWC (1-min) · 120 kt JMA (10-min)");
  await expect(page.getByTestId("map-B").getByTestId("data-pressure")).toContainText("884 hPa");
  const about = page.getByTestId("about-comparison");
  await expect(about.getByRole("heading", { name: "About this comparison" })).toBeVisible();
  await expect(about).toContainText("Lined up at peak wind:");
  await expect(about).toContainText("(Haiyan: 170 kt JTWC, 125 kt JMA)");
  await expect(about).not.toContainText("Older storms");
  await expect(about.getByTestId("gap-chip")).toHaveText(["None: both have pressure, JTWC and JMA winds and ERA5 maps"]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const results = await new AxeBuilder({ page }).include("[data-testid=about-comparison]").include("[data-testid^=data-card]").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});

test("data cards and About: Gertrude 1948 vs Faye 1949 (no JMA, no pressure); the pair's reason uses peak times", async ({ page }) => {
  await setup(page);
  await page.goto("/compare");
  const pair = page.getByTestId("suggested-pair").filter({ hasText: "Gertrude 1948 vs Faye 1949" });
  await expect(pair).toContainText("Same 204 h life, 1948 and 1949, but peaks 48 h apart");
  await pair.click();
  await expect(page).toHaveURL(new RegExp(`a=${GERTRUDE}`));
  const a = page.getByTestId("data-card-A");
  await expect(a.getByTestId("data-track")).toContainText("IBTrACS, 6-hourly fixes, shown hourly");
  await expect(a.getByTestId("data-wind")).toContainText("85 kt JTWC (1-min) · no JMA record (before 1951)");
  await expect(a.getByTestId("data-pressure")).toContainText("Not recorded");
  await expect(a.getByTestId("data-era")).toContainText("Before weather satellites: positions from ships, land stations and aircraft");
  await expect(page.getByTestId("data-card-B").getByTestId("data-wind")).toContainText("90 kt JTWC (1-min) · no JMA record (before 1951)");
  const about = page.getByTestId("about-comparison");
  await expect(about).toContainText("Older storms are rougher.");
  // Track only in this fixture (the live v3 storms have ERA5 maps).
  await expect(about.getByTestId("gap-chip")).toHaveText(["Gertrude: no pressure, no JMA data, no ERA5 maps", "Faye: no pressure, no JMA data, no ERA5 maps"]);
});

test("390 px: data cards stack under their maps, About full width, no horizontal scroll", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/compare?a=${GERTRUDE}&b=${FAYE}`);
  await expect(page.getByTestId("data-card-B")).toBeVisible();
  const [mapA, cardA, mapB, about] = await Promise.all(["map-A", "data-card-A", "map-B", "about-comparison"].map((id) => page.getByTestId(id).boundingBox()));
  expect(cardA!.y).toBeGreaterThan(mapA!.y);
  expect(mapB!.y).toBeGreaterThan(cardA!.y + cardA!.height - 1);
  expect(about!.width).toBeGreaterThan(340);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
