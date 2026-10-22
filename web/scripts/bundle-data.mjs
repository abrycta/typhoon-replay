#!/usr/bin/env node
// Post-build: ship the hot storms' replay files with the site, so they load from the same origin.
//
// Every dataset file on Hugging Face costs a redirect hop, and the frame sheets come from a US CDN (audit
// 2026-10-22, finding 2). For the curated storms (pipeline/curated/replay-v1.txt, which includes the featured
// Haiyan replay) this copies, at the version latest.json names now:
//
//   dist/data/v<N>/storms/<sid>/summary.json, track.json
//   dist/data/frames/<sid>/<hash>.field.<var>.webp (and .exact.<var>.webp when the summary has no series)
//
// in the dataset's own layout, so the summary's relative frame paths resolve unchanged, and records the version
// and the storm list in dist/config.json (data.bundle). The app then uses that version at once (no pointer round
// trip), reads these storms from /data/, and still reads latest.json in the background: a newer version or an
// unreachable host replaces the baked one (src/data/hooks.ts useDataset). Everything else (index, places, other
// storms, .tyf, share images) stays on Hugging Face.
//
// Each file's size is checked against the summary; a storm with any failed file is left out whole. The build
// never fails because the dataset host is down: it bundles nothing then. Env: BUNDLE_DATA=0 or STAMP_OFFLINE=1
// skips the step.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const web = resolve(import.meta.dirname, "..");
const dist = join(web, "dist");
const BUNDLE_ROOT = "/data/";
const FEATURED = "2013306N07162";

if (process.env.BUNDLE_DATA === "0" || process.env.STAMP_OFFLINE) {
  console.log("bundle-data: skipped (BUNDLE_DATA=0 or STAMP_OFFLINE)");
  process.exit(0);
}

const configPath = join(dist, "config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const slash = (s) => (s.endsWith("/") ? s : `${s}/`);
const base = slash(config.data.baseUrl);

async function get(url, as = "json") {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return as === "json" ? await res.json() : new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (attempt >= 2) throw new Error(`${url}: ${e.message}`);
    } finally {
      clearTimeout(t);
    }
  }
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

function curated() {
  const file = resolve(web, "../pipeline/curated/replay-v1.txt");
  const sids = readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter((l) => /^[0-9]{7}[NS][0-9]{5}$/.test(l));
  return [...new Set([FEATURED, ...sids])];
}

/** One storm's files as [relative path under the bundle root, bytes]; throws if any is missing or the wrong size. */
async function stormFiles(path, sid) {
  const dir = `${path}storms/${sid}/`;
  const summary = await get(`${base}${dir}summary.json`);
  const track = await get(`${base}${dir}track.json`);
  const fr = summary.frames;
  if (!fr?.field?.vars?.length) throw new Error(`${sid}: no WebP field sheets`);
  const sets = [fr.field, ...(fr.series?.era5MaxWindMs ? [] : fr.exact ? [fr.exact] : [])];
  const files = [
    [`${dir}summary.json`, new TextEncoder().encode(JSON.stringify(summary))],
    [`${dir}track.json`, new TextEncoder().encode(JSON.stringify(track))],
  ];
  for (const set of sets) {
    for (const v of set.vars) {
      // Paths are relative to the storm directory (../../../frames/<sid>/...); keep them inside the dataset.
      const rel = new URL(v.path, `https://x.invalid/${dir}`).pathname.slice(1);
      if (/^https?:|^\//.test(v.path) || rel.startsWith("..")) throw new Error(`${sid}: unexpected sheet path ${v.path}`);
      const bytes = await get(base + rel, "bytes");
      if (v.bytes && bytes.byteLength !== v.bytes) throw new Error(`${sid}: ${rel} is ${bytes.byteLength} bytes, summary says ${v.bytes}`);
      files.push([rel, bytes]);
    }
  }
  return files;
}

let pointer;
try {
  pointer = await get(base + (config.data.pointer ?? "latest.json"));
} catch (e) {
  console.warn(`bundle-data: dataset unreachable (${e.message}); bundling nothing`);
  process.exit(0);
}
const version = Number(pointer.version ?? pointer.dataVersion ?? 0);
const path = typeof pointer.path === "string" ? slash(pointer.path) : version ? `v${version}/` : "";
if (!version || !path) {
  console.warn("bundle-data: the pointer names no version; bundling nothing");
  process.exit(0);
}

const sids = curated();
const done = [];
let total = 0;
await mapLimit(sids, 6, async (sid) => {
  try {
    const files = await stormFiles(path, sid);
    for (const [rel, bytes] of files) {
      const out = join(dist, "data", rel);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, bytes);
      total += bytes.byteLength;
    }
    done.push(sid);
  } catch (e) {
    console.warn(`bundle-data: left out ${e.message}`);
  }
});

if (!done.length) {
  console.warn("bundle-data: no storm bundled");
  process.exit(0);
}
done.sort();
config.data.bundle = { root: BUNDLE_ROOT, version, path, storms: done };
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
console.log(`bundle-data: ${done.length}/${sids.length} storms at ${path} (${(total / 1048576).toFixed(1)} MiB) under ${BUNDLE_ROOT}`);
