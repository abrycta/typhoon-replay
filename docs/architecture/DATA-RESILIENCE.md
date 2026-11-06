# Data resilience

Written 2026-10-21 by Kurt. How Replay keeps working when an upstream data source moves, breaks or disappears.

The machinery is the shared private kit [`abrycta/data-archive-kit`](https://github.com/abrycta/data-archive-kit) (`archivekit`); its README and `docs/ADOPTING.md` cover the generic parts. This file covers Replay's sources, fallbacks, data-version publishing and runbook.

## The principle

**The live site never depends on an upstream source at runtime.** The pipeline fetches, validates and publishes processed data to hosting we control: Cloudflare Pages (app), the Hugging Face dataset (frames, Parquet) and Neon (catalog, live tables). If NCEI, geoBoundaries, JTWC or another source goes down, only updates pause; the site serves the last good data.

## Fallback is automatic

No human step is needed when a source fails. `typhoon.sources.fetch(<id>)` (which calls `archivekit.fetch`) walks the links in `pipeline/sources.yaml`:

```
primary  →  official mirrors  →  private archive (latest release <id>-<YYYY-MM-DD> in abrycta/typhoon-replay-archive)
```

- Next link on: a timeout, connection or HTTP error; a redirect to an HTML page; an empty or truncated download; size bounds, a missing column or property, a row count out of bounds, a shrink of more than 2 % against the current copy, or a checksum mismatch; a failing project hook (`check_ibtracs`: SID, time and coordinate formats).
- The archive is the last link. It verifies the release asset against `SHA256SUMS`, then the raw sha256 in `manifest.json`, then runs the upstream checks. A corrupt copy is rejected and the run fails with a clear error.
- The serving link and snapshot date go into `<file>.provenance.json`, `data/run-manifest.json` and the published `data_version` metadata (`archive_used`, `data_as_of`). The app shows **"data as of <snapshot date>"** whenever archive data was used.
- A fallback never fails the run. It logs a warning (`::warning::` in Actions) and opens or updates the issue `source-health: <id>` in the private archive repo (deduplicated; comments only on state change).
- Every run starts at the primary, so recovery is automatic; the weekly health job closes the issue once every link is healthy.
- Downloads go to a temporary file and are renamed into place only after every check passes. If every link fails, the local copy is untouched, `AllLinksFailed` is raised and the issue says "updates paused".
- A missing `ARCHIVE_READ_TOKEN` in CI fails the archive step with a message naming the secret; fork PRs (no secrets) skip it with a notice.

## Sources and their fallback chains

Verified 2026-10-21: every upstream link answered the health probe. Chains are listed in `fetch()` order.

| Source (`id`) | Automatic chain | Listed, manual (`automatic: false`) | Archived | Notes |
|---|---|---|---|---|
| IBTrACS v04r01 WP (`ibtracs-wp`) | NCEI WP CSV → NCEI **ALL** CSV filtered to storms with any WP row → archive | NCEI WP NetCDF (needs a converter) | every snapshot | The ALL→WP filter is **byte-identical** to NCEI's WP file (checked 2026-10-21). 114.6 MB, 249,100 rows; updated three times a week |
| IBTrACS v04r01 ALL (`ibtracs-all`) | NCEI ALL CSV → archive | NCEI ALL NetCDF | every snapshot | 333 MB, about 730k rows |
| ERA5, three remote datasets: `era5-an-sfc` (u/v/MSLP), `era5-fc-gust` (10fg), `era5-fc-precip-rate` (mtpr) | NSF NCAR on AWS → the same NCAR files via OSDF → ARCO-ERA5 on GCS, chosen per file by `typhoon.era5` | Earth Engine (needs a project), Copernicus CDS (account, slow queues) | **no** (petabytes; the derived frames on HF are our durable copy) | NCAR is read by HTTP range requests of the exact HDF5 chunks (index cached per file); ARCO covers the ~3 months NCAR has not published. Which link served is recorded per storm in `provenance.json` and in the version manifest |
| PH ADM3 (`geoboundaries-phl-adm3`) | geoBoundaries at pinned commit `9469f09` → the same file from `media.githubusercontent.com` (Git LFS) → archive | HDX COD-AB PHL (1.06 GB zip, COD-AB p-codes) | once (pinned; sha256 `0a125b17…`) | CC BY 3.0 IGO (NAMRIA, PSA via OCHA). 532 MB, 1,647 units |
| JP municipalities (`mlit-n03-jpn`) | MLIT N03 2025-01-01 zip → archive | — | once (pinned; sha256 `df20ebf7…`) | Boundaries, JIS codes and Japanese names; government standard terms (CC BY 4.0 compatible). 632 MB zip, 1,747 municipalities after dissolving designated-city wards |
| JP romanised names (`geoboundaries-jpn-adm2`) | geoBoundaries `9469f09` → LFS media → archive | — | once (pinned; sha256 `27a0a8fa…`) | **OSM-derived:** treat as ODbL, credit "© OpenStreetMap contributors". Matched to N03 by overlap |
| PH codes (`hdx-cod-ab-phl-tabular`, `psgc-cities-municipalities`) | HDX COD-AB xlsx → archive; PSGC API mirror → archive | PSA PSGC page (403 to scripts) | once / every snapshot | COD rows matched to geoBoundaries shapes by centre and name; 10-digit PSGC from the PSGC list. 1,633 places |
| JMA best track (`jma-rsmc-besttrack`) | JMA RSMC zip → archive | — | every snapshot | JMA typhoon numbers (台風第N号) |
| Natural Earth 50m coastline and countries | raw GitHub at the `v5.1.2` commit → jsDelivr → archive | naciscdn shapefile zip | once (pinned sha256) | Public domain; jsDelivr serves identical bytes |
| PAGASA crosswalk (`pagasa-crosswalk`) | — (it's `pipeline/crosswalk/*.csv` in this repo; git is its history) | — | no | **The source of truth.** Health validates its columns |
| Wikipedia season pages (`wikipedia-season-pages`) | — | enwiki `?action=raw` | no | CC BY-SA 4.0. **An update input only**, never read at runtime; throttle under 1 request/s |
| JTWC RSS and ABPW, JMA bosai `targetTc.json`, JMA XML feed, GDACS TC RSS | the single official URL | GDACS JSON API | **samples only**, keep the last 26 | **The archive is never a fallback for live data**: a week-old sample shown as "live" would be wrong. Samples exist for parser tests |

### Why the format-changing mirrors are manual

HDX, MLIT, NetCDF and the shapefile zips differ in schema or format, so an automatic switch would feed the pipeline data it can't parse. The archive holds the pinned primary's exact bytes, so it comes **before** them (the first design had "geoBoundaries → HDX → archive"). Using a manual mirror is a runbook step.

## The archive

- `abrycta/typhoon-replay-archive`: private repo generated by `archivekit init typhoon-replay`; a weekly caller workflow runs the kit's reusable `snapshot.yml` and `health.yml`.
- One GitHub Release per snapshot, tag `<id>-<YYYY-MM-DD>`, holding the zstd asset, `manifest.json` and `SHA256SUMS` (GitHub limit: 1,000 assets per release, each under 2 GiB).
- Snapshot only on change, cheapest check first: (1) pinned sha256 already archived (no request); (2) HEAD shows the same ETag or Last-Modified; (3) downloaded content has the same sha256.
- Compression: zstd level 19 below 150 MB raw, 15 above. Measured 2026-10-21:

  | File | Raw | gzip -9 | zstd -19 | zstd -15 |
  |---|---|---|---|---|
  | IBTrACS WP CSV | 114.6 MB | 9.48 MB (3.9 s) | **7.10 MB, 16.1×** (9.2 s) | — |
  | geoBoundaries PHL ADM3 | 532.1 MB | — | 108.7 MB (102 s) | **142.3 MB** (40 s) |

  zstd -19 is about 25 % smaller than gzip -9 and decompresses faster; on the 532 MB GeoJSON, level 15 saves a minute of shared private-repo runner time per snapshot.
- Licences: private copies for resilience only; nothing in the archive is redistributed. Only processed data is published, with each source's attribution.
- Restore by hand:

  ```sh
  gh release download ibtracs-wp-2026-10-21 -R abrycta/typhoon-replay-archive -D restore/
  ```

  or `uv run python -m typhoon.sources restore ibtracs-wp --out restore/`, which also verifies the checksums.

## Detection

1. Every pipeline run: fallback and failure warnings, and auto-opened issues in the archive repo (above).
2. Weekly health job, in the private archive repo because public repos can't call the private kit's reusable workflows. A ranged 64 KiB GET per registry link checks:
   - reachability and status;
   - HTML instead of data;
   - permanent redirects (registry URL needs updating);
   - Content-Range size against the bounds;
   - the CSV header fingerprint, or the GeoJSON/XML/JSON shape.

   It also checks that each archived source has a release and the expiry of `ARCHIVE_READ_TOKEN` (issue 30 days ahead). One `source-health` issue per source, closed when healthy. Issues stay in the private repo: upstream URLs are public, but the issues would expose the archive's structure and tags and add noise. The job reads the registry from this repo's raw URL on `main`, so it stays in sync with the pipeline.
3. Data-quality gates: `pipeline/tests/test_ibtracs.py` covers row counts, SID×time uniqueness, ranges, monotonic time, units and known storms; frame checks follow the same pattern. A failed gate blocks publishing.

## Dataset versions: atomic publish and rollback

Frames and Parquet go to the Hugging Face dataset `permission-alluring/typhoon-replay` (per DECISIONS.md) via `typhoon.dataset` (assemble + gates) and `typhoon.publish` (upload, verify, flip).
- Immutable versions: each publishing run builds data version `N` (next integer after the published one) under `v<N>/`: `index.json`, `manifest.json`, `storms/<sid>/…`, `places/…`, `tables/*.parquet`. An existing `v<N>/` is never modified; the version is tagged `data-v<N>`.
- Incremental: frame files are content-addressed (`frames/<sid>/<sha256-prefix>.*`) outside the version directories, which only reference them. Every version holds every storm folder (DECISIONS.md, 2026-10-21); the Hub deduplicates unchanged files, so this costs upload commits, not storage. Frames are rebuilt only when IBTrACS changed a storm's hourly track (`trackHash`), so a weekly refresh uploads a few storms plus small documents. Uploads go in paced commits of at most 500 files; every Hub commit retries a 429 after the server's requested wait (R7).
- Size: lossy WebP frames for drawing (about 1.3 kB per storm-hour) plus lossless 3-hourly 0.5 deg grids for exact readouts (about 1.2 kB). All 2,058 catalogue storms in data version 4 have frames.
- Gates first: `dataset.check` verifies every file's checksum against the manifest, the 25 MiB per-file cap, `.tyf` headers, WebP sheets byte-identical to the `.tyf` planes, nodata, plausible ERA5 ratios and table referential integrity; `pytest -m data` checks the catalogue, places and exposure. Batch jobs validate each storm's frames before upload. `publish.verify` then checks every uploaded file's size and that a frame answers HTTP Range requests (206) with CORS.
- Comparison with the published version: `dataset build` and `publish flip` compare the new `index.json` with the one `latest.json` points at. Each storm that vanishes, loses its replay or loses a PAGASA or JMA name is logged with a reason (CI `::warning`, `data/build/compare-v<N>.json`). More than max(5, 1 %) vanished storms, max(3, 1 %) lost replays or max(5, 1 %) lost names stop the publish; an intended, reviewed shrink runs Refresh with `allow-shrink`.
- Read errors stop the run: only a 404 on `latest.json` with no `v1/` means a first publish. A 401/403, a 5xx or 429 after retries, a network error or a non-JSON body stops the run, so it cannot rebuild every storm, overwrite `v1/` or flip `latest.json` back. `next-version` is one more than both `latest.json` and every `v<N>/` in the repo; `flip` refuses a version lower than the live one (only `rollback` goes back).
- ERA5T end: the plan and frames stage read ARCO-ERA5's `valid_time_stop_era5t` (fallback: `valid_time_stop`, then 12 days before now, with a CI warning) and defer storms whose track runs past it. Deferred or failed storms have no published frames, so the next refresh builds them. A storm whose frames fail is skipped with a warning; more than max(2, 5 %) failures fail the job.
- JMA numbers: `check_jma` (registry hook) rejects a best-track file the parser cannot read, so the kit falls back to the archive copy. If JMA is still unusable, `prepare` continues without JMA numbers, and the comparison above stops the publish if storms would lose their 台風第N号 designation.
- One pointer flip: only then does a single commit write `README.md` (the dataset card) and `latest.json`:

  ```json
  {"dataVersion": 1, "path": "v1/", "index": "v1/index.json", "manifest": "v1/manifest.json",
   "publishedAt": "…", "dataAsOf": "…", "archiveUsed": false, "previous": null}
  ```

  `manifest.json` carries `archivekit.data_version_metadata()` (`inputs`, `archive_used`, `data_as_of`), ERA5 reads per link, every source's attribution and every file's checksum. The app reads `latest.json` (short cache), then only versioned, immutable paths, so a half-uploaded version is never visible.
- Rollback: `python -m typhoon publish rollback --to <N>`, one commit pointing `latest.json` at an older version still in the repo. Nothing is deleted; old versions stay while a retained version references their folders.
- Database: `typhoon.dbload` loads a version's `tables/` into the catalogue schema (COPY into `catalog_next`, validate, then swap all tables and insert the `dataset_version` row in one transaction). A database rollback loads the previous version's tables as a new, higher dataset_version.
- Attribution: the dataset card lists every source's registry `attribution`. Derived files keep CC BY-SA where it applies (PAGASA names) and ODbL for the OSM-derived romanised JP names.

## Live tracker: degrading gracefully

- The ingestion job (GitHub Actions, every 30 min) records each feed's last success and last error per source id (e.g. an `ops.source_status` table). A failing feed pauses only its own ingestion; `live.active_storm` keeps its last values and `updated_at`.
- UI by data age:

  | Age of the newest live data | UI |
  |---|---|
  | < 1 h | Normal; a small "updated 12 min ago" |
  | 1–6 h | Amber "last updated 3 h ago"; the storm track stays on screen |
  | > 6 h, or the feed has errored | Banner: "Live updates paused: <JTWC/JMA> feed unreachable since 09:00 UTC. Showing the last known position." Links to the official JTWC, JMA and PAGASA pages |
  | > 24 h and no active advisories | The live panel collapses to "No live data" plus the official links; the historical replay is unaffected |

- When an input came from the archive, the replay footer reads "Best-track data as of 2026-10-18 (archived copy)", taken from `manifest.json` (`provenance.data_as_of`, `provenance.archive_used`).

## Runbook

| Situation | What happens automatically | What to do |
|---|---|---|
| **A source is down** (NCEI outage) | The next link serves (for IBTrACS WP: the ALL subset, then the archive). The issue `source-health: ibtracs-wp` opens in the archive repo. Publishing continues; the app shows "data as of" if the archive served | Nothing, unless it lasts more than about two weeks; then look for a new official mirror |
| **A source moved** (redirect to HTML, 404, or a 301/308 flagged by health) | Fallback; the issue names the link and the redirect target | Edit the URL in `pipeline/sources.yaml` (one line), merge, and let the next health run close the issue. Check the new URL serves identical bytes (`archivekit fetch <id> --out /tmp/x`, compare the sha256) |
| **A source is gone for good** | The archive keeps serving the last snapshot, with "data as of" in the app | Set `status: retired` on the source, note it on the About page, and consider promoting a manual mirror: write the adapter, then set `automatic: true` |
| **The schema changed** | Missing required columns: that link fails and the next one serves (often the archive). Columns only added: a "schema drift" warning and issue; the data is used | Update `typhoon/ibtracs.py` (or the relevant parser), `required_columns` and `header_sha256` in the registry, and the tests; re-run the pipeline |
| **Bad data was published** (should be caught by the gates) | — | Roll back: `publish rollback --to <N>` points `latest.json` at the previous version (one commit). Add a test or registry check that catches the problem, then re-run |
| **Archive copy corrupt** (`archive-integrity` in the error) | That run fails clearly; nothing is replaced | `archivekit restore <id> --date <older date>` to inspect; delete the bad release; re-run the snapshot workflow for that source |
| **`token-expiry` issue** | Opens 30 days before `ARCHIVE_READ_TOKEN` expires | Regenerate the token with the same settings; update the secret in **both** repos and `health.token_expires` |
| **Fork PR or first run without the token** | The archive step and pipeline CI skip with a notice | Nothing, or create the token |

## Files

- `pipeline/sources.yaml`: the registry, validated against the kit's JSON Schema.
- `pipeline/typhoon/sources.py`: the adapter (`fetch`, `registry`, the `check_ibtracs` hook). Run `python -m typhoon.sources <fetch|snapshot|health|restore|validate-registry>`.
- `pipeline/tests/test_sources.py`: tests the registry contents, chain order, local pins, hook and the WP → ALL-subset → archive path.
- `pipeline/tools/use-archivekit-tag.sh`: switches the path dependency on `../../data-archive-kit` to the tagged release.
- `abrycta/typhoon-replay-archive`: the caller workflow and README.

## Token rotation

`ARCHIVE_READ_TOKEN` is a fine-grained token on `data-archive-kit` and `typhoon-replay-archive` (Contents: read; Issues: read and write; 1-year expiry), stored as a secret in both repos. Its expiry date is `health.token_expires` in `sources.yaml`; the health job opens a `token-expiry` issue 30 days ahead (see the runbook).
