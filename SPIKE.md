# Typhoon Replay — data spike 1 (2026-10-20/21)

Goal: prove the no-account data routes (IBTrACS + ERA5 from public buckets) end to end for one hero storm
(Haiyan/Yolanda 2013) and size the full catalogue against the free hosting limits. Earth Engine was **not**
used (no project registered yet).

## Reproduce

```sh
cd pipeline
uv sync
# raw inputs (gitignored, under data/raw/): IBTrACS WP CSV + Natural Earth 50m countries/coastline
#   https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.WP.list.v04r01.csv
#   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_{admin_0_countries,coastline}.geojson
uv run python -m typhoon.ibtracs            # -> data/processed/ibtracs/{fixes,storms}.parquet, summary.json
uv run pytest -q                            # 10 data-quality tests
uv run python -m typhoon.crosswalk          # -> pipeline/crosswalk/pagasa_names_sid.csv
uv run python -m typhoon.era5_arco          # Haiyan, ARCO-ERA5, ~80 s, ~3.1 GB read
uv run python -m typhoon.era5_ncar          # Haiyan, NCAR AWS byte count for one variable
uv run python -m typhoon.frames             # -> data/processed/frames/ (.tyf, sprites, track, report)
cd .. && python3 -m http.server 8000        # open http://localhost:8000/spike/viewer.html
```

| Path | What |
|---|---|
| `pipeline/typhoon/ibtracs.py` | IBTrACS CSV → tidy Parquet; PAR / PH / JP flags from Natural Earth polygons |
| `pipeline/tests/test_ibtracs.py` | row counts, SID×time uniqueness, lat/lon ranges, monotonic time, knot/hPa units, known storms |
| `pipeline/typhoon/era5_arco.py` | storm-following ±10° windows from ARCO-ERA5 (xarray path and direct-chunk path) |
| `pipeline/typhoon/era5_ncar.py` | exact chunk bytes and timing for the same windows from NSF NCAR ERA5 (AWS) |
| `pipeline/typhoon/frames.py` | uint8 quantisation, `.tyf` frame file, PNG/WebP sprites, ERA5 vs IBTrACS cross-check |
| `pipeline/typhoon/crosswalk.py`, `pipeline/crosswalk/` | PAGASA name seed (62 storms, sourced) and IBTrACS SID join |
| `spike/viewer.html` | throwaway canvas viewer (play/scrub, variable picker, best track, coastline) |

## 1. IBTrACS ingest (v04r01 WP, downloaded 2026-10-20, 114.6 MB)

| Measure | Value |
|---|---|
| Fixes (rows) / storms | **249,084 / 4,255** (seasons 1884–2026) |
| Storms since 1940 | **3,076** (2,934 `main`; the rest are 2025–26 `PROVISIONAL`/`US-PROVISIONAL` and spur tracks) |
| Storm-hours since 1940 (Σ last − first fix) | **581,721** (mean 189 h); longest 744 h (JOHN 1994, NOLO 2026) |
| Unique clock hours with ≥1 active storm since 1940 | **359,373** (storms overlap; relevant for global-chunk reads) |
| Entered PAGASA Area of Responsibility | 1,925 |
| Track crossed Philippine land (landfall_ph) | 760 |
| Track crossed Japanese land (landfall_jp) | 606 |
| Passed within ~200 km of Japan | 1,039 |
| **PH- or JP-affecting** (PAR ∪ JP landfall ∪ within 200 km of JP) | **2,346 storms, 479,961 storm-hours** |
| 4–46°N 116–146°E study box (earlier note said 2,529) | 2,515 |

Notes:
- The file has a units row (row 2) and blanks are single spaces. Winds are knots: USA = JTWC 1-min sustained; TOKYO/WMO = JMA 10-min. Pressures are hPa. Longitudes are stored 0–360 (WP storms reach 56–267°E).
- No duplicated (SID, ISO_TIME). Fixes are 3-hourly plus extra landfall fixes. Haiyan is `2013306N07162`; HAIYAN was also used in 2001 and 2007, so names alone are not keys.
- **IBTrACS has no PAGASA agency or PAGASA name column.** The agencies are USA, TOKYO, CMA, HKO, KMA, NEWDELHI, REUNION, BOM, NADI, WELLINGTON, DS824, TD9636/9635, NEUMANN and MLC.
- `first_ph_landfall_time` is the end of the first 3-h segment that crosses land, so it can be up to 3 h late. For Haiyan it gives 00:00 UTC 8 Nov; the actual landfall was 20:40 UTC 7 Nov. Refine with the hourly track later.

