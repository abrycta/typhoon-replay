import { expect, HAIYAN, PEAK, test, waitForReplay } from "./fixtures";

const PORTFOLIO = "https://krtmtthw.dev";

// Every top-level route, a storm page and the 404: the brand and "Home" lead to /, the portfolio link to krtmtthw.dev.
const PAGES = [
  { name: "home", path: "/", current: "Home" },
  { name: "storms", path: "/storms", current: "Storms" },
  { name: "compare", path: `/compare?a=${HAIYAN}&b=2021346N05145`, current: "Compare" },
  { name: "town", path: "/town", current: "My town" },
  { name: "under the hood", path: "/under-the-hood", current: "Under the hood" },
  { name: "about", path: "/about", current: "About" },
  { name: "storm", path: `/storm/${HAIYAN}?t=${PEAK}`, current: undefined },
  { name: "404", path: "/no/such/page", current: undefined },
];

for (const p of PAGES) {
  test(`${p.name}: brand and Home go to /, portfolio links to krtmtthw.dev`, async ({ page }) => {
    await page.goto(p.path);
    const header = page.getByRole("banner");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav).toBeVisible();

    const brand = header.getByRole("link", { name: "Typhoon Replay home" });
    await expect(brand).toHaveAttribute("href", "/");
    await expect(nav.getByRole("link", { name: "Home", exact: true })).toHaveAttribute("href", "/");

    // aria-current marks exactly the active section (none on storm pages and the 404).
    const current = nav.locator('[aria-current="page"]');
    if (p.current) {
      await expect(current).toHaveCount(1);
      await expect(current).toHaveText(p.current);
    } else {
      await expect(current).toHaveCount(0);
    }

    const portfolio = header.getByRole("link", { name: /krtmtthw\.dev/ });
    await expect(portfolio).toHaveAttribute("href", PORTFOLIO);
    await expect(portfolio).not.toHaveAttribute("target", /.+/); // same tab
    await expect(portfolio).toHaveAccessibleName(/Kurt Matthew Nudo's portfolio/);
    const footer = page.getByRole("contentinfo");
    await expect(footer).toContainText("A project by Kurt Matthew Nudo · krtmtthw.dev");
    await expect(footer.getByRole("link", { name: "Kurt Matthew Nudo · krtmtthw.dev" })).toHaveAttribute("href", PORTFOLIO);

    if (p.path !== "/") {
      await brand.click();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Replay any typhoon, hour by hour");
    }
  });
}

test("storm page: breadcrumbs Home › Storms › storm, and back to all storms", async ({ page }) => {
  await page.goto(`/storm/${HAIYAN}?t=${PEAK}`);
  await waitForReplay(page);
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumbs.getByRole("listitem").filter({ hasNotText: /^$/ })).toHaveText(["Home", "Storms", "Haiyan (Yolanda) 2013"]);
  await expect(crumbs.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  await expect(crumbs.getByRole("link", { name: "Storms" })).toHaveAttribute("href", "/storms");
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText("Haiyan (Yolanda) 2013");

  await page.getByRole("link", { name: "Back to all storms" }).click();
  await expect(page).toHaveURL(/\/storms$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Storms");

  await page.goto(`/storm/${HAIYAN}`);
  await crumbs.getByRole("link", { name: "Home" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("404 pages have a way home", async ({ page }) => {
  for (const path of ["/no/such/page", "/storm/1999001N00000"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "This page blew away" })).toBeVisible();
    await page.getByRole("link", { name: "Go to the home page" }).click();
    await expect(page).toHaveURL(/\/$/);
  }
});

test("storm load error offers retry, the catalogue and home", async ({ page }) => {
  // A 500 for the storm summary is a load error, not a 404.
  await page.route(/\/storms\/2013306N07162\/summary\.json/, (r) => r.fulfill({ status: 500, body: "boom" }));
  await page.goto(`/storm/${HAIYAN}`);
  await expect(page.getByRole("heading", { name: "This storm could not be loaded" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to all storms" })).toHaveAttribute("href", "/storms");
  await page.getByRole("link", { name: "Go to the home page" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("every API blocked: the town page still works and has the header nav", async ({ page }) => {
  await page.route("**/api/**", (r) => r.abort());
  await page.goto("/town?q=tacloban&place=PH-0831600000");
  await expect(page.getByTestId("town-hits")).toContainText("Haiyan (Yolanda) 2013");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("Japanese: home, breadcrumbs and portfolio links are translated", async ({ page }) => {
  await page.goto(`/storm/${HAIYAN}?lang=ja`);
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("link", { name: "Typhoon Replay ホーム" })).toHaveAttribute("href", "/");
  const crumbs = page.getByRole("navigation", { name: "パンくずリスト" });
  await expect(crumbs.getByRole("link", { name: "ホーム", exact: true })).toHaveAttribute("href", "/");
  await expect(crumbs.getByRole("link", { name: "台風", exact: true })).toHaveAttribute("href", "/storms");
  await expect(page.getByRole("link", { name: "台風の一覧に戻る" })).toBeVisible();
  await expect(page.getByRole("banner").getByRole("link", { name: /Kurt Matthew Nudo のポートフォリオ/ })).toHaveAttribute("href", PORTFOLIO);
  await expect(page.getByRole("contentinfo")).toContainText("制作: Kurt Matthew Nudo · krtmtthw.dev");
});

test("?lang=ja over a saved English choice never paints English", async ({ page }) => {
  // A visitor who chose English before opens a Japanese share link: <html lang> and the header are Japanese from the
  // first paint (public/lang-init.js), never flipped from English after mount.
  await page.addInitScript(() => {
    const w = window as unknown as { __langs: string[] };
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("lang", "en");
      sessionStorage.setItem("seeded", "1");
    }
    w.__langs = [];
    // Every <html lang> change, and any moment the English "Main" navigation is in the DOM.
    new MutationObserver((records) => {
      for (const r of records) if (r.type === "attributes") w.__langs.push((r.target as HTMLElement).lang);
      if (document.querySelector('nav[aria-label="Main"]')) w.__langs.push("en-nav");
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] });
  });
  await page.goto("/storms?lang=ja");
  await expect(page.getByRole("navigation", { name: "メイン" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  const langs = await page.evaluate(() => (window as unknown as { __langs: string[] }).__langs);
  expect(langs.filter((l) => l !== "ja")).toEqual([]);
});

test.describe("360 px", () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });
  for (const lang of ["en", "ja"]) {
    test(`home and portfolio links are visible without horizontal scroll (${lang})`, async ({ page }) => {
      await page.goto(`/storms?lang=${lang}`);
      await page.waitForLoadState("networkidle");
      const nav = page.getByRole("navigation", { name: lang === "ja" ? "メイン" : "Main" });
      await expect(nav.getByRole("link", { name: lang === "ja" ? "ホーム" : "Home", exact: true })).toBeVisible();
      await expect(page.getByTestId("portfolio-link").locator("visible=true")).toHaveAttribute("href", PORTFOLIO);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
