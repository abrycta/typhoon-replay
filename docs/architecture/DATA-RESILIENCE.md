# Data resilience

Written 2026-10-21 by Kurt. This document covers how Typhoon Replay keeps working when an upstream data source moves, breaks or disappears.

The machinery is the shared private kit [`abrycta/data-archive-kit`](https://github.com/abrycta/data-archive-kit) (`archivekit`); its README and `docs/ADOPTING.md` hold the generic details. This file is the Typhoon-specific part: the sources, their fallbacks, how data versions are published, and the runbook.

## The principle

**The live site never depends on an upstream source at runtime.**
- The pipeline fetches, validates and publishes processed data to hosting we control:
  - Cloudflare Pages for the app;
  - the Hugging Face dataset for frames and Parquet;
  - Neon for the catalog and live tables.
- If NCEI, geoBoundaries, JTWC or anyone else goes down, **only updates pause.** The site keeps serving the last good data.

## Fallback is automatic

> **No human step is needed to keep the pipeline running when a source fails.**

`typhoon.sources.fetch(<id>)` (which calls `archivekit.fetch`) walks the links in `pipeline/sources.yaml`:

```
primary  →  official mirrors  →  private archive (latest release <id>-<YYYY-MM-DD> in abrycta/typhoon-replay-archive)
```

- **It moves to the next link on:**
  - a timeout, connection error or HTTP error;
  - a URL that now redirects to an HTML page;
  - an empty or truncated download;
  - size bounds, a missing column or property, a row count out of bounds, a shrink of more than 2 % against the current copy, or a checksum mismatch;
  - a failing project hook (`check_ibtracs`: SID, time and coordinate formats).
- **The archive is a normal last link.** It downloads the release asset, verifies it against `SHA256SUMS`, then checks the raw sha256 recorded in `manifest.json`, then runs the same checks as upstream data.
  - **A corrupt archive copy is rejected, and the run fails with a clear error.** Corrupt data is never used.
- **Every fallback is recorded.** The serving link and the snapshot date go into:
  - `<file>.provenance.json`;
  - the run manifest (`data/run-manifest.json`);
  - the published `data_version` metadata (`archive_used`, `data_as_of`). The app shows **"data as of <snapshot date>"** whenever archive data was used.
- **A fallback never fails the run.** It logs a warning (and a `::warning::` annotation in Actions) and opens or updates the source's issue `source-health: <id>` in the private archive repo. The issue is deduplicated, and a comment is added only when the state changes.
- **Recovery is automatic.** Every run starts at the primary again, so the first run after the primary recovers uses it. The weekly health job closes the issue once every link is healthy.
- **Bad data never replaces good data.** Downloads go to a temporary file and are renamed into place only after every check passes. If every link fails, the local copy is untouched, `AllLinksFailed` is raised, and the issue says "updates paused".
- **Credentials.**
  - If `ARCHIVE_READ_TOKEN` is missing in CI, the archive step fails with a message naming the secret.
  - In a pull request from a fork (no secrets are passed), the archive step is skipped with a notice instead.

## Sources and their fallback chains

Verified 2026-10-21; all upstream links answered the health probe. The chain order is the order `fetch()` tries.

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

HDX, MLIT, NetCDF and the shapefile zips have a different schema or format. An automatic switch would feed the pipeline data it can't parse. The archive holds identical bytes to the pinned primary, so it sits **before** them in the chain. The first design listed "geoBoundaries → HDX → archive"; this order is a deliberate change. Using a manual mirror is a runbook step.

## The archive

- **What:** `abrycta/typhoon-replay-archive`, a private repo generated by `archivekit init typhoon-replay`.
- **Storage:** one GitHub Release per snapshot, tag `<id>-<YYYY-MM-DD>`. Each release holds the zstd asset, `manifest.json` and `SHA256SUMS`. GitHub allows up to 1,000 assets per release, each under 2 GiB.
- **Workflow:** a weekly caller workflow runs the kit's reusable `snapshot.yml` and `health.yml`.
- **Snapshots only when something changed.** The checks run cheapest first:
  1. the pinned sha256 is already archived (no request at all);
  2. a HEAD request shows the same ETag or Last-Modified;
  3. the downloaded content has the same sha256.
- **Compression: zstd.** Level 19 below 150 MB raw, 15 above. Measured on 2026-10-21:

  | File | Raw | gzip -9 | zstd -19 | zstd -15 |
  |---|---|---|---|---|
  | IBTrACS WP CSV | 114.6 MB | 9.48 MB (3.9 s) | **7.10 MB, 16.1×** (9.2 s) | — |
  | geoBoundaries PHL ADM3 | 532.1 MB | — | 108.7 MB (102 s) | **142.3 MB** (40 s) |

  zstd -19 is about 25 % smaller than gzip -9 and decompresses faster. On the 532 MB GeoJSON, level 15 saves a minute of shared private-repo runner time per snapshot.
- **Licences.** These are private copies for resilience only. Nothing in the archive is redistributed; only processed data is published, with each source's attribution.
- **Restore by hand:**

  ```sh
  gh release download ibtracs-wp-2026-10-21 -R abrycta/typhoon-replay-archive -D restore/
  ```

  Or run `uv run python -m typhoon.sources restore ibtracs-wp --out restore/`, which also verifies the checksums.

## Detection

1. **During every pipeline run.** Fallback and failure warnings, and auto-opened issues in the archive repo (see above).
2. **The weekly health job** runs in the private archive repo, because public repos can't call the private kit's reusable workflows. It checks every registry link with a ranged 64 KiB GET:
   - reachability and status;
   - HTML instead of data;
   - permanent redirects (a hint that the registry URL needs updating);
   - Content-Range size against the bounds;
   - the CSV header fingerprint, or the GeoJSON/XML/JSON shape.

   It also checks that each archived source has a release, and the expiry of `ARCHIVE_READ_TOKEN` (an issue opens 30 days ahead). It keeps one issue per source, labelled `source-health`, and closes it when healthy.
   - **Issues live in the private archive repo, not the public one.** Upstream URLs are public, but the issues would reveal the archive's structure and tags, and they are operational noise.
   - **The job reads the registry from this repo's raw URL on `main`**, so it is always in sync with the pipeline.
3. **Data-quality gates.** `pipeline/tests/test_ibtracs.py` covers row counts, SID×time uniqueness, ranges, monotonic time, units and known storms, and the frame checks follow the same pattern. A failed gate blocks publishing.

## Dataset versions: atomic publish and rollback

Frames and Parquet go to the Hugging Face dataset `permission-alluring/typhoon-replay` (per DECISIONS.md).
The pipeline is `typhoon.dataset` (assemble + gates) and `typhoon.publish` (upload, verify, flip).
- **Immutable versions.** Each run that publishes builds data version `N` (an integer, next after the
  published one) under `v<N>/`: `index.json`, `manifest.json`, `storms/<sid>/…`, `places/…`, `tables/*.parquet`.
  Nothing under an existing `v<N>/` is modified afterwards; the version is tagged `data-v<N>`.
- **Incremental.** A storm whose summary, track and frames are unchanged keeps pointing at the earlier
  version's folder (`index.json` `path`), and frames are rebuilt only when IBTrACS changed the storm's
  hourly track (`trackHash`). A weekly refresh therefore uploads a few storms, not 18 GB.
- **Gates first.** `dataset.check` verifies every file's checksum against the manifest, the 25 MiB per-file
  cap, `.tyf` headers, WebP sheets byte-identical to the `.tyf` planes, nodata, plausible ERA5 ratios and
  referential integrity of the tables; `pytest -m data` checks the catalogue, places and exposure. Batch jobs
  validate each storm's frames before uploading them. `publish.verify` then checks every uploaded file's
  size and that a frame answers HTTP Range requests (206) with CORS.
- **One pointer flip.** Only then does one commit write `README.md` (the dataset card) and `latest.json`:

  ```json
  {"dataVersion": 1, "path": "v1/", "index": "v1/index.json", "manifest": "v1/manifest.json",
   "publishedAt": "…", "dataAsOf": "…", "archiveUsed": false, "previous": null}
  ```

  `manifest.json` carries `archivekit.data_version_metadata()` (`inputs`, `archive_used`, `data_as_of`), the
  ERA5 reads per link, the attribution of every source and the checksum of every file. The app reads
  `latest.json` (short cache) and then only versioned, immutable paths, so a half-uploaded version is never
  visible.
- **Rollback** is `python -m typhoon publish rollback --to <N>`: one commit pointing `latest.json` at an
  older version still in the repo. Nothing is deleted. Old versions stay while a retained version
  references their folders.
- **Database.** `typhoon.dbload` loads a version's `tables/` into the catalogue schema (COPY into
  `catalog_next`, validate, swap all tables and insert the `dataset_version` row in one transaction).
  Rolling the database back means loading the previous version's tables (a new, higher dataset_version).
