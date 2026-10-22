#!/usr/bin/env node
// Builds the /embed view krtmtthw.dev iframes: Haiyan's richest moments over the Philippines, chosen from the data and
// shown in turn, each captioned (CLAUDE.md rule 27).
//
//   public/embed-data/haiyan-<hash>.json         the one packed data file: the storm summary (trimmed), its track,
//                                                the .tyf header and the lossless field frame of every moment
//   public/embed-data/haiyan-{base,labels}-{light,dark}-<hash>.webp
//                                                the basemap baked at 2x of the map box: everything under the field
//                                                (base) and the place labels drawn above it (labels, transparent)
//   src/embed/haiyan.generated.ts                file names, view, the moments and their facts, the densest moment,
//                                                and the images' corner coordinates
//   embed/storm/<sid>.html                       its <link rel=preload> points at the packed file
//
// The moments (selectMoments below): every hour whose best-track centre lies inside the baked view (3° in from its
// edges) is a candidate. Facts are taken from the data in this priority: the lifetime peak (best-track wind), each
// landfall, the end of the fastest 24 h strengthening, then the strongest ERA5 wind, gust and rain near the centre
// (the summary's per-frame series, within 2° of the centre) and the widest ERA5 gale-force area (34 kt or more, from
// the lossless frames). The peak and each landfall start a moment of their own; any other fact within 3 h of a
// moment already chosen joins the nearest one, otherwise it starts a new one, up to MAX_MOMENTS. The moments play in
// time order. The densest one, shown still under reduced motion, has the most facts,
// then the wider gale-force area.
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

// The view, framed on the Philippines; the basemap is drawn at one hour (it has no field, so any hour will do).
const SID = "2013306N07162";
const T = "2013-11-07T21:00Z";
const MAX_MOMENTS = 6;
const MERGE_HOURS = 3;
const VIEW_INSET_DEG = 3;
const GALE_MS = 17.5; // 34 kt
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

