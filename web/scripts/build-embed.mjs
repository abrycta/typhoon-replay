#!/usr/bin/env node
// Builds the frozen /embed view (krtmtthw.dev iframes it in place of a screenshot): Haiyan at landfall.
//
//   public/embed-data/haiyan-<hash>.json         the one packed data file: the storm summary (trimmed), its track,
//                                                the .tyf header and the one lossless field frame on show
//   public/embed-data/haiyan-{base,labels}-{light,dark,light-hc,dark-hc}-<hash>.webp
//                                                the basemap baked at 2x of the map box: everything under the field
//                                                (base) and the place labels drawn above it (labels, transparent)
//   src/embed/haiyan.generated.ts                file names, view, time and the images' corner coordinates
//   embed/storm/<sid>.html                       its <link rel=preload> points at the packed file
//
// The data comes from the published dataset (config.json data.baseUrl). The basemap is drawn by the live app
// itself (OpenFreeMap recoloured with Akari's map tokens) in Playwright's Chromium, at the embed's view, with
// the field, track and markers hidden, so it matches the app pixel for pixel.
//
// Usage: node scripts/build-embed.mjs [appUrl=https://replay.krtmtthw.dev]
// Re-run when the storm's data or the basemap style changes, then commit the outputs. Old outputs are removed.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { chromium } from "@playwright/test";

const web = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(join(web, "public/config.json"), "utf8"));
const APP = (process.argv[2] ?? config.siteUrl ?? "https://replay.krtmtthw.dev").replace(/\/$/, "");

// The frozen view, the portfolio screenshot's frame: 21:00 UTC on 7 Nov 2013 (8 Nov 05:00 PHT), interpolated between
// the 18:00 and 00:00 fixes as Haiyan reached Leyte Gulf (first landfall, Dulag, 23:21 UTC), framed on the Philippines.
const SID = "2013306N07162";
const T = "2013-11-07T21:00Z";
const VIEW = { lon: 124.31, lat: 11.17, zoom: 4.6 };
// The map box at the embed's 1440×900 layout (the storm page's map column, 16:10).
const VIEWPORT = { width: 1440, height: 900 };

const outDir = join(web, "public/embed-data");
const slash = (s) => (s.endsWith("/") ? s : `${s}/`);
const hash = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 12);

