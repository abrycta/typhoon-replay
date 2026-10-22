#!/usr/bin/env node
// Post-build: write static share shells and the sitemap from the storm index.
//
//   dist/storm/<sid>.html   copy of index.html with the storm's <title>, description, canonical, Open Graph
//                           and Twitter tags plus a <noscript> summary (social crawlers don't run JS).
//                           Cloudflare Pages serves /storm/<sid> from storm/<sid>.html without a redirect.
//   dist/<page>.html        the same for /storms, /compare, /town, /about and /under-the-hood, so each page's
//                           canonical names itself (index.html, the SPA fallback, names the home page)
//   dist/sitemap.xml, dist/robots.txt
//
// Preload hints (audit 2026-10-22, finding 1): the home and storm shells name the files the replay needs before
// the app asks for them, so they download while the entry chunk runs instead of one after another: the route's
// chunks (Vite's manifest, dist/.vite/manifest.json, deleted afterwards), and the storm's
// summary.json and track.json at the data version the app starts with (the bundled copy, scripts/bundle-data.mjs,
// when the storm is bundled). If the live version has moved on, the app simply doesn't use them.
//
// The index comes from the published dataset when reachable (config.json data.baseUrl + pointer), else from
// the bundled fixture (web/fixtures). Env: SITE_URL overrides config.json siteUrl; STAMP_OFFLINE=1 skips the
// network. The build never fails because the dataset host is down.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const web = resolve(import.meta.dirname, "..");
const dist = join(web, "dist");
const config = JSON.parse(readFileSync(join(web, "public/config.json"), "utf8"));
const site = (process.env.SITE_URL ?? config.siteUrl ?? "https://replay.krtmtthw.dev").replace(/\/$/, "");
const slash = (s) => (s.endsWith("/") ? s : `${s}/`);

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const pointerPath = (p) => (typeof p?.path === "string" ? slash(p.path) : p?.version ? `v${p.version}/` : "v1/");

