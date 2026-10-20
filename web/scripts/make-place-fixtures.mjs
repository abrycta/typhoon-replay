// Build the fixture's static place files (web/fixtures/v1/places/) from the fixture storms' tracks.
//
// Writes the pipeline's layout (m1-pipeline: pipeline/typhoon/dataset.py `write_places`):
//   places/index.json           {schema, search, shards: [{shard, country, admin1, admin2, places, hits, bbox, path, geojson}]}
//   places/<shard>.json         {shard, country, admin1, admin2, places: [...], hits: {columns, rows}, storms: {sid: [name, season]}}
// plus the compact search index the web app reads first (an addition the pipeline is asked to emit):
//   places/search.json          {schema, columns, shards, rows}
//
// Places are the 10 contract seed places (contracts/db/seed/20_places.sql, as in make_fixtures.py). Distances
// are to the place centroid (the pipeline measures to the boundary), over the track interpolated hourly.
// The .geojson display shapes are not written: the app does not draw place shapes yet.
//
// Usage (from web/): node scripts/make-place-fixtures.mjs
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../fixtures/v1");
const OUT = join(ROOT, "places");
const SCHEMA = "typhoon-replay/static@1";
const RADII = [50, 100, 200, 300, 500];

// id, country, kind, name, nameJa, admin1, admin1Ja, admin2, lon, lat, shard
const PLACES = [
  ["PH-0831600000", "PH", "city", "Tacloban City", null, "Eastern Visayas", null, "Leyte", 125.0039, 11.2433, "ph-leyte"],
  ["PH-0802616000", "PH", "municipality", "Guiuan", null, "Eastern Visayas", null, "Eastern Samar", 125.7247, 11.0333, "ph-eastern-samar"],
  ["PH-0803738000", "PH", "city", "Ormoc City", null, "Eastern Visayas", null, "Leyte", 124.6075, 11.0064, "ph-leyte"],
  ["PH-0502011000", "PH", "municipality", "Virac", null, "Bicol Region", null, "Catanduanes", 124.2306, 13.58, "ph-catanduanes"],
  ["PH-1380600000", "PH", "city", "City of Manila", null, "National Capital Region", null, null, 120.9842, 14.5995, "ph-metro-manila"],
  ["JP-47201", "JP", "city", "Naha", "那覇市", "Okinawa", "沖縄県", null, 127.6809, 26.2124, "jp-47-okinawa"],
  ["JP-47207", "JP", "city", "Ishigaki", "石垣市", "Okinawa", "沖縄県", null, 124.1557, 24.3448, "jp-47-okinawa"],
  ["JP-46201", "JP", "city", "Kagoshima", "鹿児島市", "Kagoshima", "鹿児島県", null, 130.5571, 31.5966, "jp-46-kagoshima"],
  ["JP-27100", "JP", "city", "Osaka", "大阪市", "Osaka", "大阪府", null, 135.5023, 34.6937, "jp-27-osaka"],
  ["JP-13101", "JP", "special-ward", "Chiyoda", "千代田区", "Tokyo", "東京都", null, 139.7536, 35.694, "jp-13-tokyo"],
].map(([id, country, kind, name, nameJa, admin1, admin1Ja, admin2, lon, lat, shard]) => ({ id, country, kind, name, nameJa, admin1, admin1Ja, admin2, lon, lat, shard }));

const json = (p) => JSON.parse(readFileSync(p, "utf8"));
const write = (name, doc) => writeFileSync(join(OUT, name), JSON.stringify(doc) + "\n");
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const omitNull = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

function haversineKm(lon1, lat1, lon2, lat2) {
  const r = 6371.0088;
  const rad = Math.PI / 180;
  const dp = (lat2 - lat1) * rad;
  const dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

/** Hourly points between observed fixes (longitudes unwrapped across the antimeridian). */
function hourly(fixes) {
  const pts = fixes.map((f) => ({ t: Date.parse(f.t) / 1000, lon: ((f.lon % 360) + 360) % 360, lat: f.lat, wind: Math.max(f.jtwcKt ?? -1, f.jmaKt ?? -1) }));
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    let dl = b.lon - a.lon;
    if (dl > 180) dl -= 360;
    if (dl < -180) dl += 360;
    for (let t = Math.ceil(a.t / 3600) * 3600; t < b.t; t += 3600) {
      const f = (t - a.t) / (b.t - a.t);
      const wind = a.wind >= 0 && b.wind >= 0 ? a.wind + f * (b.wind - a.wind) : Math.max(a.wind, b.wind);
      out.push({ t, lon: a.lon + f * dl, lat: a.lat + f * (b.lat - a.lat), wind });
    }
  }
  const last = pts.at(-1);
  if (last) out.push(last);
  return out;
}

const index = json(join(ROOT, "index.json"));
const storms = (index.storms ?? index).map((s) => ({ sid: s.sid, name: s.name, season: s.season, startedAt: s.startedAt }));
const tracks = new Map(storms.map((s) => [s.sid, hourly(json(join(ROOT, "storms", s.sid, "track.json")).fixes ?? [])]));

