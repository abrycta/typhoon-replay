#!/usr/bin/env node
// Performance budget report for the built app (dist/): gzip size of the JS/CSS each route needs on first
// load, following the static import graph of Vite's manifest-free output (modulepreload links + imports).
// Usage: npm run size [-- --top]   (--top: list the largest packages per chunk from source maps)
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const dist = resolve(import.meta.dirname, "../dist");
const assets = join(dist, "assets");
const gz = (f) => gzipSync(readFileSync(join(assets, f))).length;
const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
const files = readdirSync(assets);

// Static imports of a chunk (import ... from "./x.js" and import "./x.js"), transitively.
const staticDeps = (file, seen = new Set()) => {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = readFileSync(join(assets, file), "utf8");
  for (const m of src.matchAll(/(?:^|[;\s}])import\s*(?:[^"'()]*?from\s*)?["']\.\/([^"']+\.js)["']/g)) staticDeps(m[1], seen);
  return seen;
};

const html = readFileSync(join(dist, "index.html"), "utf8");
const entry = /src="\/assets\/([^"]+\.js)"/.exec(html)?.[1];
const css = [...html.matchAll(/href="\/assets\/([^"]+\.css)"/g)].map((m) => m[1]);
const base = staticDeps(entry);
const baseJs = [...base].reduce((s, f) => s + gz(f), 0);
const baseCss = css.reduce((s, f) => s + gz(f), 0);
console.log(`Initial (every route): JS ${kb(baseJs)} gz in ${base.size} chunks, CSS ${kb(baseCss)} gz`);

const routes = { home: "routes-", storms: "storms-", "storm/$sid": "storm._sid-", compare: "compare-", town: "town-", about: "about-" };
for (const [name, prefix] of Object.entries(routes)) {
  const f = files.find((x) => x.startsWith(prefix) && x.endsWith(".js"));
  if (!f) continue;
  const deps = [...staticDeps(f)].filter((x) => !base.has(x));
  const js = deps.reduce((s, x) => s + gz(x), 0);
  console.log(`  ${name.padEnd(11)} +${kb(js).padStart(9)} route JS  (total ${kb(baseJs + js)})`);
}
const lazy = { "map (MapLibre + WebGL layer)": "ReplayMap-", "MapLibre worker": "maplibre-gl-worker-", "fonts.css": "fonts-" };
for (const [name, prefix] of Object.entries(lazy)) {
  const fs = files.filter((x) => x.startsWith(prefix) && /\.(m?js|css)$/.test(x));
  console.log(`  lazy ${name}: ${kb(fs.reduce((s, x) => s + gz(x), 0))} gz`);
}

if (process.argv.includes("--top")) {
  for (const f of files.filter((x) => x.endsWith(".js.map"))) {
    const map = JSON.parse(readFileSync(join(assets, f), "utf8"));
    const by = new Map();
    map.sources.forEach((s, i) => {
      const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(s)?.[1] ?? "app";
      by.set(pkg, (by.get(pkg) ?? 0) + (map.sourcesContent?.[i]?.length ?? 0));
    });
    const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log(`${f}: ${top.map(([p, n]) => `${p} ${kb(n)}`).join(", ")}`);
  }
}