## 2. PAGASA crosswalk

- **Seed:** `pipeline/crosswalk/pagasa_names_seed.csv` has **62 storms (1970–2026)**, each with a Wikipedia source URL whose lead sentence states the PAGASA↔international pairing. Columns: landfall date where stated, JTWC number and notes.
- **Join:** `pagasa_names_sid.csv` matches **60/62 to a unique IBTrACS SID**. Each match is validated by entering the PAR and by the JTWC number agreeing with `USA_ATCF_ID`.
  - The 2 unmatched are PAGASA-only depressions with no international name (Usman 2018, Winnie 2004). They are in IBTrACS only as unnamed systems and need a time/position match.
  - The 2025–26 matches point at provisional tracks, whose SIDs can change at finalisation.
- **Scaling source:** the Wikipedia "YYYY Pacific typhoon season" pages, pulled as wikitext with `?action=raw`.
  - All 64 seasons from 1963 to 2026 carry storm headings like `=== Typhoon Joan (Sening) ===`, with 10–28 per year.
  - Throttle to under 1 request per second (HTTP 429 seen at about 1/s).
  - PAGASA Annual Reports (2017–2023 PDFs) can serve for spot checks.
- **Licence:** Wikipedia is CC BY-SA 4.0, so attribute it and share the derived CSV alike.
- **Gaps:**
  - Local names start in 1963, so there are none for 1940–62.
  - PAGASA names recycle on a 4-year set (Basyang = Conson 2010, Penha 2026) and international names recycle too, so join on name + season and add a date check.
  - Some PAGASA names map to no JMA name, or two PAGASA names map to one merged JMA system (e.g. Luis/Maymay 2026 → 2614).
  - A December storm can carry the following year's JMA number.

## 3. Hero storm: Haiyan/Yolanda via ARCO-ERA5

Store: `gs://gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3`. Access is anonymous (`token='anon'`), and the store is Zarr **format 2** despite the "v3" name.

- **Coverage:** attributes give **1940-01-01 → 2026-06-30 for ERA5, ERA5T to 2026-10-13**, updated 2026-10-19. This resolves the "ARCO start year" question in big-data-ideas §6: it starts in 1940.
- **Chunks:** every surface variable is chunked `(1 h, 721, 1440)` (one global hour), float32, blosc-lz4. The compressed objects are about 3.3 MB for u10/v10, 3.2 MB for `instantaneous_10m_wind_gust`, 2.2 MB for MSLP and 1.8–2.0 MB for `total_precipitation` (hourly accumulation, m).

Variables used: u10, v10 (→ speed and direction), instantaneous 10 m gust, MSLP, total precipitation. Each frame is a storm-following 81×81 window (±10° at 0.25°) centred on the IBTrACS track, linearly interpolated to hourly: **223 frames**, 2013-11-02 18:00 → 2013-11-11 00:00 UTC.

| Read path (Haiyan) | Frames | Bytes over network | Wall | Throughput |
|---|---|---|---|---|
| xarray lazy `open_zarr` + per-frame `.sel/.isel` | 12 | 238 MB (NIC) | 72.5 s | 3.3 MB/s |
| direct: `gcsfs.cat` of the exact chunk keys, 64 concurrent, numcodecs decode | 12 | 166 MB chunks / 177 MB NIC | 5.5 s | 32 MB/s |
| **direct, full lifetime** | **223** | **3.10 GB chunks / 3.31 GB NIC** | **78 s** | **42 MB/s** |

Chunking impact:
- **Only 0.63 % of each fetched chunk is used** (81×81 of 721×1440). The window size is free, and the hours drive the cost.
- One storm-hour (5 variables) costs **13.9 MB** of reads.
- Decoding and cutting take 0.6 s in total, so the work is network-bound.
- Naive per-frame xarray reads are about 13× slower than batched concurrent chunk fetches.

### NSF NCAR ERA5 on AWS (`s3://nsf-ncar-era5`, anonymous) — comparison

- **Layout:** monthly NetCDF-4 per variable. A month of `10u` is 1.48 GB, and the coverage is **1940-01 → 2026-07**, about a 3-month lag.
- **Spatial chunks:** HDF5 chunks are **(27 h, 139, 279), gzip-1**, i.e. tiled in space.

| Haiyan ±10° windows, one variable | ARCO bytes | NCAR bytes (exact, from chunk index) | NCAR wall (sequential h5py over s3fs) |
|---|---|---|---|
| 10 m u | ~740 MB | **35.0 MB (16 chunks)** | 11.7 s |
| MSLP | ~486 MB | **22.1 MB (16 chunks)** | 10.6 s |

