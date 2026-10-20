import { expect, HAIYAN, PEAK, test, waitForReplay } from "./fixtures";

test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true });

for (const path of ["/", `/storm/${HAIYAN}?t=${PEAK}`, "/storms", `/compare?a=${HAIYAN}&b=2021346N05145`, "/town?backend=mock", "/about"]) {
  test(`360 px: no horizontal page scroll on ${path}`, async ({ page }) => {
    await page.goto(path);
    if (path.startsWith("/storm/")) await waitForReplay(page);
    else await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("360 px: replay controls are usable by touch", async ({ page }) => {
  await page.goto(`/storm/${HAIYAN}?t=${PEAK}`);
  await waitForReplay(page);
  await page.getByRole("button", { name: "Forward one hour" }).tap();
  await expect(page.getByTestId("scrubber")).toHaveValue("37");
  const box = await page.getByTestId("play-toggle").boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(24); // WCAG 2.2 target size (minimum)
});
