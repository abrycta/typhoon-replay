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
- config_name: storms
  data_files: "v{{VERSION}}/tables/storms.parquet"
- config_name: storm_fixes
  data_files: "v{{VERSION}}/tables/storm_fixes.parquet"
- config_name: storm_landfalls
  data_files: "v{{VERSION}}/tables/storm_landfalls.parquet"
- config_name: places
  data_files: "v{{VERSION}}/tables/places.parquet"
- config_name: exposure
  data_files: "v{{VERSION}}/tables/exposure.parquet"
- config_name: hourly_tracks
  data_files: "v{{VERSION}}/tables/hourly_tracks.parquet"
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
| Storms with ERA5 replay frames | {{REPLAY}} in this version (the full backfill adds the rest) |
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
vN/manifest.json                         provenance of every input, attribution, checksums of every file
vN/storms/<sid>/summary.json             storm detail + frame manifest (paths relative to the repo root)
vN/storms/<sid>/track.json               observed fixes + hourly interpolated track (columnar)
vN/storms/<sid>/og.png                   1200x630 share image
vN/storms/<sid>/<sid>.s<k>.tyf           frames, 7-day segments (see below)
vN/storms/<sid>/<sid>.s<k>.<var>.webp    the same frames as lossless WebP sprite sheets
vN/places/index.json, <shard>.json       places per PH province / JP prefecture with their storm exposure
vN/places/<shard>.geojson                display boundaries (at most 1,500 vertices per place)
vN/tables/*.parquet                      storms, storm_fixes, storm_landfalls, pagasa_names, places,
                                         exposure, hourly_tracks
```

Every `vN/` path is immutable. A later version may point a storm's `path` at an earlier version's folder
when nothing about that storm changed. Rolling back means pointing `latest.json` at an earlier version.

### Frames

Storm-following 81 x 81 windows at 0.25 deg (about +-10 deg around the best-track centre), hourly. Five
variables quantised to uint8: `wind` (10 m speed, 0.3 m/s steps), `gust` (hourly max 10 m gust, 0.4 m/s),
`mslp` (0.65 hPa from 870), `rain` (mean precipitation rate in the hour, square-root coded, mm/h), `wdir`
(direction the wind blows towards, 360/256 deg). 255 = no data.

`.tyf`: `"TYF1"`, uint32 header length, JSON header (variables, encodings, per-frame time and NW corner),
then `uint8[frames][vars][81][81]`. One hour is one contiguous byte range, so a client can fetch any hour
with a single HTTP range request (Hugging Face `resolve` URLs answer 206 with CORS). The WebP sheets hold
the same bytes: one greyscale lossless sheet per variable and segment, frames row-major in a grid.

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