// --- basemap ------------------------------------------------------------------------------------------------
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const images = {};
let corners, attribution;
for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const q = new URLSearchParams({ t: T, v: `${VIEW.lon},${VIEW.lat},${VIEW.zoom}`, layer: "none", particles: "false", track: "false", lang: "en" });
  await page.goto(`${APP}/storm/${SID}?${q}`, { waitUntil: "load" });
  await page.waitForFunction(() => (window.__trMaps ?? []).some((m) => m.isStyleLoaded()), null, { timeout: 30000 });
  const shot = async (part) =>
    page.evaluate(async (part) => {
      const map = window.__trMaps.at(-1);
      const style = map.getStyle();
      const own = new Set(["era5-field", "track-line", "track-fixes", "current"]);
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

// --- data ---------------------------------------------------------------------------------------------------
const base = slash(config.data.baseUrl);
const ptr = await (await get(base + config.data.pointer)).json();
const root = base + slash(ptr.path ?? `v${ptr.version}`);
const stormDir = `${root}storms/${SID}/`;
const summary = await (await get(stormDir + "summary.json")).json();
const track = await (await get(stormDir + "track.json")).json();

const fr = summary.frames;
if (!fr?.path || !fr.headerBytes || !fr.frameBytes) throw new Error("summary.frames has no .tyf (path, headerBytes, frameBytes)");
const tyfUrl = new URL(fr.path, stormDir).href;

async function range(from, length) {
  const res = await get(tyfUrl, { headers: { Range: `bytes=${from}-${from + length - 1}` } });
  const buf = Buffer.from(await res.arrayBuffer());
  return res.status === 206 ? buf : buf.subarray(from, from + length); // a host that ignores ranges
}
const header = await range(0, fr.headerBytes);
if (header.subarray(0, 4).toString() !== "TYF1") throw new Error("not a TYF1 file");
const tyf = JSON.parse(header.subarray(8, 8 + header.readUInt32LE(4)).toString());

// Candidate hours: the best-track centre inside the baked view, VIEW_INSET_DEG in from its edges.
const lons = corners.map((c) => c[0]);
const lats = corners.map((c) => c[1]);
const box = { w: Math.min(...lons) + VIEW_INSET_DEG, e: Math.max(...lons) - VIEW_INSET_DEG, s: Math.min(...lats) + VIEW_INSET_DEG, n: Math.max(...lats) - VIEW_INSET_DEG };
const hours = track.hours;
if (hours.length !== tyf.time.length || hours.some((h, i) => h.t !== tyf.time[i])) throw new Error("track hours and frames differ");
const inView = (i) => {
  const h = hours[i];
  return !!h && h.lon >= box.w && h.lon <= box.e && h.lat >= box.s && h.lat <= box.n;
};
const candidates = hours.map((_, i) => i).filter(inView);
if (!candidates.length) throw new Error("the storm never enters the view");
const [i0, i1] = [candidates[0], candidates.at(-1)];

// The lossless frames of every candidate hour (one range request), for the gale-force area.
const block = await range(fr.headerBytes + i0 * fr.frameBytes, (i1 - i0 + 1) * fr.frameBytes);
const frameAt = (i) => block.subarray((i - i0) * fr.frameBytes, (i - i0 + 1) * fr.frameBytes);
const windVar = tyf.vars.findIndex((v) => v.name === "wind");
if (windVar < 0 || tyf.vars[windVar].encoding !== "linear") throw new Error("no linear wind variable");
const CELL_KM = tyf.res_deg * 111.195;
function galeKm2(i) {
  const { nx, ny, nodata } = tyf;
  const { scale, offset } = tyf.vars[windVar];
  const f = frameAt(i);
  let km2 = 0;
  for (let r = 0; r < ny; r++) {
    const cos = Math.cos(((tyf.nw_lat[i] - r * tyf.res_deg) * Math.PI) / 180);
    for (let c = 0; c < nx; c++) {
      const q = f[windVar * nx * ny + r * nx + c];
      if (q !== nodata && offset + q * scale >= GALE_MS) km2 += CELL_KM * CELL_KM * cos;
    }
  }
  return Math.round(km2 / 1000) * 1000;
}

const iso = (t) => new Date(t * 1000).toISOString().replace(/:00\.000Z$/, "Z");
const hourOf = (isoTime) => Math.round((Date.parse(isoTime) / 1000 - tyf.time[0]) / 3600);
/** The candidate with the largest (or smallest) value of `get`, the first on ties; undefined when none has one. */
function best(get, mode = "max") {
  let out;
  for (const i of candidates) {
    const v = get(i);
    if (v == null || !Number.isFinite(v)) continue;
    if (out === undefined || (mode === "max" ? v > out.v : v < out.v)) out = { i, v };
  }
  return out;
}

function selectMoments() {
  const facts = []; // in priority order
  const peak = summary.peak;
  if (peak?.at && inView(hourOf(peak.at))) {
    const agency = summary.intensity?.find((x) => x.agency === peak.agency);
    facts.push({ i: hourOf(peak.at), fact: { kind: "peak", t: peak.at, kt: peak.windKt, agency: peak.agency, minutes: agency?.windAveragingMinutes, hpa: peak.pressureHpa } });
  }
  for (const l of summary.landfalls ?? []) {
    const i = hourOf(l.at);
    if (inView(i)) facts.push({ i, fact: { kind: "landfall", t: l.at, place: l.placeName } });
  }
  const ri = summary.stats?.maxIntensificationEndedAt;
  if (ri && summary.stats.maxIntensification24hKt && inView(hourOf(ri)))
    facts.push({ i: hourOf(ri), fact: { kind: "strengthening", t: ri, kt: summary.stats.maxIntensification24hKt } });
  const series = fr.series ?? {};
  for (const [kind, key, unit] of [
    ["era5Wind", "era5MaxWindMs", "ms"],
    ["era5Gust", "era5MaxGustMs", "ms"],
    ["era5Rain", "era5MaxRainMmh", "mmh"],
  ]) {
    const b = series[key] && best((i) => series[key][i]);
    if (b) facts.push({ i: b.i, fact: { kind, t: iso(tyf.time[b.i]), [unit]: +b.v.toFixed(1) } });
  }
  const gale = best(galeKm2);
  if (gale) facts.push({ i: gale.i, fact: { kind: "gale", t: iso(tyf.time[gale.i]), km2: gale.v } });

  const moments = [];
  // The peak and each landfall anchor a moment of their own; the other facts join the nearest moment within MERGE_HOURS.
  const anchor = (f) => f.kind === "peak" || f.kind === "landfall";
  for (const { i, fact } of facts) {
    const near = anchor(fact)
      ? undefined
      : moments.filter((m) => Math.abs(m.i - i) <= MERGE_HOURS).sort((a, b) => Math.abs(a.i - i) - Math.abs(b.i - i))[0];
    if (near) near.facts.push(fact);
    else if (moments.length < MAX_MOMENTS) moments.push({ i, facts: [fact] });
  }
  moments.sort((a, b) => a.i - b.i);
  for (const m of moments) {
    m.t = iso(tyf.time[m.i]);
    m.galeKm2 = galeKm2(m.i);
  }
  let densest = 0;
  moments.forEach((m, k) => {
    const d = moments[densest];
    if (m.facts.length > d.facts.length || (m.facts.length === d.facts.length && m.galeKm2 > d.galeKm2)) densest = k;
  });
  return { moments, densest };
}
const { moments, densest } = selectMoments();
for (const [k, m] of moments.entries()) console.log(`moment ${k + 1}${k === densest ? " (densest)" : ""}: ${m.t} ${m.facts.map((f) => f.kind).join(", ")}`);

// The page needs the heading, the intensity panel and the replay: drop the big parts it never reads.
const { affectedPlaces: _p, ...detail } = summary;
const { field: _f, exact: _e, ...frames } = fr;
const pack = {
  schema: "typhoon-replay/embed@2",
  sid: SID,
  datasetVersion: ptr.version,
  detail: { ...detail, frames },
  track: { fixes: track.fixes, hours: track.hours },
  tyf: { header: header.toString("base64"), frames: moments.map((m) => ({ index: m.i, data: Buffer.from(frameAt(m.i)).toString("base64") })) },
};

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

writeFileSync(
  join(web, "src/embed/haiyan.generated.ts"),
  `// Generated by scripts/build-embed.mjs (do not edit): the embed's view, its moments and its hashed files in public/embed-data.
export const EMBED = ${JSON.stringify(
    {
      sid: SID,
      view: VIEW,
      pack: packUrl,
      moments: moments.map(({ t, facts }) => ({ t, facts })),
      densest,
      mapSize: [w, h],
      basemap: {
        coordinates: corners,
        attribution,
        light: { base: img["base-light"], labels: img["labels-light"] },
        dark: { base: img["base-dark"], labels: img["labels-dark"] },
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
console.log(`pack ${packUrl}: ${(packBuf.length / 1024).toFixed(0)} kB (${moments.length} frames, dataset v${ptr.version})`);