- **Attribution.** The dataset card lists every source's `attribution` from the registry. Derived files keep
  CC BY-SA where it applies (PAGASA names) and ODbL for the OSM-derived romanised JP names.

## Live tracker: degrading gracefully

- **Recording health.** The ingestion job (GitHub Actions, every 30 min) records each feed's last success and last error per source id, e.g. an `ops.source_status` table. A failing feed pauses ingestion for that feed; `live.active_storm` keeps its last values and `updated_at`.
- **What the UI shows, by data age:**

  | Age of the newest live data | UI |
  |---|---|
  | < 1 h | Normal; a small "updated 12 min ago" |
  | 1–6 h | Amber "last updated 3 h ago"; the storm track stays on screen |
  | > 6 h, or the feed has errored | Banner: "Live updates paused: <JTWC/JMA> feed unreachable since 09:00 UTC. Showing the last known position." Links to the official JTWC, JMA and PAGASA pages |
  | > 24 h and no active advisories | The live panel collapses to "No live data" plus the official links; the historical replay is unaffected |

- **Archive data in the replay.** When an input came from the archive, the replay footer reads "Best-track data as of 2026-10-18 (archived copy)", taken from `current.json`.

## Runbook

| Situation | What happens automatically | What to do |
|---|---|---|
| **A source is down** (NCEI outage) | The next link serves (for IBTrACS WP: the ALL subset, then the archive). The issue `source-health: ibtracs-wp` opens in the archive repo. Publishing continues; the app shows "data as of" if the archive served | Nothing, unless it lasts more than about two weeks; then look for a new official mirror |
| **A source moved** (redirect to HTML, 404, or a 301/308 flagged by health) | Fallback; the issue names the link and the redirect target | Edit the URL in `pipeline/sources.yaml` (one line), merge, and let the next health run close the issue. Check the new URL serves identical bytes (`archivekit fetch <id> --out /tmp/x`, compare the sha256) |
| **A source is gone for good** | The archive keeps serving the last snapshot, with "data as of" in the app | Set `status: retired` on the source, note it on the About page, and consider promoting a manual mirror: write the adapter, then set `automatic: true` |
| **The schema changed** | Missing required columns: that link fails and the next one serves (often the archive). Columns only added: a "schema drift" warning and issue; the data is used | Update `typhoon/ibtracs.py` (or the relevant parser), `required_columns` and `header_sha256` in the registry, and the tests; re-run the pipeline |
| **Bad data was published** (should be caught by the gates) | — | Roll back: point `current.json` at the previous `data_version` (one commit). Add a test or registry check that catches the problem, then re-run |
| **Archive copy corrupt** (`archive-integrity` in the error) | That run fails clearly; nothing is replaced | `archivekit restore <id> --date <older date>` to inspect; delete the bad release; re-run the snapshot workflow for that source |
| **`token-expiry` issue** | Opens 30 days before `ARCHIVE_READ_TOKEN` expires | Regenerate the token with the same settings; update the secret in **both** repos and `health.token_expires` |
| **Fork PR or first run without the token** | The archive step and pipeline CI skip with a notice | Nothing, or create the token |