**About 21× less I/O than ARCO.** Caveats:
- NCAR has **no instantaneous gust**. It has only `10fg`, the max gust since the previous post-processing (hourly max), in `e5.oper.fc.sfc.minmax`.
- Precipitation is forecast accumulations (`lsp` + `cp` in `fc.sfc.accumu`, 06/18 UTC initialisations) and needs de-accumulating.
- Recent storms are not available until about 3 months later.
- Data is under UCAR terms on top of the ERA5 CC BY 4.0.

## 4. Quantised frame file

`.tyf` = `"TYF1"` + uint32 header length + JSON header (padded to 8 bytes) + `uint8[frames][vars][81][81]` (row 0 = north). The header carries the per-frame NW corner, unix times, encodings, source and the Copernicus credit.

| Var | Units | Encoding | Scale / offset | Range | Haiyan max abs error (RMSE) |
|---|---|---|---|---|---|
| wind (from u/v) | m/s | linear | 0.3 / 0 | 0–76.2 | 0.15 (0.087) |
| gust (instantaneous) | m/s | linear | 0.4 / 0 | 0–101.6 | 0.20 (0.115) |
| mslp | hPa | linear | 0.65 / 870 | 870–1035.1 | 0.33 (0.19) |
| tp | mm/h | sqrt: v = (q·0.04)² | 0.04 / 0 | 0–103.2 | 0.20 (0.017) |
| wdir (towards) | deg | angle: q·360/256 | 1.406 | 0–360 | ≤0.7° |

255 = nodata. No values were clipped for Haiyan.

| Haiyan output | Size |
|---|---|
| `.tyf` (5 vars × 223 frames) | **7.32 MB (6.98 MiB)** |
| `.tyf` gzip -9 (≈ what Pages serves compressed) | 3.74 MB |
| WebP-lossless sprite sheets (15×15 tiles, one per var), total | **2.19 MB** (wind 400 KB, gust 428 KB, mslp 182 KB, tp 571 KB, wdir 613 KB) |
| PNG sprite sheets, total | 2.40 MB |

### Extrapolation (32,831 B per storm-hour raw)

| Scope | Raw `.tyf` | gzip | WebP sprites (×0.30) |
|---|---|---|---|
| All 3,076 storms since 1940 (581,721 h) | **19.1 GB** | 9.7 GB | ~5.7 GB |
| 2,346 PH/JP-affecting storms (479,961 h) | 15.8 GB | ~8.0 GB | ~4.7 GB |

- **Per storm:** mean 5.95 MiB. The longest (745 frames) is **23.3 MiB**, under Pages' 25 MiB/file cap but with only 1.7 MiB headroom. Four storms exceed 20 MiB and none exceeds 25 MiB.
- **File count:** 3,076 files is well under the 20,000-file cap.

**Fit to free limits:** yes, per file and per file count. Still to confirm:
- whether Pages accepts about 19 GB total and re-uploads only changed files (hash dedupe);
- whether a public Hugging Face dataset is the better home for the bulk frames, with Pages carrying only the app.

Easy reductions:
- drop `wdir` (−20 %);
- ship WebP sprites (−70 %, and the browser decodes them natively);
- split storms over 500 h into weekly segments.

## 5. Cross-check: ERA5 vs IBTrACS (Haiyan) — the honesty note

Max ERA5 10 m wind within 2° of the IBTrACS centre, hourly:

| | JTWC 1-min | JMA 10-min | ERA5 max 10 m wind | Ratio vs JTWC | Ratio vs JMA | ERA5 gust | ERA5 min MSLP vs JMA |
|---|---|---|---|---|---|---|---|
| At JTWC peak (2013-11-07 12 UTC) | 87.5 m/s (170 kt) | 64.3 m/s (125 kt) | 26.9 m/s | **0.31** | **0.42** | 39.5 m/s | 982.9 vs 895 hPa |
| Lifetime max | 87.5 | 64.3 | 28.9 | 0.33 | 0.45 | 45.0 | 971.8 vs 895 hPa |
| Median over 144 typhoon-strength hours | | | | 0.38 | 0.53 | | |

Suggested app wording: *"Wind and rain fields are ERA5 reanalysis (~28 km grid). For intense typhoons it smooths the eye wall: at Haiyan's peak, ERA5's strongest 10 m wind was about a third of the JTWC best-track estimate (0.31×) and under half of JMA's 10-minute estimate (0.42×), and its central pressure was 88 hPa too high. Use the best-track intensity for peak strength and the field for spatial extent and timing."* The Holland-vortex core blend (big-data-ideas §2 risk 1) is the main data-quality stretch goal.

