# Static dataset layout the web app reads

Status: what the frontend assumes today (milestone 1). The pipeline owns the real layout; anything marked **assumption** needs its confirmation. The bundled fixture in `web/fixtures/` (built by `scripts/make_fixtures.py` from the data spike) follows this layout exactly.

The app finds the data through `public/config.json`:

```json
"data": {
  "baseUrl": "https://huggingface.co/datasets/permission-alluring/typhoon-replay/resolve/main/",
  "pointer": "latest.json",
  "fallbackBaseUrls": ["/fixtures/"]
}
```

If the primary host fails (HTTP error, CORS, or an HTML page), the next base URL is tried and the footer shows a "sample data" badge. Nothing in the replay calls an API backend.

## Files

| Path (relative to a base URL) | Content | Required |
|---|---|---|
| `latest.json` | Pointer to the current version: `{"version": 1, "path": "v1/"}`. Also accepted: `{"version": 1}` (path `v1/`), `"v1"`, `1`. | yes |
| `v<N>/manifest.json` | `{datasetVersion, dataAsOf, generatedAt?, fixture?, sources: [{id, name, url, license, attribution}]}` | no (footer and About page fall back) |
| `v<N>/index.json` | `{"storms": [StormSummary…]}` or a bare array | yes |
| `v<N>/storms/<sid>/summary.json` | StormDetail (below) | yes per storm |
| `v<N>/storms/<sid>/track.json` | `{"fixes": [TrackFix…]}` plus optional `"hours"` | yes per storm |
| `v<N>/storms/<sid>/frames.tyf` or `.tyf.gz` | TYF1 frame file (`pipeline/typhoon/frames.py`) | only when `summary.frames` is present |
| `v<N>/storms/<sid>/og.png` | 1200×630 share image | no (`summary.ogImage` names it) |
| `v<N>/places/index.json` | `{shards: [{shard, country, admin1, admin2?, places, hits, bbox, path, geojson}], search?}` (pipeline `write_places`) | for "My town" |
| `v<N>/places/search.json` | compact place search index (below); **assumption**: the pipeline does not write it yet | no (falls back to the shards) |
| `v<N>/places/<shard>.json` | places of one PH province / JP prefecture and their storm exposure (below) | for "My town" |

`<sid>` is the IBTrACS SID (`^[0-9]{7}[NS][0-9]{5}$`).

## Records

Field names follow the API contract (`contracts/openapi`) wherever the concept exists there, so a storm from the static index and one from `GET /v1/storms` look the same to the UI.

- **StormSummary** (index rows) = contract `StormSummary` (`sid, name, localNames{ph,ja}, season, basin, startedAt, endedAt, peakWindKt, peakWindAgency, minPressureHpa, landfallCountries`) plus `replayAvailable`, `frameCount`, `ace` and, from the next data version, an optional `designation` (JTWC number from IBTrACS `USA_ATCF_ID`, e.g. `WP032019` → `03W`; also in `summary.json`). The browse page works with or without it: unnamed storms are labelled by PAGASA name, JMA number, or "Unnamed storm · [designation ·] Feb 1940".
- **StormDetail** (`summary.json`) = contract `StormDetail` (`peak, intensity[], landfalls[], sources[], replayAvailable, …`) plus:
  - `frames`: `{format: "tyf" | "tyf.gz", path, bytes, frames, start, end, vars[], sha256}`; `path` is relative to the storm directory (absolute URLs also work).
  - `reanalysisCheck`: the pipeline's ERA5-vs-best-track cross-check at the JTWC peak: `{radiusDeg, peakTime, atPeak: {jtwcMs, jmaMs, era5WindMs, era5GustMs, ratioToJtwc, ratioToJma, era5MslpMinHpa, jmaPressureHpa}, typhoonHoursMedianRatioToJtwc, typhoonHoursMedianRatioToJma}`.
  - `affectedPlaces`: contract `PlaceHit[]` within `affectedRadiusKm` (closest first; the pipeline uses 100 km, at most 100 places). When absent, the storm page says the list is not in this dataset version; it never asks an API.
  - `ogImage`: file name of the share image.