/** Exposure row per (place, storm) within 500 km, in the pipeline's column order. */
function exposure(p) {
  const rows = [];
  for (const s of storms) {
    const h = tracks.get(s.sid);
    const d = h.map((x) => haversineKm(x.lon, x.lat, p.lon, p.lat));
    if (!d.length || Math.min(...d) > 500) continue;
    const i = d.indexOf(Math.min(...d));
    const w = RADII.map((r) => {
      const ws = h.filter((x, k) => d[k] <= r && x.wind >= 0).map((x) => x.wind);
      return ws.length ? Math.round(Math.max(...ws)) : null;
    });
    const hours = RADII.map((r) => d.filter((x) => x <= r).length);
    rows.push({ sid: s.sid, km: Math.round(d[i] * 10) / 10, at: h[i].t, w, g500: null, hours });
  }
  return rows.sort((a, b) => a.km - b.km || a.sid.localeCompare(b.sid));
}

function summary(rows) {
  const near = rows.filter((r) => r.km <= 100);
  if (!near.length) return undefined;
  const strongest = near.filter((r) => r.w[1] !== null).sort((a, b) => b.w[1] - a.w[1])[0];
  const started = (sid) => storms.find((s) => s.sid === sid)?.startedAt ?? "";
  const latest = [...near].sort((a, b) => started(b.sid).localeCompare(started(a.sid)))[0];
  return omitNull({
    stormsWithin100Km: near.length,
    stormsWithin50Km: near.filter((r) => r.km <= 50).length,
    strongest: strongest ? { sid: strongest.sid, maxWindKt: strongest.w[1], km: strongest.km } : null,
    latest: { sid: latest.sid, at: new Date(latest.at * 1000).toISOString().replace(".000Z", "Z"), km: latest.km },
  });
}

mkdirSync(OUT, { recursive: true });
const shardNames = [...new Set(PLACES.map((p) => p.shard))].sort();
const shards = [];
const search = [];
for (const shard of shardNames) {
  const places = PLACES.filter((p) => p.shard === shard).sort((a, b) => a.id.localeCompare(b.id));
  const first = places[0];
  const hits = [];
  const sids = new Set();
  const docs = places.map((p, idx) => {
    const ex = exposure(p);
    for (const r of ex) {
      hits.push([idx, r.sid, r.km, r.at, ...r.w, r.g500, ...r.hours]);
      sids.add(r.sid);
    }
    search.push([p.id, p.kind, p.name, p.nameJa, p.admin1, p.admin1Ja, p.admin2, p.lon, p.lat, shardNames.indexOf(shard), ex.filter((r) => r.km <= 100).length]);
    return omitNull({
      id: p.id, kind: p.kind, name: p.name, nameJa: p.nameJa, admin1: p.admin1, admin1Ja: p.admin1Ja, admin2: p.admin2,
      centroid: [p.lon, p.lat], bbox: [p.lon - 0.05, p.lat - 0.05, p.lon + 0.05, p.lat + 0.05].map(r4), summary: summary(ex),
    });
  });
  const stormMap = Object.fromEntries([...sids].sort().map((sid) => {
    const s = storms.find((x) => x.sid === sid);
    return [sid, [s.name, s.season]];
  }));
  write(`${shard}.json`, {
    schema: SCHEMA, shard, country: first.country, admin1: first.admin1, admin2: first.admin2,
    places: docs,
    exposureNote: "Fixture: distance from the hourly-interpolated best track to the place centroid (stand-in boundaries).",
    hits: { columns: ["place", "sid", "km", "at", "w50", "w100", "w200", "w300", "w500", "g500", "h50", "h100", "h200", "h300", "h500"], rows: hits },
    storms: stormMap,
  });
  const lons = places.map((p) => p.lon);
  const lats = places.map((p) => p.lat);
  shards.push({
    shard, country: first.country, admin1: first.admin1, admin2: first.admin2, places: places.length, hits: hits.length,
    bbox: [Math.min(...lons) - 0.05, Math.min(...lats) - 0.05, Math.max(...lons) + 0.05, Math.max(...lats) + 0.05].map(r4),
    path: `v1/places/${shard}.json`, geojson: `v1/places/${shard}.geojson`,
  });
}
write("index.json", { schema: SCHEMA, search: "v1/places/search.json", shards });
write("search.json", {
  schema: "typhoon-replay/places-search@1",
  columns: ["id", "kind", "name", "nameJa", "admin1", "admin1Ja", "admin2", "lon", "lat", "shard", "storms100"],
  shards: shardNames.map((s) => `v1/places/${s}.json`),
  rows: search.sort((a, b) => a[0].localeCompare(b[0])),
});
console.log(`places: ${PLACES.length} places in ${shards.length} shards, ${shards.reduce((n, s) => n + s.hits, 0)} exposure rows -> ${OUT}`);
