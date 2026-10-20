#!/usr/bin/env node
// Dev helper: screenshot app pages with Playwright's Chromium (WebGL via SwiftShader) and print console errors.
// Usage: node scripts/shoot.mjs <baseUrl> <outDir> [path ...]   (env: WIDTH, HEIGHT, SCHEME=dark, WAIT ms)
import { mkdirSync } from "node:fs";

import { chromium } from "@playwright/test";

const [base = "http://localhost:5173", out = "shots", ...paths] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({
  viewport: { width: Number(process.env.WIDTH ?? 1280), height: Number(process.env.HEIGHT ?? 900) },
  colorScheme: process.env.SCHEME === "dark" ? "dark" : "light",
  reducedMotion: process.env.REDUCED ? "reduce" : "no-preference",
});
if (!process.env.NET) await ctx.route(/huggingface\.co/, (r) => r.fulfill({ status: 404, body: "" }));
for (const p of paths.length ? paths : ["/"]) {
  const page = await ctx.newPage();
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && console.log(`[${p}] ${m.type()}: ${m.text().slice(0, 300)}`));
  page.on("pageerror", (e) => console.log(`[${p}] pageerror: ${e.message}`));
  await page.goto(base + p, { waitUntil: "load" }).catch((e) => console.log(`[${p}] goto: ${e.message}`));
  await page.waitForTimeout(Number(process.env.WAIT ?? 2500));
  const name = p.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "home";
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: !!process.env.FULL });
  console.log(`shot ${out}/${name}.png`);
  await page.close();
}
await browser.close();
