import { readFileSync } from "node:fs";

import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// The bundled fixture (16 named storms) plus five unnamed storms copied from the live index (data v1),
// served oldest first like the published index.json. Two carry the `designation` the pipeline adds
// from data v2; the others have none, so both index shapes are covered.
const UNNAMED = [
  { sid: "1940032N08122", name: "Unnamed", localNames: {}, season: 1940, basin: "WP", startedAt: "1940-02-01T00:00:00Z", endedAt: "1940-02-01T12:00:00Z", landfallCountries: ["PH"], replayAvailable: false, ace: 0 },
  { sid: "1951181N21122", name: "Unnamed", localNames: { ja: "台風第7号" }, season: 1951, basin: "WP", startedAt: "1951-06-30T06:00:00Z", endedAt: "1951-07-10T00:00:00Z", minPressureHpa: 992, landfallCountries: ["JP"], replayAvailable: false, ace: 0 },
  { sid: "2021132N06132", name: "Unnamed", localNames: { ph: "Crising" }, designation: "03W", season: 2021, basin: "WP", startedAt: "2021-05-11T18:00:00Z", endedAt: "2021-05-15T00:00:00Z", peakWindKt: 35, peakWindAgency: "jtwc", minPressureHpa: 1000, landfallCountries: ["PH"], replayAvailable: false, ace: 0.24 },
  { sid: "2022088N09116", name: "Unnamed", localNames: {}, designation: "01W", season: 2022, basin: "WP", startedAt: "2022-03-29T00:00:00Z", endedAt: "2022-04-01T06:00:00Z", peakWindKt: 35, peakWindAgency: "jtwc", minPressureHpa: 1002, landfallCountries: [], replayAvailable: false, ace: 0.24 },
  { sid: "2025338N12131", name: "Unnamed", localNames: {}, season: 2025, basin: "WP", startedAt: "2025-12-04T00:00:00Z", endedAt: "2025-12-07T15:00:00Z", landfallCountries: ["PH"], replayAvailable: false, ace: 0 },
];

const fixture = JSON.parse(readFileSync(new URL("../fixtures/v1/index.json", import.meta.url), "utf8")) as { storms: { sid: string }[] };
const INDEX = { ...fixture, storms: [...fixture.storms, ...UNNAMED].sort((a, b) => a.sid.localeCompare(b.sid)) };
const TOTAL = INDEX.storms.length;

async function serveIndex(page: Page) {
  await page.route(/\/fixtures\/v1\/index\.json$/, (r) => r.fulfill({ json: INDEX }));
}

/** The storm names in list order (each card's heading link). */
async function names(page: Page, n?: number): Promise<string[]> {
  const list = page.getByRole("list", { name: /^(Storms|台風)/ });
  await expect(list.getByRole("listitem").first()).toBeVisible();
  const all = await list.getByRole("listitem").locator("a").allInnerTexts();
  return (n ? all.slice(0, n) : all).map((s) => s.replace(/\s+/g, " ").trim());
}

test.beforeEach(async ({ page }) => serveIndex(page));

test("default order is newest first, with honest labels for unnamed storms", async ({ page }) => {
  await page.goto("/storms");
  await expect(page.getByRole("status")).toContainText(`${TOTAL} of ${TOTAL} storms`);
  await expect(page.getByLabel("Sort", { exact: true })).toHaveValue("newest");
  expect(await names(page, 7)).toEqual([
    "Unnamed storm · Dec 2025",
    "Noru (Karding)",
    "Nanmadol",
    "Unnamed storm · 01W · Mar 2022",
    "Rai (Odette)",
    "Crising (PAGASA name)",
    "Goni (Rolly)",
  ]);
  const all = await names(page);
  expect(all.slice(-2)).toEqual(["Typhoon No. 7 (JMA number)", "Unnamed storm · Feb 1940"]);
  expect(all.filter((n) => /^Unnamed$/.test(n))).toEqual([]);
  // A local name says it has no international name, with the JTWC number when known.
  const crising = page.getByRole("listitem").filter({ hasText: "Crising" });
  await expect(crising).toContainText("No international name · 03W");
  // Default sort stays out of the URL.
  expect(new URL(page.url()).search).toBe("");

  await page.goto("/storms?lang=ja&sort=oldest");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  expect(await names(page, 2)).toEqual(["名称なし · 1940年2月", "台風第7号（気象庁の番号）"]);
});

test("changing the sort reorders the list and is kept in the URL", async ({ page }) => {
  await page.goto("/storms");
  await page.getByLabel("Sort", { exact: true }).selectOption("strongest");
  await expect(page).toHaveURL(/[?&]sort=strongest/);
  expect(await names(page, 3)).toEqual(["Ida", "Haiyan (Yolanda)", "Goni (Rolly)"]);
  // Storms without a wind estimate come last.
  expect((await names(page)).slice(-3)).toEqual(["Typhoon No. 7 (JMA number)", "Unnamed storm · Dec 2025", "Unnamed storm · Feb 1940"]);

  await page.getByLabel("Sort", { exact: true }).selectOption("name");
  await expect(page).toHaveURL(/[?&]sort=name/);
  const byName = await names(page);
  expect(byName.slice(0, 3)).toEqual(["Bopha (Pablo)", "Durian (Reming)", "Faxai"]);
  expect(byName.slice(-5)).toEqual([
    "Crising (PAGASA name)",
    "Unnamed storm · Dec 2025",
    "Unnamed storm · 01W · Mar 2022",
    "Typhoon No. 7 (JMA number)",
    "Unnamed storm · Feb 1940",
  ]);

  await page.getByLabel("Sort", { exact: true }).selectOption("oldest");
  await expect(page).toHaveURL(/[?&]sort=oldest/);
  expect(await names(page, 2)).toEqual(["Unnamed storm · Feb 1940", "Typhoon No. 7 (JMA number)"]);

  // The replay filter works from the keyboard; sort and filter survive a reload (shareable URL).
  const replay = page.getByRole("checkbox", { name: "Replay available" });
  await replay.focus();
  await page.keyboard.press("Space");
  await expect(page).toHaveURL(/[?&]replay=true/);
  await page.reload();
  await expect(page.getByLabel("Sort", { exact: true })).toHaveValue("oldest");
  await expect(page.getByRole("checkbox", { name: "Replay available" })).toBeChecked();
  expect(await names(page)).toEqual(["Haiyan (Yolanda)", "Goni (Rolly)"]);
});