## 6. Viewer

`spike/viewer.html` (plain JS, no build) fetches `../data/processed/frames/<sid>.tyf`, `<sid>_track.json` and `coast.json` (Natural Earth 50 m, simplified). It decodes frames through a 256-entry LUT and draws each storm window on an equirectangular canvas with the best track, the current centre and an ERA5-vs-best-track readout. It has play/scrub, fps and a variable picker; `?sid=` picks the storm.

Verified:
- `node --check` on the extracted script;
- `python -m http.server` from the repo root: all 4 fetch paths return 200;
- a Node harness running the viewer's own `parseTYF`/`decodeFn` against the served file decodes 223 × 5 × 81×81 with a max wind of 28.80 m/s (float max 28.93, within one quantisation step).

The server was stopped afterwards. It was not visually checked in a browser (no headless Chrome on this machine).

## 7. Recommendation: data route for the full pipeline

1. **Default to no-account routes; Earth Engine becomes optional.** This spike shows the whole catalogue is reachable without any account:
   - **NSF NCAR ERA5 (AWS):** primary for u10/v10/MSLP/10fg/precipitation on 1940 → (now − 3 months). Spatial chunks make it about 21× cheaper in I/O than ARCO: an estimated 0.6–0.9 MB per storm-hour for 5 variables, so roughly **0.4–0.5 TB** for all storms since 1940.
     - Estimate only: u/v/MSLP were measured, while gust and precipitation come from other file families with the same chunking.
     - Use `10fg` (hourly max gust) instead of instantaneous gust; it is arguably the better "gust" for an impact map.
   - **ARCO-ERA5 (GCS):** for the ERA5T tail (the last ~3 months, so new storms appear within about a week), hero storms and the independent cross-check. As a brute-force fallback for everything, fetch each global hour once and cut every active storm's window from it: 359,373 unique hours × 13.9 MB ≈ **5.0 TB**, about 33 h at the 42 MB/s measured here. That is spread over the GitHub Actions matrix (public repo minutes are free; per-runner bandwidth is unmeasured).
2. **Earth Engine** would cut egress to near zero (`computePixels` subsets server-side). It would still cost a project registration, the 150 EECU-h/month quota (unmeasured) and the noncommercial terms. Register only if the per-LGU `reduceRegions` exposure step proves easier there. Otherwise do that step in the pipeline with GeoPandas/rasterio on the same windows, which removes the quota risk and the overlap with project A.

## Risks found

- **ERA5 underestimates peak winds by 2–3×** in intense typhoons (§5), so the UI must say so.
- The **longest storms nearly hit 25 MiB** (23.3 MiB). The format needs segmenting or WebP before production.
- **2025–26 IBTrACS tracks are provisional.** SIDs and positions may change, so re-run on every IBTrACS update.
- **The crosswalk depends on CC BY-SA Wikipedia text.** Both name sets are reused, and merged or unnamed systems need manual rows.
- **NCAR differs from ARCO:** no instantaneous gust, accumulated precipitation needs de-accumulating, it lags about 3 months, and UCAR terms apply.
- **ARCO costs:** about 14 MB per storm-hour regardless of window, so ~5 TB from a public bucket. That is acceptable but heavy; prefer NCAR.
- **Landfall times** from 3-hourly segments can be up to 3 h late, and the 50 m coastline misses small islets.

## Next steps

1. Write `era5_ncar.py` as a full frame extractor (5 vars incl. `10fg` and de-accumulated `lsp+cp`). Check it against the ARCO Haiyan frames: expect identical u/v/MSLP and gust within 10fg-vs-i10fg differences.
2. Run 10 storms (Haiyan, Rai, Goni 2020, Ketsana, Bopha, Mangkhut, Hagibis, Jebi, Mike 1990, an 1940s storm) and measure the per-storm time and bytes on a GitHub Actions runner.
3. Segment the frame files (≤ 7 days per file) or switch to WebP sprites. Decide the hosting split (Pages for the app, HF dataset for frames and Parquet).
4. Scrape the 1963–2026 Wikipedia season pages into the crosswalk (throttled), and add time/position matching for unnamed systems.
5. Build the exposure tables (storm-max wind/gust/rain per PH ADM3 and JP municipality) as partitioned Parquet, and query them with DuckDB-WASM.
6. Prototype the Holland-vortex core blend from IBTrACS RMW/R34 to address the underestimate.