async function loadIndex() {
  if (!process.env.STAMP_OFFLINE) {
    try {
      const base = slash(config.data.baseUrl);
      const root = base + pointerPath(await getJson(base + (config.data.pointer ?? "latest.json")));
      const idx = await getJson(root + "index.json");
      return { storms: Array.isArray(idx) ? idx : idx.storms, root, source: "dataset" };
    } catch (e) {
      console.warn(`stamp-shells: dataset unreachable (${e.message}); using web/fixtures`);
    }
  }
  const fx = join(web, "fixtures");
  const path = pointerPath(JSON.parse(readFileSync(join(fx, "latest.json"), "utf8")));
  const idx = JSON.parse(readFileSync(join(fx, path, "index.json"), "utf8"));
  return { storms: Array.isArray(idx) ? idx : idx.storms, root: `${site}/fixtures/${path}`, source: "fixture" };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const day = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function describe(s) {
  const name = s.localNames?.ph ? `${s.name} (${s.localNames.ph})` : s.name;
  const peak = s.peakWindKt ? `, peak ${Math.round(s.peakWindKt)} kt (${(s.peakWindAgency ?? "").toUpperCase()})` : "";
  const land = s.landfallCountries?.length ? `, landfall in ${s.landfallCountries.map((c) => (c === "PH" ? "the Philippines" : "Japan")).join(" and ")}` : "";
  return {
    title: `${name} ${s.season} · Replay`,
    text: `Replay ${name}, ${day(s.startedAt)} to ${day(s.endedAt)}${peak}${land}: hour by hour wind, rain and pressure from ERA5 beside the best track.`,
  };
}

function headTags({ title, text, url, image }) {
  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(text)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Replay" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(text)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:image" content="${esc(image)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ].join("\n    ");
}

/** Replace the template's <title> and description with the given tags; add a <noscript> summary. */
function stamp(template, tags, noscript) {
  let html = template.replace(/<title>[\s\S]*?<\/title>/, "").replace(/<meta name="description"[^>]*>\s*/, "");
  html = html.replace("</head>", `  ${tags}\n  </head>`);
  if (noscript) html = html.replace(/<div id="root">(?:<div class="glyph-seal"[^>]*>[^<]*<\/div>)?<\/div>/, (m) => `${m}\n    <noscript><p>${esc(noscript)}</p></noscript>`);
  return html;
}

// --- Preload hints ---------------------------------------------------------------------------------------------
const manifestPath = join(dist, ".vite/manifest.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry && k === "index.html");
/** Chunk files (and their CSS) a manifest entry needs, following static imports. */
function closure(key, seen = new Set(), css = new Set()) {
  const m = manifest[key];
  if (!m || seen.has(m.file)) return { js: seen, css };
  seen.add(m.file);
  for (const c of m.css ?? []) css.add(c);
  for (const i of m.imports ?? []) closure(i, seen, css);
  return { js: seen, css };
}
const { js: inEntry, css: inEntryCss } = entryKey ? closure(entryKey) : { js: new Set(), css: new Set() };
function chunkHints(keys) {
  const js = new Set(), css = new Set();
  for (const k of keys) {
    const c = closure(k);
    c.js.forEach((f) => inEntry.has(f) || js.add(f));
    c.css.forEach((f) => inEntryCss.has(f) || css.add(f));
  }
  return [
    ...[...js].map((f) => `<link rel="modulepreload" crossorigin href="/${f}" />`),
    ...[...css].map((f) => `<link rel="preload" as="style" crossorigin href="/${f}" />`),
  ];
}
// The map chunk (MapLibre, ~290 KB on the wire) is left to the route loader, which asks for it as soon as the
// router runs: preloaded from the HTML it shared a slow link with the entry chunk and delayed the first render by
// about a second on a Slow 4G phone (measured on the PR preview).
const homeChunks = chunkHints(["src/routes/index.tsx?tsr-split=component"]);
const stormChunks = chunkHints(["src/routes/storm.$sid.tsx?tsr-split=component"]);
if (!homeChunks.length || !stormChunks.length) console.warn("stamp-shells: no Vite manifest entries for the route chunks; no chunk preloads");

// The data version the app starts with: the bundled one (dist/config.json data.bundle), else whatever the pointer
// names (no data preloads then: the app reads the pointer first anyway).
const runtime = JSON.parse(readFileSync(join(dist, "config.json"), "utf8"));
const bundle = runtime.data?.bundle;
const bundled = new Set(bundle?.storms ?? []);
function dataHints(sid) {
  if (!bundle?.path) return [];
  const dir = bundled.has(sid) ? `${slash(bundle.root)}${bundle.path}storms/${sid}/` : `${slash(runtime.data.baseUrl)}${bundle.path}storms/${sid}/`;
  return ["summary.json", "track.json"].map((f) => `<link rel="preload" as="fetch" crossorigin="anonymous" href="${esc(dir + f)}" />`);
}
const FEATURED = "2013306N07162";

const template = readFileSync(join(dist, "index.html"), "utf8");
const { storms, root, source } = await loadIndex();

const home = {
  title: "Replay",
  text: "Replay any typhoon that hit the Philippines or Japan, hour by hour: ERA5 wind, rain and pressure beside the official best track.",
  url: `${site}/`,
  image: `${site}/og-card.png`,
};
writeFileSync(
  join(dist, "index.html"),
  stamp(template, [headTags(home), ...homeChunks, ...dataHints(FEATURED)].join("\n    "), "Replay needs JavaScript for the interactive replay."),
);
// The app's other pages get their own shell (Pages serves /about from about.html) so each names its own canonical
// URL; index.html stays the SPA fallback for everything else.
for (const page of ["storms", "compare", "town", "about", "under-the-hood"]) {
  writeFileSync(join(dist, `${page}.html`), stamp(template, headTags({ ...home, url: `${site}/${page}` }), home.text));
}

mkdirSync(join(dist, "storm"), { recursive: true });
for (const s of storms) {
  if (!/^[0-9]{7}[NS][0-9]{5}$/.test(s.sid)) continue;
  const d = describe(s);
  const tags = [headTags({ title: d.title, text: d.text, url: `${site}/storm/${s.sid}`, image: `${root}storms/${s.sid}/og.png` }), ...stormChunks, ...dataHints(s.sid)].join(
    "\n    ",
  );
  writeFileSync(join(dist, "storm", `${s.sid}.html`), stamp(template, tags, d.text));
}

const today = new Date().toISOString().slice(0, 10);
const urls = ["/", "/storms", "/compare", "/town", "/about", "/under-the-hood", ...storms.map((s) => `/storm/${s.sid}`)];
writeFileSync(
  join(dist, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${esc(site + u)}</loc><lastmod>${today}</lastmod></url>`)
    .join("\n")}\n</urlset>\n`,
);
// AI training and answer-engine crawlers are kept off the whole app (same list as krtmtthw.dev, Lights and Plumes).
const aiCrawlers = ["GPTBot", "ClaudeBot", "anthropic-ai", "CCBot", "Google-Extended", "Applebot-Extended", "PerplexityBot", "Bytespider",
  "meta-externalagent", "Amazonbot", "cohere-ai", "Diffbot", "Omgilibot", "Timpibot", "ImagesiftBot"];
writeFileSync(
  join(dist, "robots.txt"),
  `User-agent: *\nAllow: /\nDisallow: /api/\n\n${aiCrawlers.map((ua) => `User-agent: ${ua}\n`).join("")}Disallow: /\n\nSitemap: ${site}/sitemap.xml\n`,
);
rmSync(join(dist, ".vite"), { recursive: true, force: true });
console.log(`stamp-shells: ${storms.length} storm shells + sitemap (${urls.length} URLs) from the ${source} index, site ${site}`);
