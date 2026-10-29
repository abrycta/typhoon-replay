import type { Page } from "@playwright/test";

import { expect, HAIYAN, PEAK, test, waitForReplay } from "./fixtures";

// Akari's Header strip mirrors the storm page's breadcrumb once the page's own has scrolled away (Akari 0.11).
// The full device matrix is run by hand before releases; here, one desktop and one phone.

const header = (page: Page) => page.locator("header[data-akari-header]");

async function trackCls(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) w.__cls += e.value;
    }).observe({ type: "layout-shift" });
  });
}

async function scrollAndCheck(page: Page, y: number) {
  await page.evaluate((y) => window.scrollTo(0, y), y);
  const past = await page.evaluate(() => {
    const h = document.querySelector("header[data-akari-header]")!;
    const line = h.hasAttribute("data-compact") ? 44 : h.getBoundingClientRect().height;
    return document.querySelector('[data-testid="breadcrumb"]')!.getBoundingClientRect().bottom <= line + 1;
  });
  await expect(header(page)).toHaveAttribute("data-crumbs", past ? "pinned" : "ready");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

for (const vp of [
  { name: "desktop", viewport: { width: 1280, height: 900 }, phone: false, height: 81 },
  { name: "phone", viewport: { width: 375, height: 667 }, phone: true, height: 154 }, // six nav items wrap onto two lines,
]) {
  test.describe(vp.name, () => {
    test.use({ viewport: vp.viewport, hasTouch: vp.phone, isMobile: vp.phone });

    test("storm page: the strip shows Home ⟶ Storms ⟶ storm once the breadcrumb scrolls away, and back; CLS 0", async ({ page }) => {
      await page.goto(`/storm/${HAIYAN}?t=${PEAK}`);
      await waitForReplay(page);
      const h = header(page);
      const restHeight = await h.evaluate((el) => el.getBoundingClientRect().height);
      expect(Math.round(restHeight)).toBe(vp.height);
      await expect(h).toHaveAttribute("data-crumbs", "ready");
      // Measure the strip, not the page's own loading (skeleton -> storm, places list).
      await expect(page.getByTestId("breadcrumb")).toContainText("Haiyan");
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);
      await trackCls(page);
      for (const y of [40, 120, 200, 900, 6000, 0, 900]) await scrollAndCheck(page, y);
      const strip = page.getByRole("navigation", { name: "You are here" });
      await expect(strip).toBeVisible();
      await expect(strip.getByRole("link", { name: "Storms" })).toHaveAttribute("href", "/storms");
      await expect(strip.locator('[aria-current="page"]')).toHaveText("Haiyan (Yolanda) 2013");
      await expect(page.getByRole("banner").locator("[data-current]")).toHaveCount(1);
      if (vp.phone) expect(Math.abs(await page.locator('[data-slot="app-header-strip"]').evaluate((el) => el.getBoundingClientRect().top))).toBeLessThan(1);
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(h).toHaveAttribute("data-crumbs", "ready");
      expect(await h.evaluate((el) => el.getBoundingClientRect().height)).toBe(restHeight);
      expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls)).toBe(0);
    });

    test("the strip follows client-side navigation: gone on a page without a breadcrumb", async ({ page }) => {
      await page.goto(`/storm/${HAIYAN}?t=${PEAK}`);
      await waitForReplay(page);
      await page.evaluate(() => window.scrollTo(0, 900));
      await expect(header(page)).toHaveAttribute("data-crumbs", "pinned");
      // Wait for the 150 ms swap-in (opacity and translate) to finish, then click like a mouse does. A locator click
      // first scrolls the link "into view"; with the Header's scroll-padding that scrolls the page back up to the
      // breadcrumb, which unpins the strip and hides the link for good (flaky on CI, twice on 2026-10-29).
      await expect(page.locator('[data-slot="app-header-crumbs"]')).toHaveCSS("opacity", "1");
      const box = await page.getByRole("navigation", { name: "You are here" }).getByRole("link", { name: "Storms" }).boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await expect(page).toHaveURL(/\/storms$/);
      await expect(header(page)).not.toHaveAttribute("data-crumbs");
    });
  });
}
