// Bundled storms (scripts/bundle-data.mjs): the build copies the hot storms' replay files into dist/data and
// names them in config.json. Such a storm plays from the site itself, with no request to the dataset host for its
// files and none for the pointer before its first file.
import { expect, test } from "@playwright/test";

import { HAIYAN, waitForReplay } from "./fixtures";

test("a bundled storm plays from the site's own copy", async ({ page, request }) => {
  const cfg = (await (await request.get("/config.json")).json()) as {
    data: { bundle?: { version: number; path: string; storms: string[] } };
  };
  const bundle = cfg.data.bundle;
  test.skip(!bundle?.storms.includes(HAIYAN), "this build bundled no data (dataset host unreachable at build time)");

  const remote: string[] = [];
  const local: string[] = [];
  // The dataset host only answers the pointer, with the bundled version: everything else must come from /data/.
  await page.route(/huggingface\.co|hf\.co/, (r) => {
    const url = r.request().url();
    remote.push(url);
    return url.endsWith("/latest.json")
      ? r.fulfill({ json: { version: bundle!.version, path: bundle!.path } })
      : r.fulfill({ status: 404, body: "not found" });
  });
  await page.route(/tiles\.openfreemap\.org/, (r) => r.abort());
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/data/")) local.push(new URL(r.url()).pathname);
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`/storm/${HAIYAN}`);
  await waitForReplay(page);

  expect(local).toContain(`/data/${bundle!.path}storms/${HAIYAN}/summary.json`);
  expect(local.some((p) => p.startsWith(`/data/frames/${HAIYAN}/`) && p.endsWith(".field.wind.webp"))).toBe(true);
  expect(remote.filter((u) => u.includes(`/storms/${HAIYAN}/`) || u.includes(`/frames/${HAIYAN}/`))).toEqual([]);
  expect(errors).toEqual([]);
});
