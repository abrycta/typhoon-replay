# Static dataset layout the web app reads

Status: the frontend's assumptions as of milestone 1. The pipeline owns the layout and must confirm anything marked **assumption**. The fixture in `web/fixtures/` (built by `scripts/make_fixtures.py` from the data spike) follows it exactly.

The app finds the data through `public/config.json`:

```json
"data": {
  "baseUrl": "https://huggingface.co/datasets/permission-alluring/typhoon-replay/resolve/main/",
  "pointer": "latest.json",
  "fallbackBaseUrls": ["/fixtures/"]
}
```

If the primary host fails (HTTP error, CORS, or an HTML page), the app tries the next base URL and the footer shows a "sample data" badge. The replay calls no API backend.

## Files

| Path (relative to a base URL) | Content | Required |
|---|---|---|
| `latest.json` | Pointer to the current version: `{"version": 1, "path": "v1/"}`. Also accepted: `{"version": 1}` (path `v1/`), `"v1"`, `1`. | yes |
| `v<N>/manifest.json` | `{datasetVersion, dataAsOf, generatedAt?, fixture?, sources: [{id, name, url, license, attribution}]}`; from v2 the per-file checksums are in `v<N>/files.json` (`fileList`), which the app does not fetch | no (footer and About page fall back) |
| `v<N>/index.json` | `{"storms": [StormSummary…]}` or a bare array | yes |
| `v<N>/storms/<sid>/summary.json` | StormDetail (below) | yes per storm |
| `v<N>/storms/<sid>/track.json` | `{"fixes": [TrackFix…]}` plus optional `"hours"` | yes per storm |
| `frames/<sid>/<hash>.field.<var>.webp`, `.exact.<var>.webp` | WebP frame sheets, content-addressed outside the versions (`pipeline/typhoon/frames.py`) | when `summary.frames` is present |
| `frames/<sid>/<hash>.tyf` (or a storm-relative `frames.tyf`, `.tyf.gz`) | TYF1 frame file | optional: only some storms have one |
| `v<N>/storms/<sid>/og.png` | 1200×630 share image | no (`summary.ogImage` names it) |
| `v<N>/places/index.json` | `{shards: [{shard, country, admin1, admin2?, places, hits, bbox, path, geojson}], search?}` (pipeline `write_places`) | for "My town" |
| `v<N>/places/search.json` | compact place search index (below); the pipeline writes it from the next data version on | no (falls back to the shards) |
| `v<N>/places/search/manifest.json`, `search/<key>.json` | the search index in slices by first letter(s) (below) | no (falls back to `search.json`) |
| `places/<shard>/<hash>.json` | places of one PH province / JP prefecture and their storm exposure (below); content-addressed at the dataset root, shared by versions (`path` in `places/index.json`) | for "My town" |

`<sid>` is the IBTrACS SID (`^[0-9]{7}[NS][0-9]{5}$`). Every version directory holds every storm's folder (index rows' `path` is always `v<N>/storms/<sid>/`).

**Size budgets** (pipeline `dataset.check`, raw bytes): any file < 25 MiB (hosting cap); `index.json` ≤ 2.5 MB; every other file fetched before a page can draw (`manifest.json`, `places/index.json`, `summary.json`, `track.json`) ≤ 1 MB. Pipeline-only files (`files.json`, `frames-index/<season>.json`, `tables/`) are not fetched by the app.

## Records

Field names follow the API contract (`contracts/openapi`) where the concept exists, so the UI sees the same storm from the static index and from `GET /v1/storms`.

