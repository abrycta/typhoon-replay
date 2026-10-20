#!/usr/bin/env node
// Measure LCP and time to the first replay frame for key pages of a running build
// (e.g. `npx vite preview --port 4317`), under a mid-range-phone profile:
// 4x CPU slowdown and "Fast 4G"-like network (CDP emulation), 412x915 viewport.
// External hosts are stubbed as in the e2e tests. Usage: node scripts/measure-lcp.mjs [baseUrl] [runs]
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://127.0.0.1:4317";
const runs = Number(process.argv[3] ?? 3);
const pages = { home: "/", storm: "/storm/2013306N07162?t=2013-11-07T12:00Z", storms: "/storms" };

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
for (const [name, path] of Object.entries(pages)) {
  const lcps = [], frames = [];
  for (let i = 0; i < runs; i++) {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true });
    await ctx.route(/huggingface\.co|hf\.co/, (r) => r.fulfill({ status: 404, body: "" }));
    await ctx.route(/tiles\.openfreemap\.org/, (r) => r.abort());
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 });
    await page.addInitScript(() => {
      window.__lcp = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__lcp = e.startTime;
      }).observe({ type: "largest-contentful-paint", buffered: true });
    });
    const t0 = Date.now();
    await page.goto(base + path, { waitUntil: "load" });
    if (name === "storm") {
      // First field frame: the frame at the playhead is decoded (the ERA5 readout alone can come from the summary).
      await page.locator('[data-testid="storm-replay"][data-frame-ready="true"]').waitFor({ timeout: 60000 });
      await page.getByTestId("era5-wind").filter({ hasText: /m\/s/ }).waitFor({ timeout: 60000 });
      frames.push(Date.now() - t0);
    }
    await page.waitForTimeout(1500);
    lcps.push(await page.evaluate(() => window.__lcp));
    await ctx.close();
  }
  console.log(
    `${name.padEnd(6)} LCP median ${Math.round(median(lcps))} ms (runs: ${lcps.map(Math.round).join(", ")})` +
      (frames.length ? ` · first field frame ${Math.round(median(frames))} ms` : ""),
  );
}
await browser.close();