- **TrackFix** (`track.json`): `{t: RFC 3339 UTC, lon (-180,180], lat, jtwcKt?, jtwcHpa?, jmaKt?, jmaHpa?, overLand?}`; observed fixes only. Missing values are omitted, never `null`.

## Places ("My town")

No visitor page calls the API: place search and storms-near-a-place are answered from these files.

- **Place shard** (`places/<shard>.json`, as `dataset.write_places` on m1-pipeline writes it): `{country, admin1, admin2?, places: [{id, kind, name, nameJa?, admin1, admin1Ja?, admin2?, centroid, bbox, summary?}], hits: {columns, rows}, storms: {sid: [name, season]}}`. `hits.columns` are `place, sid, km, at, w50…w500, g500, h50…h500`: `place` indexes `places`, `at` is unix seconds, `w<r>`/`h<r>` are the best-track wind (kt) and hours within each radius. The app filters `km <= radius` and takes `w<radius>`, `h<radius>`; it reads columns by name, accepts object rows, ISO times and place ids, and skips rows it cannot read.
- **Search index** (`places/search.json`, or the path `places/index.json` names in `search`): `{columns: ["id","kind","name","nameJa","admin1","admin1Ja","admin2","lon","lat","shard","storms100"], shards: ["v1/places/ph-leyte.json", …], rows: [[…], …]}`, `shard` an index into `shards` (a path also works), `storms100` = `summary.stormsWithin100Km` (ranking only). For ~3,500 places this is about 250 kB raw, ~60 kB gzip. **Asked of the pipeline**; until it exists the app builds the same index by fetching every shard (correct, but ~130 requests and the full exposure tables).
- Paths in these files are dataset-root relative (`v1/places/…`); absolute URLs and bare file names (relative to `places/`) also work.
- The fixture's 10 places (contract seed) are written by `scripts/make-place-fixtures.mjs` from the fixture tracks, with distances to the centroid instead of the boundary.

## Assumptions for the pipeline to confirm

1. **Hourly track interpolation happens in the browser** (`src/data/track.ts`: position and each agency's values linear between the fixes that report them, with "interpolated between X and Y" provenance). If the pipeline emits `track.json.hours` (`{t: unix seconds, lon, lat, jtwcKt?, jmaKt?, jmaHpa?, observed, between?: [t0, t1]}`), the app uses it as is.
2. **Frames are one TYF1 file per storm**, frame-major, with the header fields of `frames.py` (`nx, ny, res_deg, frames, nodata, vars[{name, units, encoding, scale, offset}], time[], nw_lat[], nw_lon[]`). Variable names used: `wind`, `gust`, `mslp`, `tp`, `wdir`. On a host that answers HTTP 206 (Hugging Face) the app fetches windows of 24 frames around the playhead; elsewhere it streams the whole file. WebP sprites are not read yet.
3. **Files are immutable per version directory**: a re-processed storm lands in a new `v<N+1>/` and `latest.json` moves. The app caches by root URL.
4. **CORS**: every file needs `Access-Control-Allow-Origin` (HF `resolve` URLs send it); Range requests must be allowed without credentials.
5. **Local names**: `localNames.ph` from the PAGASA crosswalk and `localNames.ja` as the JMA designation (台風第N号, or the named-storm title). The fixture fills `ja` by hand for 16 storms.
6. **Exposure places** in the fixture are the 10 contract seed places (boundaries are stand-ins), so `affectedPlaces` is only indicative until the pipeline computes it from real boundaries.

## Found while building the fixture

- `storms.parquet` flags **Faxai 2019 (2019242N14180) as a Philippine landfall**: its first segment crosses the antimeridian (179.6°E → 180.1°E) and the segment test treats it as spanning the globe. The fixture script drops segment hits far outside the country box; the pipeline's `seg_hits_*` should unwrap longitudes first.
- `first_ph_landfall_time` is up to 3 h late (as SPIKE.md notes); the storm page shows it as the landfall date only.