async function get(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

// --- data ---------------------------------------------------------------------------------------------------
const base = slash(config.data.baseUrl);
const ptr = await (await get(base + config.data.pointer)).json();
const root = base + slash(ptr.path ?? `v${ptr.version}`);
const stormDir = `${root}storms/${SID}/`;
const summary = await (await get(stormDir + "summary.json")).json();
const track = await (await get(stormDir + "track.json")).json();

const fr = summary.frames;
if (!fr?.path || !fr.headerBytes || !fr.frameBytes) throw new Error("summary.frames has no .tyf (path, headerBytes, frameBytes)");
const tUnix = Date.parse(T.replace("Z", ":00Z")) / 1000;
const index = fr.time.indexOf(tUnix);
if (index < 0) throw new Error(`no frame at ${T}`);
const tyfUrl = new URL(fr.path, stormDir).href;

async function range(from, length) {
  const res = await get(tyfUrl, { headers: { Range: `bytes=${from}-${from + length - 1}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  return res.status === 206 ? buf : buf.subarray(from, from + length); // a host that ignores ranges
}
const header = await range(0, fr.headerBytes);
if (header.subarray(0, 4).toString() !== "TYF1") throw new Error("not a TYF1 file");
const frame = await range(fr.headerBytes + index * fr.frameBytes, fr.frameBytes);

// The page needs the heading, the intensity panel and the replay: drop the big parts it never reads.
const { affectedPlaces: _p, ...detail } = summary;
const { field: _f, exact: _e, ...frames } = fr;
const pack = {
  schema: "typhoon-replay/embed@1",
  sid: SID,
  t: T,
  datasetVersion: ptr.version,
  detail: { ...detail, frames },
  track: { fixes: track.fixes, hours: track.hours },
  tyf: { header: header.toString("base64"), frame: { index, data: frame.toString("base64") } },
};

// --- basemap ------------------------------------------------------------------------------------------------
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const images = {};
let corners, attribution;
for (const scheme of ["light", "dark", "light-hc", "dark-hc"]) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: scheme.startsWith("dark") ? "dark" : "light",
    contrast: scheme.endsWith("-hc") ? "more" : "no-preference",
    reducedMotion: "reduce",
  });
  const page = await ctx.newPage();
  const q = new URLSearchParams({ t: T, v: `${VIEW.lon},${VIEW.lat},${VIEW.zoom}`, layer: "none", particles: "false", track: "false", lang: "en" });
  await page.goto(`${APP}/storm/${SID}?${q}`, { waitUntil: "load" });
  await page.waitForFunction(() => (window.__trMaps ?? []).some((m) => m.isStyleLoaded()), null, { timeout: 30000 });
  const shot = async (part) =>
    page.evaluate(async (part) => {
      const map = window.__trMaps.at(-1);
      const style = map.getStyle();
      const own = new Set(["era5-field", "track-line-halo", "track-line", "track-fixes", "current"]);
      for (const l of style.layers) {
        const keep = !own.has(l.id) && (part === "labels" ? l.type === "symbol" : l.type !== "symbol");
        map.setLayoutProperty(l.id, "visibility", keep ? "visible" : "none");
      }
      for (const m of document.querySelectorAll(".maplibregl-marker")) m.remove();
      await new Promise((ok) => map.once("idle", ok));
      const url = await new Promise((ok) => {
        map.once("render", () => ok(map.getCanvas().toDataURL("image/webp", part === "labels" ? 0.92 : 0.86)));
        map.triggerRepaint();
      });
      const c = map.getContainer();
      const [w, h] = [c.clientWidth, c.clientHeight];
      const corners = [map.unproject([0, 0]), map.unproject([w, 0]), map.unproject([w, h]), map.unproject([0, h])].map((p) => [+p.lng.toFixed(6), +p.lat.toFixed(6)]);
      // The basemap's own credit (the app's ERA5/IBTrACS credit comes first, before " | ").
      const attribution = (c.querySelector(".maplibregl-ctrl-attrib-inner")?.textContent ?? "").split(" | ").slice(1).join(" | ");
      return { url, corners, size: [w, h], center: map.getCenter(), zoom: map.getZoom(), attribution };
    }, part);
  for (const part of ["base", "labels"]) {
    const r = await shot(part);
    if (Math.abs(r.zoom - VIEW.zoom) > 1e-6) throw new Error(`map zoom ${r.zoom}, expected ${VIEW.zoom}`);
    corners ??= r.corners;
    attribution ??= r.attribution;
    const buf = Buffer.from(r.url.split(",")[1], "base64");
    images[`${part}-${scheme}`] = { buf, size: r.size };
    console.log(`basemap ${part} ${scheme}: ${r.size.join("×")} css px, ${(buf.length / 1024).toFixed(0)} kB`);
  }
  await ctx.close();
}
await browser.close();

// --- write --------------------------------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.startsWith("haiyan-")) rmSync(join(outDir, f));
const write = (name, ext, buf) => {
  const file = `${name}-${hash(buf)}.${ext}`;
  writeFileSync(join(outDir, file), buf);
  return `/embed-data/${file}`;
};
const packBuf = Buffer.from(JSON.stringify(pack));
const packUrl = write("haiyan", "json", packBuf);
const img = Object.fromEntries(Object.entries(images).map(([k, v]) => [k, write(`haiyan-${k}`, "webp", v.buf)]));
const [w, h] = images["base-light"].size;

const deepLink = `${config.siteUrl.replace(/\/$/, "")}/storm/${SID}?t=${T}&v=${VIEW.lon},${VIEW.lat},${VIEW.zoom}`;
writeFileSync(
  join(web, "src/embed/haiyan.generated.ts"),
  `// Generated by scripts/build-embed.mjs (do not edit): the frozen embed view and its hashed files in public/embed-data.
export const EMBED = ${JSON.stringify(
    {
      sid: SID,
      t: T,
      view: VIEW,
      pack: packUrl,
      deepLink,
      mapSize: [w, h],
      basemap: {
        coordinates: corners,
        attribution,
        light: { base: img["base-light"], labels: img["labels-light"] },
        dark: { base: img["base-dark"], labels: img["labels-dark"] },
        "light-hc": { base: img["base-light-hc"], labels: img["labels-light-hc"] },
        "dark-hc": { base: img["base-dark-hc"], labels: img["labels-dark-hc"] },
      },
    },
    null,
    2,
  )} as const;
`,
);

const htmlPath = join(web, `embed/storm/${SID}.html`);
const html = readFileSync(htmlPath, "utf8").replace(/href="\/embed-data\/haiyan-[0-9a-f]+\.json"/, `href="${packUrl}"`);
writeFileSync(htmlPath, html);
console.log(`pack ${packUrl}: ${(packBuf.length / 1024).toFixed(0)} kB (frame ${index}, dataset v${ptr.version})`);
