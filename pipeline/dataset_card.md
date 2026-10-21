---
license: other
license_name: mixed-attribution
license_link: https://huggingface.co/datasets/permission-alluring/typhoon-replay/blob/main/README.md#licences
pretty_name: Typhoon Replay
language:
- en
- ja
tags:
- tropical-cyclones
- typhoons
- era5
- ibtracs
- philippines
- japan
- reanalysis
size_categories:
- 1M<n<10M
configs:
{{CONFIGS}}
---

# Typhoon Replay

Western North Pacific typhoons that affected the **Philippines or Japan since 1940**, prepared for the
[Typhoon Replay](https://github.com/abrycta/typhoon-replay) web app: a storm catalogue with best tracks,
landfalls, PAGASA and JMA names, "typhoons that hit my town" exposure for every Philippine city or
municipality and every Japanese municipality, and hour-by-hour ERA5 wind, gust, pressure and rain fields
that follow each storm.

**Current data version: {{VERSION}}** (built {{CREATED}}; best-track data as of {{DATA_AS_OF}}).
`latest.json` at the repository root always names the published version.

| | |
|---|---|
| Storms in the catalogue | {{STORMS}} (IBTrACS WP since 1940 that entered the PAGASA Area of Responsibility or made landfall in PH/JP) |
| Storms with ERA5 replay frames | {{REPLAY}} in this version |
| Observed best-track fixes | {{FIXES}} |
| Places | {{PLACES}} (PH cities/municipalities by 10-digit PSGC, JP municipalities by JIS X 0402 code) |
| Place x storm exposure rows | {{EXPOSURE}} |

## ERA5 limitation (read this)

{{HONESTY}}

Across the storms with frames in this version, the median ratio of ERA5's strongest 10 m wind near the
centre to the best-track peak (JTWC 1-minute where available) is **{{MEDIAN_RATIO}}**. Each storm's
`summary.json` (`era5VsBestTrack`) gives its own ratios against JTWC and JMA, at the peak and over all
typhoon-strength hours, and the ERA5-vs-best-track central pressure bias.

## Layout

```
latest.json                              {"dataVersion": N, "path": "vN/", ...}  (flipped last)
vN/index.json                            every storm, columnar: names, season, peak, landfall, bbox, path
vN/manifest.json                         provenance of every input, attribution, counts
vN/files.json                            size and sha256 of every file of the version (frames included)
vN/frames-index/<season>.json            pipeline bookkeeping: frame records + track hashes, for reuse
vN/storms/<sid>/summary.json             storm detail + frame manifest (paths relative to the repo root)
vN/storms/<sid>/track.json               observed fixes + hourly interpolated track (columnar)
vN/storms/<sid>/og.png                   1200x630 share image
vN/selection.json                        which storms have frames, and the documented score
frames/<sid>/<sha>.field.<var>.webp      replay frames (lossy WebP, hourly), shared by all versions
frames/<sid>/<sha>.exact.<var>.webp      exact values every 3 hours at 0.5 deg (lossless WebP)
frames/<sid>/<sha>.tyf                   the same frames, lossless TYF1 (only some storms)
vN/places/index.json, <shard>.json       places per PH province / JP prefecture with their storm exposure
vN/places/<shard>.geojson                display boundaries (at most 1,500 vertices per place)
vN/stats/seasons.json                    per season: storms by intensity class, PH/JP landfalls, ACE, strongest
vN/stats/climatology.json                storms forming per month x decade; landfalls per month by country
vN/stats/admin.json                      per province / prefecture: storms within 100 km, landfalls, strongest
vN/stats/records.json                    top-10 lists (strongest, lowest pressure, ACE, rapid intensification...)
vN/tables.json                           this version's Parquet files (content-addressed, under tables/):
                                         exposure, hourly_tracks
```

Every `vN/` path and every content-addressed file (`frames/`, `places/`, `tables/`) is immutable. A later version may point a storm's `path` at an earlier version's folder
when nothing about that storm changed. Rolling back means pointing `latest.json` at an earlier version.

### Frames

Storm-following 81 x 81 windows at 0.25 deg (about +-10 deg around the best-track centre), hourly, for the
storms listed in `vN/selection.json` (a documented score: landfall, intensity, land crossed, PAGASA name,
recency, with a floor per decade). Values are uint8 codes: `wind` (10 m speed, 0.3 m/s steps), `gust`
(hourly max 10 m gust, 0.4 m/s), `mslp` (0.65 hPa from 870), `tp` (mean precipitation rate in the hour,
square-root coded, mm/h), `u`/`v` (0.6 m/s from -76.2), `wdir` (360/256 deg). 255 = no data.

- `field` sheets (lossy WebP, quality 80, one per variable, hourly) are for drawing and animation.
- `exact` sheets (lossless WebP, every 3rd hour, every other cell) carry exact values for readouts; the
  per-hour maxima near the centre and the ERA5-vs-best-track ratios are numbers in `summary.json`.
- `.tyf` (`"TYF1"`, uint32 header length, JSON header, `uint8[frames][vars][81][81]`) is lossless and
  range-friendly: one hour is one contiguous byte range.

Frame files are named by their sha256 and stored once under `frames/<sid>/`; every version's
`summary.json` points at them with paths relative to the storm directory.

ERA5 is read chunk by chunk from NSF NCAR's ERA5 copy (AWS, with OSDF as a mirror), falling back to
ARCO-ERA5 on Google Cloud for months NCAR has not published yet. `manifest.json` records which served.

### Exposure

For each place and storm whose hourly centre came within 500 km of the place boundary: closest approach
(km, and when), hours within 50/100/200/300/500 km, and the best-track sustained wind and gust (kt) while
the centre was within each radius. This is what the Typhoon Replay API serves at
`GET /v1/places/{placeId}/storms`.

## Sources and licences {#licences}

This dataset combines sources with different terms. Use it with all of the attributions below.

- **Contains modified Copernicus Climate Change Service information** (ERA5, CC BY 4.0). Neither the European
  Commission nor ECMWF is responsible for any use of this information. Hersbach et al. (2020),
  doi:10.1002/qj.3803; NSF NCAR RDA ds633.0, doi:10.5065/BH6N-5N20.
- **IBTrACS v04r01**, NOAA NCEI (Knapp et al. 2010, doi:10.1175/2009BAMS2755.1; Gahtan et al. 2024,
  doi:10.25921/82ty-9e16).
- **JMA typhoon numbers** from the RSMC Tokyo - Typhoon Center best track, Japan Meteorological Agency.
- **PAGASA local names** compiled from English Wikipedia season articles (CC BY-SA 4.0): the
  `pagasa_names` table and the `localNames.ph` values are share-alike.
- **Philippine boundaries**: geoBoundaries (Runfola et al. 2020), from NAMRIA and PSA via OCHA COD-AB
  (CC BY 3.0 IGO); codes from the Philippine Standard Geographic Code (PSA).
- **Japanese boundaries**: 出典「国土数値情報（行政区域データ）」（国土交通省）を加工して作成. Romanised municipality
  names © OpenStreetMap contributors (ODbL 1.0), via geoBoundaries.
- **Basemap** for share images: Natural Earth (public domain).

Everything else (the derived frames, tables and exposure) is CC BY 4.0 with the attributions above.

| Source id | Licence | Attribution |
|---|---|---|
{{ATTRIBUTIONS}}

## Versioning

Data versions are whole numbers. The pipeline (GitHub Actions in the project repo) builds a version,
runs every data-quality gate, uploads `vN/` and only then flips `latest.json` in a single commit, tagged
`data-vN`. If a check fails, nothing is flipped and the previous version keeps serving.