- **StormSummary** (index rows) = contract `StormSummary` (`sid, name, localNames{ph,ja}, season, basin, startedAt, endedAt, peakWindKt, peakWindAgency, minPressureHpa, landfallCountries`) plus `replayAvailable`, `frameCount`, `ace`, an optional `peakAt` from data v4 (ISO time of peak wind, same as `summary.json` `peak.at`; used by Compare's suggested pairs) and an optional `designation` from the next data version (JTWC number from IBTrACS `USA_ATCF_ID`, e.g. `WP032019` → `03W`; also in `summary.json`). Browse works without it and labels unnamed storms by PAGASA name, JMA number, or "Unnamed storm · [designation ·] Feb 1940".
- **StormDetail** (`summary.json`) = contract `StormDetail` (`peak, intensity[], landfalls[], sources[], replayAvailable, …`) plus:
  - `frames`: `{format: "tyf" | "tyf.gz" | "webp", frames, start, end, nx, ny, resDeg, nodata, time[], nwLat[], nwLon[], series, field, exact}` plus, when `format` names a .tyf, `{path, bytes, sha256, headerBytes, frameBytes, vars[]}`. `field` (lossy WebP q80, hourly: wind, gust, mslp, tp, u, v) and `exact` (lossless WebP, 3-hourly, 0.5°) list their sheets with `path`s. All paths are relative to the storm directory (e.g. `../../../frames/<sid>/…`; absolute URLs also work). `series`: the pipeline's per-frame maxima near the centre, from the unquantised fields. `centreOffset` (from the next data version; `frames.centre_offsets`): `{frameIndex[], km[], bearingDeg[], lat[], lon[]}` on the exact grid's 3-hourly frames, the offset of ERA5's lowest sea-level pressure within 500 km from the best track (null = no closed low). The replay flags offsets of 150 km or more and a missing centre at tropical-storm strength; it never moves the field.
  - `reanalysisCheck`: the pipeline's ERA5-vs-best-track cross-check at the JTWC peak: `{radiusDeg, peakTime, atPeak: {jtwcMs, jmaMs, era5WindMs, era5GustMs, ratioToJtwc, ratioToJma, era5MslpMinHpa, jmaPressureHpa}, typhoonHoursMedianRatioToJtwc, typhoonHoursMedianRatioToJma}`.
  - `affectedPlaces`: contract `PlaceHit[]` within `affectedRadiusKm` (closest first; the pipeline uses 100 km, at most 100 places). When absent, the storm page says this dataset version lacks the list and calls no API.
  - `ogImage`: file name of the share image.
- **TrackFix** (`track.json`): `{t: RFC 3339 UTC, lon (-180,180], lat, jtwcKt?, jtwcHpa?, jmaKt?, jmaHpa?, overLand?}`; observed fixes only. Missing values are omitted, never `null`.

## Places ("My town")

Place search and storms-near-a-place come from these files; no visitor page calls the API.

- **Place shard** (`places/<shard>.json`, as `dataset.write_places` on m1-pipeline writes it): `{country, admin1, admin2?, places: [{id, kind, name, nameJa?, admin1, admin1Ja?, admin2?, centroid, bbox, summary?}], hits: {columns, rows}, storms: {sid: [name, season]}}`. `hits.columns` are `place, sid, km, at, w50…w500, g500, h50…h500`: `place` indexes `places`, `at` is unix seconds, `w<r>`/`h<r>` are the best-track wind (kt) and hours within each radius. The app filters `km <= radius` and takes `w<radius>`, `h<radius>`; it reads columns by name, accepts object rows, ISO times and place ids, and skips rows it cannot read.
- **Search index** (`places/search.json`, or the path `places/index.json` names in `search`): `{columns: ["id","kind","name","nameJa","admin1","admin1Ja","admin2","lon","lat","shard","storms100"], shards: ["v1/places/ph-leyte.json", …], rows: [[…], …]}`, `shard` an index into `shards` (a path also works), `storms100` = `summary.stormsWithin100Km` (ranking only). For ~3,500 places: about 250 kB raw, ~60 kB gzip. The pipeline writes it (`write_places`); for data versions without it the app builds the same index from every shard (~130 requests plus the full exposure tables).
- **Search slices** (`places/search/`, pipeline `typhoon/place_search.py`): the same rows split so the first search downloads one slice. Latin keys: the first letter of every word of the folded name and of its province (PH `admin2`) or prefecture (JP `admin1`), lower case without accents; a letter whose slice exceeds 24 kB raw is split by two letters (`manifest.split`). Japanese keys: `ja-<code point mod 32>` of every character of `nameJa` and `admin1Ja` (NFKC, katakana as hiragana, the trailing 市/区/町/村/都/道/府/県 left out). Each slice has the `search.json` shape with its own `shards` list. A query reads the slice for its first letter(s) or first Japanese character and falls back to `search.json` when the manifest or slice is missing or fails, the slice has no hit (mid-word matches, a first-letter typo, PH region names), or the selected place is outside it. On v2-era data (3,380 places): `search.json` 349 kB raw / 80 kB gzip; 181 slices, median 1.9 kB and largest 13 kB gzip; manifest 0.7 kB gzip.
- Paths in these files are dataset-root relative (`v1/places/…`); absolute URLs and bare file names (relative to `places/`) also work.
- The fixture's 10 places (contract seed) are written by `scripts/make-place-fixtures.mjs` from the fixture tracks, with distances to the centroid instead of the boundary.

## Assumptions for the pipeline to confirm

1. **Hourly track interpolation happens in the browser** (`src/data/track.ts`: position and each agency's values linear between the fixes that report them, with "interpolated between X and Y" provenance). If the pipeline emits `track.json.hours` (`{t: unix seconds, lon, lat, jtwcKt?, jmaKt?, jmaHpa?, observed, between?: [t0, t1]}`), the app uses it as is.
2. **Frame format per storm** (`src/data/frames/source.ts`): WebP when `summary.frames.field` is complete (with `time`, `nwLat`, `nwLon`), else the .tyf; a storm with both plays WebP and falls back to its .tyf if WebP fails. The decode worker fetches the six field sheets in parallel, decodes them with WebCodecs `ImageDecoder` (on the CPU, from the lossy sheet's luma plane) or, where that is missing, `createImageBitmap` + `OffscreenCanvas`, and repacks the tiles into the .tyf frame layout plus the u/v particle texture, so the map draws both formats the same way. TYF1 files are frame-major with the header fields of `frames.py`; on a host that answers HTTP 206 the app fetches windows of 24 frames around the playhead, elsewhere it streams the whole file.
   ERA5 readouts (strongest wind and lowest pressure within 2° of the centre, and the ratios built on them) never use lossy pixels: they take `series` when present, else the lossless .tyf frame, else the lossless `exact` grid, which gives a reading only every 3 hours (the panel says so; nothing is interpolated).
3. **Files are immutable per version directory**: a re-processed storm lands in a new `v<N+1>/` and `latest.json` moves. The app caches by root URL.
4. **CORS**: every file needs `Access-Control-Allow-Origin` (HF `resolve` URLs send it); Range requests must be allowed without credentials.
5. **Local names**: `localNames.ph` from the PAGASA crosswalk and `localNames.ja` as the JMA designation (台風第N号, or the named-storm title). The fixture fills `ja` by hand for 16 storms.
6. **Exposure places** in the fixture are the 10 contract seed places (boundaries are stand-ins), so `affectedPlaces` is only indicative until the pipeline computes it from real boundaries.

## Found while building the fixture

- `storms.parquet` flags **Faxai 2019 (2019242N14180) as a Philippine landfall**: its first segment crosses the antimeridian (179.6°E → 180.1°E) and the segment test treats it as spanning the globe. The fixture script drops segment hits far outside the country box; the pipeline's `seg_hits_*` should unwrap longitudes first.
- `first_ph_landfall_time` is up to 3 h late (as the data spike noted); the storm page shows it as the landfall date only.
