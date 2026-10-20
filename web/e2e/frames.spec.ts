// Frame formats: WebP sheet sets (preferred) and .tyf, against the bundled fixture (no Hugging Face).
// Haiyan carries both formats, Goni WebP only (scripts/make_webp_fixtures.py).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Page, Route } from "@playwright/test";

import { expect, GONI, HAIYAN, PEAK, test, waitForReplay } from "./fixtures";

type Summary = { frames: Record<string, unknown> & { series?: { era5MaxWindMs: (number | null)[] } } };
const summary = (sid: string) => JSON.parse(readFileSync(resolve(import.meta.dirname, `../fixtures/v1/storms/${sid}/summary.json`), "utf8")) as Summary;

/** Record which frame files the page requests. */
function frameRequests(page: Page) {
  const urls: string[] = [];
  page.on("request", (r) => {
    if (/\.(webp|tyf)(\?|$)/.test(r.url())) urls.push(new URL(r.url()).pathname);
  });
  return {
    webp: (kind: "field" | "exact") => urls.filter((u) => u.includes(`.${kind}.`)),
    tyf: () => urls.filter((u) => u.endsWith(".tyf")),
  };
}

/** Serve a storm's summary.json with its frames record edited. */
async function editFrames(page: Page, sid: string, edit: (frames: Summary["frames"]) => void) {
  await page.route(`**/storms/${sid}/summary.json`, async (route: Route) => {
    const res = await route.fetch();
    const json = (await res.json()) as Summary;
    edit(json.frames);
    await route.fulfill({ response: res, json });
  });
}

const GONI_PEAK = "2020-10-31T18:00Z"; // fixture frame 18 (a 3-hourly exact hour)

test.describe("frame formats", () => {
  test("a WebP-only storm plays from its field sheets, with readouts from the pipeline's series", async ({ page }) => {
    const req = frameRequests(page);
    await page.goto(`/storm/${GONI}?t=${GONI_PEAK}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Goni");
    await waitForReplay(page);
    await expect(page.getByTestId("scrubber")).toHaveValue("18");
    const want = summary(GONI).frames.series!.era5MaxWindMs[18]!;
    await expect(page.getByTestId("era5-wind")).toHaveText(`${want.toFixed(1)} m/s`);
    expect(req.webp("field")).toHaveLength(6);
    expect(req.webp("exact")).toHaveLength(0); // series covers the readouts
    expect(req.tyf()).toHaveLength(0);
    await expect(page.getByText("Field frames could not be loaded")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __trMaps?: { getLayer(id: string): unknown }[] }).__trMaps?.at(-1)?.getLayer("era5-field") !== undefined))
      .toBe(true);
    // Playback moves through decoded frames.
    await page.getByTestId("play-toggle").click();
    await expect.poll(async () => Number(await page.getByTestId("scrubber").inputValue())).toBeGreaterThan(18);
  });

  test("a storm with both formats loads WebP, not the .tyf", async ({ page }) => {
    const req = frameRequests(page);
    await page.goto(`/storm/${HAIYAN}?t=${PEAK}`);
    await waitForReplay(page);
    await expect(page.getByTestId("honesty-ratio")).toContainText("0.31× JTWC");
    expect(req.webp("field")).toHaveLength(6);
    expect(req.tyf()).toHaveLength(0);
  });

  test("a .tyf storm still plays (range requests), with readouts from its lossless frames", async ({ page }) => {
    await editFrames(page, HAIYAN, (f) => {
      for (const k of ["field", "exact", "series", "time", "nwLat", "nwLon"]) delete f[k];
    });
    const req = frameRequests(page);
    await page.goto(`/storm/${HAIYAN}?t=${PEAK}`);
    await waitForReplay(page);
    await expect(page.getByTestId("era5-wind")).toHaveText("27.0 m/s"); // maxNear on the lossless .tyf frame (series says 26.9)
    await expect(page.getByTestId("honesty-ratio")).toContainText("0.31× JTWC");
    expect(req.tyf().length).toBeGreaterThan(0);
    expect(req.webp("field")).toHaveLength(0);
  });

  test("if WebP fails, a storm that also has a .tyf falls back to it", async ({ page }) => {
    await page.route(/\.webp$/, (r) => r.fulfill({ status: 404, body: "gone" }));
    const req = frameRequests(page);
    await page.goto(`/storm/${HAIYAN}?t=${PEAK}`);
    await waitForReplay(page);
    expect(req.tyf().length).toBeGreaterThan(0);
    await expect(page.getByText("Field frames could not be loaded")).toHaveCount(0);
  });

  test("without series, readouts come from the lossless 3-hourly grid and nothing is shown between its hours", async ({ page }) => {
    await editFrames(page, GONI, (f) => delete f.series);
    const req = frameRequests(page);
    await page.goto(`/storm/${GONI}?t=${GONI_PEAK}`);
    await expect(page.getByTestId("storm-replay")).toHaveAttribute("data-frame-ready", "true");
    await expect(page.getByTestId("era5-wind")).toContainText("m/s");
    // The 0.5° grid's maximum sits close to the pipeline's 0.25° value; a broken decode would not.
    const got = Number((await page.getByTestId("era5-wind").textContent())!.replace(/[^\d.]/g, ""));
    expect(Math.abs(got - summary(GONI).frames.series!.era5MaxWindMs[18]!)).toBeLessThan(3);
    await expect(page.getByText("From the lossless 3-hourly grid (0.5°).")).toBeVisible();
    expect(req.webp("exact")).toHaveLength(2);
    await page.getByTestId("scrubber").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("scrubber")).toHaveValue("19");
    await expect(page.getByTestId("era5-none")).toContainText("lossless grid every 3 hours");
  });
});
