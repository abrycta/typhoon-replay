import { test as base, expect, type Page } from "@playwright/test";

export const HAIYAN = "2013306N07162";
export const RAI = "2021346N05145";
/** Haiyan's JTWC peak (frame inside the 72 h fixture window). */
export const PEAK = "2013-11-07T12:00Z";

export const test = base.extend<{ page: Page }>({
  page: async ({ page }, use) => {
    await page.route(/huggingface\.co|hf\.co/, (r) => r.fulfill({ status: 404, body: "not found" }));
    await page.route(/tiles\.openfreemap\.org/, (r) => r.abort());
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await use(page);
    expect(errors, "uncaught page errors").toEqual([]);
  },
});

export { expect };

/** Wait until the storm page's replay has its first frames (the ERA5 panel shows a number). */
export async function waitForReplay(page: Page) {
  await expect(page.getByTestId("storm-replay")).toBeVisible();
  await expect(page.getByTestId("era5-wind")).toContainText(/m\/s|kt/);
}