## Files

- `pipeline/sources.yaml`: the registry, validated against the kit's JSON Schema.
- `pipeline/typhoon/sources.py`: the adapter (`fetch`, `registry`, the `check_ibtracs` hook). Run `python -m typhoon.sources <fetch|snapshot|health|restore|validate-registry>`.
- `pipeline/tests/test_sources.py`: the registry contents, chain order, local pins, hook, and the WP → ALL-subset → archive path.
- `pipeline/tools/use-archivekit-tag.sh`: switches the path dependency on `../../data-archive-kit` to the tagged release.
- `abrycta/typhoon-replay-archive`: the caller workflow and README.

## Setup still to do (user)

1. **Create `ARCHIVE_READ_TOKEN`.** It is a fine-grained token on `data-archive-kit` and `typhoon-replay-archive`:
   - Contents: read;
   - Issues: read and write;
   - 1-year expiry.

   Add it as a secret here and in `typhoon-replay-archive`, and set `health.token_expires` in `sources.yaml`.
2. **After the kit is tagged** `v1.0.0`, run `pipeline/tools/use-archivekit-tag.sh`.
3. **Add a pipeline CI job** when the pipeline gets one. The existing `ci.yml` runs only the web checks. Use the job in the kit's `docs/ADOPTING.md` §5, which installs the kit with the token and skips with a notice when the token is absent.
