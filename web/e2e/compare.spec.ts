import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, HAIYAN, RAI, test } from "./fixtures";

const MANGKHUT = "2018250N12170";
const UNNAMED = { sid: "1940032N08122", name: "Unnamed", localNames: {}, season: 1940, basin: "WP", startedAt: "1940-02-01T00:00:00Z", endedAt: "1940-02-05T00:00:00Z", landfallCountries: [] };

/** The fixture index has no unnamed storm: add one, and block every API (Compare reads static data only). */
async function setup(page: Page) {
  await page.route("**/api/**", (r) => r.abort());
  await page.route("**/fixtures/v1/index.json", async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    body.storms.push(UNNAMED);
    await r.fulfill({ response: res, json: body });
  });
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
