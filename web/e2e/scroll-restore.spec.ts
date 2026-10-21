import type { Page } from "@playwright/test";

import { expect, HAIYAN, PEAK, test, waitForReplay } from "./fixtures";

// Back/Forward and #section links on pages whose content arrives after they render (src/app/scroll-settle.ts).

/** Hold the storm's data back a little, as a slow network does, so the page is short when the router restores. */
async function slowStormData(page: Page, ms = 1200) {
  await page.route(/\/fixtures\/v1\/(storms\/|index\.json)/, async (r) => {
    await new Promise((res) => setTimeout(res, ms));
    await r.fallback();
  });
}

const near = (page: Page, y: number) => expect.poll(() => page.evaluate(() => Math.round(window.scrollY)), { timeout: 10_000 }).toBeGreaterThan(y - 30);

for (const vp of [
  { name: "desktop", viewport: { width: 1280, height: 900 }, phone: false },
  { name: "phone", viewport: { width: 375, height: 667 }, phone: true },
]) {
  test.describe(vp.name, () => {
    test.use({ viewport: vp.viewport, hasTouch: vp.phone, isMobile: vp.phone });

    test("storm page: Back from a full-page navigation returns to the old position", async ({ page }) => {
      await page.goto(`/storm/${HAIYAN}?t=${PEAK}`);
      await waitForReplay(page);
      await page.evaluate(() => window.scrollTo(0, 900));
      await page.waitForTimeout(200);
      const y = await page.evaluate(() => Math.round(window.scrollY));
      expect(y).toBeGreaterThan(800);
      await slowStormData(page);
      await page.goto("/about"); // a new document, as when leaving for krtmtthw.dev and coming back
      await page.goBack();
      await near(page, y);
      expect(Math.abs((await page.evaluate(() => window.scrollY)) - y)).toBeLessThanOrEqual(30);
      await page.goForward();
      await page.goBack();
      await near(page, y);
    });

    test("storm list: Back from a storm returns to the old position", async ({ page }) => {
      await page.goto("/storms");
      await expect(page.locator(`a[href^="/storm/"]`).first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1000); // a reader scrolls once the list has settled
      const max = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
      test.skip(max < 300, "list too short to scroll at this size");
      const target = Math.min(600, max - 10);
      await page.evaluate((t) => window.scrollTo(0, t), target);
      await page.waitForTimeout(200);
      const y = await page.evaluate(() => Math.round(window.scrollY));
      await slowStormData(page);
      await page.goto(`/storm/${HAIYAN}`);
      await page.goBack();

      await near(page, y);
    });

    test("a link to a storm page's #section lands it just under the Header (or scrolls to the end), once the page has loaded", async ({ page }) => {
      await slowStormData(page, 800);
      await page.goto(`/storm/${HAIYAN}#sources-h`);
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              const h = document.querySelector("header[data-akari-header]")!;
              const strip = h.querySelector('[data-slot="app-header-strip"]')!;
              const under = h.hasAttribute("data-compact") ? strip.getBoundingClientRect().bottom + 15 : h.getBoundingClientRect().bottom;
              const t = document.getElementById("sources-h");
              if (!t) return 9999;
              // Near the end of the page the browser can only scroll to the bottom: then it must be at the bottom.
              const atBottom = Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 1;
              const top = t.getBoundingClientRect().top;
              return atBottom && top >= under - 2 && top < window.innerHeight ? 0 : Math.round(Math.abs(top - under));
            }),
          { timeout: 10_000 },
        )
        .toBeLessThanOrEqual(2);
    });
  });
}
