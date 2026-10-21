#!/usr/bin/env node
// Post-build: write static share shells and the sitemap from the storm index.
//
//   dist/storm/<sid>.html   copy of index.html with the storm's <title>, description, canonical, Open Graph
//                           and Twitter tags plus a <noscript> summary (social crawlers don't run JS).
//                           Cloudflare Pages serves /storm/<sid> from storm/<sid>.html without a redirect.
//   dist/sitemap.xml, dist/robots.txt
//
// The index comes from the published dataset when reachable (config.json data.baseUrl + pointer), else from
// the bundled fixture (web/fixtures). Env: SITE_URL overrides config.json siteUrl; STAMP_OFFLINE=1 skips the
// network. The build never fails because the dataset host is down.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const web = resolve(import.meta.dirname, "..");
const dist = join(web, "dist");
const config = JSON.parse(readFileSync(join(web, "public/config.json"), "utf8"));
const site = (process.env.SITE_URL ?? config.siteUrl ?? "https://typhoon.krtmtthw.dev").replace(/\/$/, "");
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
    title: `${name} ${s.season} · Typhoon Replay`,
    text: `Replay ${name}, ${day(s.startedAt)} to ${day(s.endedAt)}${peak}${land}: hour by hour wind, rain and pressure from ERA5 beside the best track.`,
  };
}

function headTags({ title, text, url, image }) {
  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(text)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Typhoon Replay" />`,
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
  if (noscript) html = html.replace('<div id="root"></div>', `<div id="root"></div>\n    <noscript><p>${esc(noscript)}</p></noscript>`);
  return html;
}

const template = readFileSync(join(dist, "index.html"), "utf8");
const { storms, root, source } = await loadIndex();

const home = {
  title: "Typhoon Replay",
  text: "Replay any typhoon that hit the Philippines or Japan, hour by hour: ERA5 wind, rain and pressure beside the official best track.",
  url: `${site}/`,
  image: `${site}/og-card.png`,
};
writeFileSync(join(dist, "index.html"), stamp(template, headTags(home), "Typhoon Replay needs JavaScript for the interactive replay."));

mkdirSync(join(dist, "storm"), { recursive: true });
for (const s of storms) {
  if (!/^[0-9]{7}[NS][0-9]{5}$/.test(s.sid)) continue;
  const d = describe(s);
  const tags = headTags({ title: d.title, text: d.text, url: `${site}/storm/${s.sid}`, image: `${root}storms/${s.sid}/og.png` });
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
writeFileSync(join(dist, "robots.txt"), `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${site}/sitemap.xml\n`);
console.log(`stamp-shells: ${storms.length} storm shells + sitemap (${urls.length} URLs) from the ${source} index, site ${site}`);
