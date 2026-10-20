import { expect, HAIYAN, PEAK, RAI, test, waitForReplay } from "./fixtures";

test("home: featured Haiyan replay, search and browse", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Replay any typhoon, hour by hour");
  await expect(page.getByLabel("Featured replay")).toBeVisible();
  await expect(page.getByTestId("replay-map").first()).toBeVisible();
  await expect(page.getByTestId("data-as-of")).toContainText("sample data");
  await page.getByLabel("Find a storm").fill("yolanda");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/\/storms\?q=yolanda/);
  await expect(page.getByRole("link", { name: /Haiyan/ })).toBeVisible();
});

test("storms: browse by decade and country", async ({ page }) => {
  await page.goto("/storms?decade=1950");
  await expect(page.getByRole("status")).toContainText("2 of 16 storms");
  await page.getByLabel("Landfall").selectOption("JP");
  await expect(page.getByRole("link", { name: "Vera" })).toBeVisible();
});

test("storm page: best track beside the field, labelled reanalysis context, with the honesty ratio", async ({ page }) => {
  await page.goto(`/storm/${HAIYAN}?t=${PEAK}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Haiyan");
  await waitForReplay(page);
  await expect(page.getByTestId("bt-jtwc")).toContainText("87.5 m/s");
  await expect(page.getByText("reanalysis context", { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId("honesty-ratio")).toContainText("0.31× JTWC");
  await expect(page.getByTestId("honesty-ratio")).toContainText("0.42× JMA");
  await expect(page.getByTestId("affected-places")).toContainText("Tacloban City");
  await expect(page.getByTestId("timeline-table").getByRole("row")).toHaveCount(73);
  // The map draws the field through the custom WebGL layer.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __trMaps?: { getLayer(id: string): unknown }[] }).__trMaps?.at(-1)?.getLayer("era5-field") !== undefined))
    .toBe(true);
});

test("share links keep time, layer and view", async ({ page }) => {
  await page.goto(`/storm/${HAIYAN}?t=${PEAK}&layer=rain&units=kt`);
  await waitForReplay(page);
  await expect(page.getByRole("radio", { name: "Rain" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("replay-time")).toHaveText(/7 Nov 2013, 20:00 GMT\+8/);
  await page.getByRole("radio", { name: "Pressure" }).click();
  await expect(page).toHaveURL(/layer=pressure/);
  await expect(page).toHaveURL(/t=2013-11-07T12%3A00Z|t=2013-11-07T12:00Z/);
  await page.reload();
  await expect(page.getByRole("radio", { name: "Pressure" })).toHaveAttribute("aria-checked", "true");
});

test("track-only storms still replay (no frames published)", async ({ page }) => {
  await page.goto(`/storm/${RAI}`);
  await expect(page.getByText("Track only: field frames not published yet")).toBeVisible();
  await expect(page.getByTestId("scrubber")).toBeEnabled();
  await expect(page.getByTestId("timeline-table").getByRole("row").nth(1)).toBeVisible();
});

test("compare keeps both storms and the hour in the URL", async ({ page }) => {
  await page.goto(`/compare?a=${HAIYAN}&b=${RAI}&h=30`);
  await expect(page.getByRole("heading", { name: /Haiyan/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Rai/ })).toBeVisible();
  const scrubbers = page.getByTestId("scrubber");
  await expect(scrubbers).toHaveCount(2);
  await expect(scrubbers.nth(0)).toHaveValue("30");
  await expect(scrubbers.nth(1)).toHaveValue("30");
  await page.getByRole("combobox", { name: "First storm" }).selectOption("2019278N16165");
  await expect(page).toHaveURL(/a=2019278N16165/);
});

test("graceful degradation: the replay works with every API blocked", async ({ page }) => {
  await page.route("**/api/**", (r) => r.abort());
  await page.goto(`/storm/${HAIYAN}?t=${PEAK}`);
  await waitForReplay(page);
  await expect(page.getByTestId("honesty-ratio")).toContainText("0.31×");
});

test("storm header: one landfall phrase per country; each landfall in the timeline", async ({ page }) => {
  test.slow(); // a full storm page with a software-rendered map; under CI load this alone can take ~40 s
  // Header and timeline come from summary.json and track.json; the ERA5 field is not needed. Reduced motion keeps
  // the software-rendered map from animating particles, which starves the main thread on a loaded CI machine.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/storm/${HAIYAN}?t=${PEAK}`);
  const lede = page.getByTestId("storm-lede");
  await expect(lede).toContainText("landfall in the Philippines 8 Nov 2013");
  expect((await lede.textContent())!.match(/in the Philippines/g)).toHaveLength(1);
  // The timeline table sits below the map; give it the time the replay tests give the first frame.
  const marks = page.getByTestId("timeline-landfall");
  await expect(marks).toHaveCount(1, { timeout: 30_000 });
  await expect(marks).toHaveText("Landfall in the Philippines at 8 Nov, 08:00"); // 00:00 UTC in the default local time (GMT+8)
});

test("errors: unknown storm and unknown page show the 404", async ({ page }) => {
  await page.goto("/storm/1999001N00000");
  await expect(page.getByRole("heading", { name: "This page blew away" })).toBeVisible();
  await page.goto("/no/such/page");
  await expect(page.getByRole("heading", { name: "This page blew away" })).toBeVisible();
});

test("about lists sources and licences; Japanese UI", async ({ page }) => {
  await page.goto("/about?lang=ja");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Typhoon Replay について");
  await expect(page.getByRole("link", { name: /IBTrACS/ })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
});

test("share shell carries Open Graph tags for crawlers", async ({ request }) => {
  const html = await (await request.get(`/storm/${HAIYAN}`)).text();
  expect(html).toContain('<meta property="og:title" content="Haiyan (Yolanda) 2013 · Typhoon Replay"');
  expect(html).toContain(`<link rel="canonical" href="https://typhoon.krtmtthw.dev/storm/${HAIYAN}"`);
  const sitemap = await (await request.get("/sitemap.xml")).text();
  expect(sitemap).toContain(`/storm/${HAIYAN}</loc>`);
});
