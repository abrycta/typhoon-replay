#!/usr/bin/env node
// Cold-cache load timings of a deployed Replay (live, a Pages preview or `vite preview`), against the real
// dataset host: every run is a fresh browser (empty HTTP cache, Cache Storage and connection pool).
//
//   desktop  1366x850, no throttling (the machine's own network)
//   iphone   iPhone 13 emulation, DevTools "Slow 4G" (562.5 ms RTT, 1.44 Mbit/s down, 675 kbit/s up) and 4x CPU;
//            the network profile is applied to the page and to its workers (the frame decode worker fetches
//            the field sheets)
//
// Milestones (ms from navigation start, read in the page):
//   ttfb             the HTML response's headers reached the page (wall clock from the start of navigation; the page's
//                    own responseStart leaves out emulated latency)
//   fcp, lcp         first-contentful-paint, last largest-contentful-paint
//   app              the pre-load glyph is gone (React's first render)
//   frame            the first full frame on the map: basemap, track and the field drawn (the app's
//                    "replay:first-frame-drawn" user-timing mark, set on the map's first idle with a field frame)
//   decoded          the field frame at the playhead is decoded ([data-frame-ready=true]), drawn or not
//   list             first storm card in a storm list
// plus requests and transferred bytes (encoded bodies, page and workers) until the page settles.
//
// Usage: node scripts/measure-load.mjs [--base URL] [--runs 3] [--profiles desktop,iphone]
//        [--pages home,storm,storms] [--json out.json]
// Reports the median of the runs per milestone, and every run.
import { chromium, devices } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: "https://replay.krtmtthw.dev" },
    runs: { type: "string", default: "3" },
    profiles: { type: "string", default: "desktop,iphone" },
    pages: { type: "string", default: "home,storm,storms" },
    json: { type: "string" },
  },
});
const base = args.base.replace(/\/$/, "");
const runs = Number(args.runs);

const PAGES = {
  home: { path: "/", waitFor: ["frame", "list"] },
  storm: { path: "/storm/2013306N07162", waitFor: ["frame"] },
  storms: { path: "/storms", waitFor: ["list"] },
};
const SLOW_4G = { offline: false, latency: 562.5, downloadThroughput: (1.44 * 1e6) / 8, uploadThroughput: (0.675 * 1e6) / 8 };
const PROFILES = {
  desktop: { context: { viewport: { width: 1366, height: 850 }, deviceScaleFactor: 1 }, network: null, cpu: 1 },
  iphone: { context: { ...devices["iPhone 13"] }, network: SLOW_4G, cpu: 4 },
};

// Runs in the page before any of its scripts: records milestones on performance.now().
function probe() {
  const m = (window.__m = {});
  const at = (k) => m[k] ?? (m[k] = Math.round(performance.now()));
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (e.name === "first-contentful-paint") m.fcp = Math.round(e.startTime);
  }).observe({ type: "paint", buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) m.lcp = Math.round(e.startTime);
  }).observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (e.name === "replay:first-frame-drawn") m.frame ??= Math.round(e.startTime);
  }).observe({ type: "mark", buffered: true });
  const check = () => {
    if (!document.querySelector(".glyph-seal") && document.getElementById("root")?.childElementCount) at("app");
    if (document.querySelector('[data-frame-ready="true"]')) at("decoded");
    if (document.querySelector('ul[role="list"] > li a[href^="/storm/"]')) at("list");
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-frame-ready", "class"] });
}

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : undefined;
};

async function once(profile, page) {
  const p = PROFILES[profile];
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const ctx = await browser.newContext(p.context);
  let requests = 0, bytes = 0, workers = 0;
  const pending = [];
  ctx.on("requestfinished", (r) => {
    requests++;
    pending.push(r.sizes().then((s) => (bytes += s.responseBodySize + s.responseHeadersSize), () => {}));
  });
  const tab = await ctx.newPage();
  await tab.addInitScript(probe);
  const cdp = await ctx.newCDPSession(tab);
  if (p.cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: p.cpu });
  if (p.network) {
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", p.network);
    // Workers have their own targets: throttle them as they start (paused until then).
    await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
    cdp.on("Target.attachedToTarget", async ({ sessionId, targetInfo }) => {
      const send = (method, params = {}) =>
        cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: Math.floor(Math.random() * 1e9), method, params }) }).catch(() => {});
      if (targetInfo.type === "worker") {
        workers++;
        await send("Network.enable");
        await send("Network.emulateNetworkConditions", p.network);
      }
      await send("Runtime.runIfWaitingForDebugger");
    });
  }
  const want = PAGES[page].waitFor;
  const limit = p.network ? 120_000 : 60_000;
  const start = Date.now();
  let ttfb;
  tab.once("response", () => (ttfb = Date.now() - start));
  await tab.goto(base + PAGES[page].path, { waitUntil: "load", timeout: limit });
  const t0 = Date.now();
  await tab
    .waitForFunction((keys) => keys.every((k) => window.__m[k] !== undefined), want, { timeout: limit, polling: 100 })
    .catch(() => {});
  // Settle: LCP and late requests (exact sheets, tiles) for a short while after the last milestone.
  await tab.waitForTimeout(Math.min(5000, Math.max(2000, (Date.now() - t0) / 4)));
  const m = await tab.evaluate(() => window.__m);
  await Promise.all(pending);
  await browser.close();
  return { ...m, ttfb, requests, kb: Math.round(bytes / 1024), throttledWorkers: p.network ? workers : undefined };
}

const KEYS = ["ttfb", "fcp", "app", "lcp", "decoded", "frame", "list", "requests", "kb"];
const out = { base, date: new Date().toISOString(), runs, results: {} };
for (const profile of args.profiles.split(",")) {
  for (const page of args.pages.split(",")) {
    const samples = [];
    for (let i = 0; i < runs; i++) samples.push(await once(profile, page));
    const med = Object.fromEntries(KEYS.map((k) => [k, median(samples.map((s) => s[k]))]));
    out.results[`${profile}/${page}`] = { median: med, samples };
    const fmt = (k) => (med[k] === undefined ? "-" : String(med[k]));
    console.log(
      `${`${profile}/${page}`.padEnd(15)} ` + KEYS.map((k) => `${k} ${fmt(k)}`).join(" · ") +
        ` · workers ${samples.map((s) => s.throttledWorkers ?? "-").join("/")}` + `   [frame runs: ${samples.map((s) => s.frame ?? "-").join(", ")}; list runs: ${samples.map((s) => s.list ?? "-").join(", ")}]`,
    );
  }
}
if (args.json) writeFileSync(args.json, JSON.stringify(out, null, 2) + "\n");
