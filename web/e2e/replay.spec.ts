import { expect, HAIYAN, PEAK, test, waitForReplay } from "./fixtures";

test.describe("keyboard replay control", () => {
  test("space plays and pauses; arrows, PageUp/PageDown, Home/End move the hour", async ({ page }) => {
    await page.goto(`/storm/${HAIYAN}?t=${PEAK}`);
    await waitForReplay(page);
    const scrubber = page.getByTestId("scrubber");
    await expect(scrubber).toHaveValue("36");
    await page.locator("body").click({ position: { x: 5, y: 300 } });

    await page.keyboard.press("ArrowRight");
    await expect(scrubber).toHaveValue("37");
    await expect(page).toHaveURL(/t=2013-11-07T13(%3A|:)00Z/);
    await page.keyboard.press("PageDown");
    await expect(scrubber).toHaveValue("31");
    await page.keyboard.press("End");
    await expect(scrubber).toHaveValue("71");
    await page.keyboard.press("Home");
    await expect(scrubber).toHaveValue("0");

    await page.keyboard.press("Space");
    await expect(page.getByTestId("play-toggle")).toHaveAccessibleName("Pause replay");
    await expect.poll(async () => Number(await scrubber.inputValue())).toBeGreaterThan(0);
    await page.keyboard.press("k");
    await expect(page.getByTestId("play-toggle")).toHaveAccessibleName("Play replay");
  });

  test("the scrubber is an APG slider with a spoken value", async ({ page }) => {
    await page.goto(`/storm/${HAIYAN}?t=${PEAK}`);
    await waitForReplay(page);
    const scrubber = page.getByRole("slider", { name: "Replay time" });
    await expect(scrubber).toHaveAttribute("aria-valuetext", /7 Nov 2013, 20:00 GMT\+8, 170 kt JTWC, 895 hPa/);
    await scrubber.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(scrubber).toHaveValue("35");
    await expect(scrubber).toHaveAttribute("aria-valuetext", /interpolated/);
    await page.keyboard.press("PageUp");
    await expect(scrubber).toHaveValue("41");
  });

  test("timeline table rows move the replay", async ({ page }) => {
    await page.goto(`/storm/${HAIYAN}?t=${PEAK}`);
    await waitForReplay(page);
    await page.getByTestId("timeline-table").getByRole("button", { name: /8 Nov, 08:00/ }).click();
    await expect(page.getByTestId("scrubber")).toHaveValue("48");
  });
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("no autoplay on the home page and particles start off (static raster)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("play-toggle")).toHaveAccessibleName("Play replay");
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("scrubber")).toHaveValue("0");
    await page.goto(`/storm/${HAIYAN}?t=${PEAK}`);
    await waitForReplay(page);
    await expect(page.getByRole("switch", { name: "Wind particles" })).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText(/reduced motion/)).toBeVisible();
  });
});

test("without reduced motion the home replay autoplays", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("play-toggle")).toHaveAccessibleName("Pause replay");
});
