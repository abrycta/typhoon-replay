"""Assemble a data version: the static layout the web app reads, plus Parquet tables and the manifest.

Usage: uv run python -m typhoon.dataset build --version 1 [--previous-index URL_or_path]
       uv run python -m typhoon.dataset check --version 1

Layout (relative to the dataset root; every path is immutable once published):

    latest.json                         pointer: {"dataVersion": 1, "path": "v1/", ...}  (flipped last)
    v<N>/index.json                     every catalogue storm, columnar (small; the app's storm index)
    v<N>/manifest.json                  provenance (archivekit), attribution, ERA5 honesty note, checksums
    v<N>/storms/<sid>/summary.json      storm detail + frame manifest (paths are dataset-root relative)
    v<N>/storms/<sid>/track.json        observed fixes + hourly interpolated track (columnar)
    v<N>/storms/<sid>/og.png            1200x630 Open Graph image
    v<N>/storms/<sid>/<sid>.s<k>.tyf    replay frames, 7-day segments (only storms with frames)
    v<N>/storms/<sid>/<sid>.s<k>.<var>.webp   the same frames as lossless WebP sprite sheets
    v<N>/places/index.json              shards with bbox and place count
    v<N>/places/search.json             compact search index for "My town" (one row per place)
    places/<shard>/<hash>.json          places of one PH province / JP prefecture + their storm exposure (shared)
    places/<shard>/<hash>.geojson       display geometry (<= 1,500 vertices per place) (shared)
    v<N>/tables/*.parquet               contract-shaped tables (typhoon.tables; loaded by typhoon.dbload)

Incremental versions: when `--previous-index` is given, a storm whose files are byte-identical to the
previous version keeps pointing at the previous version's folder (index.json `path`), so a weekly refresh
uploads only what changed. Old folders stay as long as a retained version references them.
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import io
import json
import logging
import math
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import shapely

from . import catalog, exposure, og, sources, stats, tables
from . import places as places_mod
from .config import BUILD, ERA5_HONESTY, HF_REPO, PROCESSED, ensure_dir
from .frames import ENC, MAX_FILE_BYTES, parse_tyf, unsheet, var_meta
from .frames import OUT as FRAMES_DIR
from .track import AGENCY_COLUMNS, lon180

log = logging.getLogger("typhoon.dataset")
SCHEMA = "typhoon-replay/dataset@1"
FRAMES_ROOT = "frames"   # content-addressed frame files, shared by every data version
INDEX_MAX_BYTES = 2_500_000   # raw; about 200 kB gzipped
# Budget for every other JSON the web app fetches before it can draw a page (manifest.json for the footer,
# places/index.json, and a storm page's summary.json + track.json). JSON gzips about 8x, so 1 MB raw is
# ~125 kB over the wire and well under 50 ms of JSON.parse on a mid-range phone; each of these files is a
# small fraction of it today. Frame files are streamed by range and are not part of this budget.
PAGE_LOAD_MAX_BYTES = 1_000_000
PAGE_LOAD_FILES = ("manifest.json", "places/index.json")


def iso(t: Any) -> str | None:
    if t is None or (not isinstance(t, str) and pd.isna(t)):
        return None
    return pd.Timestamp(t).tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")


def num(v: Any, nd: int | None = None) -> Any:
    if v is None or (isinstance(v, float) and not math.isfinite(v)) or v is pd.NA:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    if nd is None:
        return int(round(float(v)))  # noqa: RUF046
    return round(float(v), nd)


def clean(o: Any) -> Any:
    """NaN/NA -> None, numpy scalars -> Python, recursively (JSON has no NaN; the contract omits unknowns)."""
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, np.ndarray)):
        return [clean(v) for v in o]
    if isinstance(o, np.generic):
        o = o.item()
    if isinstance(o, float) and not math.isfinite(o):
        return None
    if o is pd.NA or o is pd.NaT:
        return None
    return o


def dumps(o: Any) -> bytes:
    return json.dumps(clean(o), ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def git_commit() -> str | None:
    try:
        return subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True,
                              cwd=Path(__file__).parent).stdout.strip()
    except Exception:  # noqa: BLE001
        return os.environ.get("GITHUB_SHA")


# ----------------------------------------------------------------------------- per storm documents

def local_names(s: Any) -> dict[str, str]:
    out = {}
    if isinstance(s.name_pagasa, str):
        out["ph"] = s.name_pagasa
    if isinstance(s.name_ja, str):
        out["ja"] = s.name_ja
    return out


def omit(d: dict[str, Any]) -> dict[str, Any]:
    """The contract omits unknown fields rather than sending null."""
    return {k: v for k, v in d.items() if v is not None}


DATA_SOURCES = {  # contract DataSource objects referenced by summary.json `sources`
    "ibtracs-v04r01": {"id": "ibtracs-v04r01", "name": "IBTrACS v04r01 (NOAA NCEI)",
                       "url": "https://www.ncei.noaa.gov/products/international-best-track-archive",
                       "license": "Full and open access (WMO Resolution 40)"},
    "era5": {"id": "era5", "name": "ERA5 hourly single levels (Copernicus C3S/ECMWF; NSF NCAR ds633.0, ARCO-ERA5)",
             "url": "https://doi.org/10.24381/cds.adbb2d47", "license": "CC BY 4.0"},
    "jma-rsmc-besttrack": {"id": "jma-rsmc-besttrack", "name": "RSMC Tokyo best track (JMA)",
                           "url": "https://www.jma.go.jp/jma/jma-eng/jma-center/rsmc-hp-pub-eg/besttrack.html",
                           "license": "JMA website terms of use"},
    "pagasa-crosswalk": {"id": "pagasa-crosswalk", "name": "PAGASA names (curated crosswalk and Wikipedia season articles)",
                         "url": "https://github.com/abrycta/typhoon-replay/tree/main/pipeline/crosswalk",
                         "license": "CC BY-SA 4.0"},
}


def track_doc(s: Any, fixes: pd.DataFrame, hourly: pd.DataFrame) -> dict[str, Any]:
    """track.json: observed fixes (TrackFix objects) and the pipeline's hourly track (`hours`)."""
    f = fixes.sort_values("observed_at")
    h = hourly.sort_values("time")
    fix_t = np.array([int(pd.Timestamp(t).timestamp()) for t in f.observed_at])
    out_fixes = [omit({
        "t": iso(r.observed_at), "lon": num(r.lon, 2), "lat": num(r.lat, 2),
        "jtwcKt": num(r.jtwc_wind_kt), "jtwcHpa": num(r.jtwc_pressure_hpa),
        "jmaKt": num(r.jma_wind_kt), "jmaHpa": num(r.jma_pressure_hpa),
        "windKt": num(r.wind_kt), "windAgency": r.wind_agency if isinstance(r.wind_agency, str) else None,
        "pressureHpa": num(r.pressure_hpa), "nature": r.nature if isinstance(r.nature, str) else None,
        "overLand": (num(r.dist_to_land_km) == 0) if num(r.dist_to_land_km) is not None else None,
    }) for r in f.itertuples()]
    hours = []
    for r in h.itertuples():
        t = int(pd.Timestamp(r.time).timestamp())
        d: dict[str, Any] = {"t": t, "lon": num(track_lon(r.lon), 3), "lat": num(r.lat, 3),
                             "jtwcKt": num(r.jtwc_wind_kt), "jmaKt": num(r.jma_wind_kt),
                             "jmaHpa": num(r.jma_pressure_hpa), "windKt": num(r.wind_kt),
                             "agency": r.wind_agency or None, "observed": bool(r.observed)}
        if not r.observed and len(fix_t):
            i = int(np.searchsorted(fix_t, t))
            if 0 < i < len(fix_t):
                d["between"] = [int(fix_t[i - 1]), int(fix_t[i])]
        hours.append(omit(d))
    return {"sid": s.sid, "name": s["name"],
            "note": "fixes: observed best-track fixes (IBTrACS rows with an original O flag). hours: hourly track "
                    "interpolated linearly in time between IBTrACS rows by the pipeline; `between` names the observed "
                    "fixes around an interpolated hour. Winds in knots: JTWC 1-min, JMA 10-min.",
            "fixes": out_fixes, "hours": hours}


def track_lon(lon: float) -> float:
    return float(lon180(lon))


def rel(path: str, storm_base: str) -> str:
    """A dataset-root path as seen from the storm directory (frames may live in an earlier version)."""
    return path[len(storm_base):] if path.startswith(storm_base) else "../../../" + path


def frames_entry(meta: dict[str, Any], sid: str) -> dict[str, Any]:
    """frames.json -> the frames record, with dataset-root paths frames/<sid>/<content-addressed file>."""
    base = f"{FRAMES_ROOT}/{sid}/"
    m = json.loads(json.dumps(meta))
    files = m.pop("files")
    for k in ("field", "exact"):
        for v in files[k]["vars"]:
            v["path"] = base + v.pop("file")
    if "tyf" in files:
        files["tyf"]["path"] = base + files["tyf"].pop("file")
    m.pop("sid", None)
    return dict(m, **files)


def frame_files(fr: dict[str, Any]) -> list[tuple[str, int, str]]:
    """(root path, bytes, sha256) of every file a frames record references."""
    out = [(v["path"], v["bytes"], v["sha256"]) for k in ("field", "exact") for v in fr[k]["vars"]]
    if "tyf" in fr:
        out.append((fr["tyf"]["path"], fr["tyf"]["bytes"], fr["tyf"]["sha256"]))
    return out


def summary_frames(fr: dict[str, Any], storm_base: str) -> dict[str, Any]:
    """The summary's `frames` (web/docs/DATA-LAYOUT.md): format/path/bytes/... of the .tyf when there is one,
    plus the WebP sets and the per-frame geometry; paths relative to the storm directory."""
    out = json.loads(json.dumps(fr))
    out.pop("era5VsBestTrack", None)
    for k in ("field", "exact"):
        for v in out[k]["vars"]:
            v["path"] = rel(v["path"], storm_base)
    tyf = out.pop("tyf", None)
    if tyf:
        out.update(format="tyf", path=rel(tyf["path"], storm_base), bytes=tyf["bytes"], sha256=tyf["sha256"],
                   headerBytes=tyf["headerBytes"], frameBytes=tyf["frameBytes"],
                   vars=[{k: v for k, v in var_meta(e).items()} for e in ENC])
    else:
        out["format"] = "webp"
    return out


AFFECTED_RADIUS_KM = 100
AFFECTED_MAX = 100


def place_summary(p: Any) -> dict[str, Any]:
    return omit({"id": p.place_id, "country": p.country, "kind": p.kind, "name": p.name,
                 "nameJa": p.name_ja if isinstance(p.name_ja, str) else None, "admin1": p.admin1,
                 "admin1Ja": p.admin1_ja if isinstance(p.admin1_ja, str) else None,
                 "admin2": p.admin2 if isinstance(p.admin2, str) else None,
                 "centroid": [num(p.centroid_lon, 4), num(p.centroid_lat, 4)]})


def affected_places(ex: pd.DataFrame | None, places: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Contract PlaceHit[] within AFFECTED_RADIUS_KM, closest first (best-track based, like the API)."""
    if ex is None:
        return []
    e = ex[ex.closest_approach_km <= AFFECTED_RADIUS_KM].sort_values(["closest_approach_km", "place_id"])
    r = AFFECTED_RADIUS_KM
    return [omit({"place": places[x.place_id], "closestApproachKm": float(x.closest_approach_km),
                  "closestApproachAt": iso(x.closest_approach_at),
                  "maxWindKtWithinRadius": num(getattr(x, f"max_wind_kt_r{r}")),
                  "maxGustKtWithinRadius": num(getattr(x, f"max_gust_kt_r{r}")),
                  "hoursWithinRadius": int(getattr(x, f"hours_r{r}"))})
            for x in e.head(AFFECTED_MAX).itertuples()]


def summary_doc(s: Any, landfalls: pd.DataFrame, place_names: dict[str, str], frames: dict[str, Any] | None,
                base: str, ex: pd.DataFrame | None = None, places: dict[str, dict[str, Any]] | None = None,
                storm_stats: dict[str, Any] | None = None) -> dict[str, Any]:
    """summary.json: contract StormDetail plus frames, reanalysisCheck, affectedPlaces, ogImage."""
    intensity = []
    for ag, (_, _, minutes) in AGENCY_COLUMNS.items():
        w, p = s[f"{ag}_max_wind_kt"], s[f"{ag}_min_pressure_hpa"]
        if num(w) is not None or num(p) is not None:
            intensity.append(omit({"agency": ag, "windAveragingMinutes": minutes, "maxWindKt": num(w),
                                   "minPressureHpa": num(p)}))
    peak: dict[str, Any] = {}
    if num(s.peak_wind_kt) is not None:
        peak = {"windKt": num(s.peak_wind_kt), "agency": s.peak_wind_agency, "at": iso(s.peak_at),
                "position": [num(s.peak_lon, 4), num(s.peak_lat, 4)]}
    if num(s.min_pressure_hpa) is not None:
        peak["pressureHpa"] = num(s.min_pressure_hpa)
    srcs = ["ibtracs-v04r01"] + (["era5"] if frames else []) + \
        (["jma-rsmc-besttrack"] if num(s.jma_number) is not None else []) + \
        (["pagasa-crosswalk"] if isinstance(s.name_pagasa, str) else [])
    doc: dict[str, Any] = {
        "schema": SCHEMA, "sid": s.sid, "name": s["name"], "nameIbtracs": s.name_ibtracs,
        "localNames": local_names(s), "season": int(s.season), "basin": s.basin, "number": num(s.number),
        "atcfId": s.atcf_id if isinstance(s.atcf_id, str) else None, "designation": catalog.designation(s.atcf_id),
        "jmaNumber": num(s.jma_number),
        "trackType": s.track_type, "startedAt": iso(s.started_at), "endedAt": iso(s.ended_at),
        "durationHours": num(s.duration_h, 1), "fixCount": int(s.fix_count), "hours": int(s.hours),
        "landfallCountries": list(s.landfall_countries), "enteredPar": bool(s.entered_par), "bbox": list(s.bbox),
        "peak": peak, "intensity": intensity,
        "landfalls": [omit({"country": r.country, "at": iso(r.at), "position": [r.lon, r.lat], "placeId": r.place_id,
                            "placeName": place_names.get(r.place_id)})
                      for r in landfalls.sort_values("seq").itertuples()],
        "sources": [DATA_SOURCES[k] for k in srcs], "replayAvailable": frames is not None,
        "track": "track.json", "ogImage": "og.png", "stats": storm_stats,
        "affectedRadiusKm": AFFECTED_RADIUS_KM, "affectedPlaces": affected_places(ex, places or {}),
    }
    if frames:
        chk = frames["era5VsBestTrack"]
        doc["frames"] = summary_frames(frames, base)
        doc["frameCount"] = frames["frames"]
        if chk.get("reanalysisCheck"):
            doc["reanalysisCheck"] = chk["reanalysisCheck"]
        doc["era5VsBestTrack"] = {k: v for k, v in chk.items() if k != "reanalysisCheck"}
        doc["era5Note"] = ERA5_HONESTY
    return omit(doc)


# ----------------------------------------------------------------------------- build

def replay_storms() -> dict[str, dict[str, Any]]:
    """Frames built in this run (data/processed/frames/<sid>/frames.json)."""
    out = {}
    for f in sorted(FRAMES_DIR.glob("*/frames.json")):
        meta = json.loads(f.read_text())
        h = meta["era5VsBestTrack"]
        out[meta["sid"]] = {"frames": meta["frames"], "ratio": h.get("headlineRatio"), "agency": h.get("headlineAgency"),
                            "meta": meta, "dir": f.parent}
    return out


def track_hash(h: pd.DataFrame) -> str:
    """Fingerprint of an hourly track: frames must be rebuilt when it changes (IBTrACS revisions)."""
    a = np.column_stack([h.time.astype("int64").to_numpy() // 10**9, np.round(h.lat.to_numpy(float), 2),
                         np.round(lon180(h.lon.to_numpy(float)), 2)])
    return hashlib.sha256(a.astype("float64").tobytes()).hexdigest()[:16]


def _get_json(root: str, rel_path: str) -> Any:
    if root.startswith("https://"):
        import httpx

        r = httpx.get(f"{root.rstrip('/')}/{rel_path}", follow_redirects=True, timeout=120)
        if r.status_code in (401, 404):
            return None
        r.raise_for_status()
        return r.json()
    p = Path(root) / rel_path
    return json.loads(p.read_text()) if p.exists() else None


def frames_index_path(base_v: str, season: int) -> str:
    """One season's shard of the frames index (sid -> {trackHash, frames}); pipeline-internal, not fetched by
    the web app. A single file grew to 30 MB with the whole catalogue (docs/architecture/DECISIONS.md, "dataset file sizes")."""
    return f"{base_v}frames-index/{season}.json"


def load_previous(root: str | None) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """(index.json, frames index) of the version `latest.json` points at under `root` (URL or dir). Reads the
    per-season shards (`framesIndexShards`), or the single frames-index.json of v1."""
    if not root:
        return None, {}
    latest = _get_json(root, "latest.json")
    if not latest:
        return None, {}
    prev = _get_json(root, latest["index"])
    if not prev:
        return None, {}
    if "framesIndexShards" not in prev:
        return prev, _get_json(root, prev.get("framesIndex") or latest["path"] + "frames-index.json") or {}
    frames: dict[str, Any] = {}
    for season in sorted({int(r["season"]) for r in prev["storms"] if r.get("replayAvailable")}):
        frames |= _get_json(root, prev["framesIndexShards"].replace("{season}", str(season))) or {}
    return prev, frames


def build(version: int, previous: str | None = None, out_root: Path = BUILD, *,
          frames_uploaded: bool = False) -> Path:
    """Assemble v<version>/. `previous` (dataset root URL or local dir) enables reuse of unchanged storms and
    of frames whose track did not change; `frames_uploaded` means the batch jobs already uploaded this run's
    frame files to v<version>/storms/<sid>/ (only their frames.json is local)."""
    vdir = out_root / f"v{version}"
    if vdir.exists():
        shutil.rmtree(vdir)
    ensure_dir(vdir)
    base_v = f"v{version}/"
    st = catalog.load("storms")
    fixes = catalog.load("fixes")
    lfs = catalog.load("landfalls")
    hourly = catalog.load("hourly")
    pl = places_mod.load()
    ex = exposure.load()
    place_names = dict(zip(pl.place_id, pl.name, strict=True))
    place_objs = {p.place_id: place_summary(p) for p in pl.itertuples()}
    ex_by = dict(tuple(ex[ex.closest_approach_km <= AFFECTED_RADIUS_KM].groupby("sid")))
    st_stats = stats.storm_stats(st.set_index("sid"), fixes, hourly,
                                 shapely.STRtree(shapely.from_wkb(pl.geom_wkb.to_numpy())))
    local = replay_storms()
    _, prev_frames = load_previous(previous)
    fx_by, lf_by, hr_by = dict(tuple(fixes.groupby("sid"))), dict(tuple(lfs.groupby("sid"))), dict(tuple(hourly.groupby("sid")))
    empty_lf = lfs.iloc[0:0]
    index_rows: list[dict[str, Any]] = []
    frames_index: dict[int, dict[str, Any]] = {}   # season -> sid -> {trackHash, frames}
    frame_refs: dict[str, dict[str, Any]] = {}   # every frame file this version references
    replay: dict[str, dict[str, Any]] = {}
    reused_frames = 0
    for row in st.sort_values(["season", "started_at", "sid"]).itertuples(index=False):
        s: Any = pd.Series(row._asdict())
        sid = s.sid
        sdir = ensure_dir(vdir / "storms" / sid)
        base = f"{base_v}storms/{sid}/"
        th = track_hash(hr_by[sid])
        fr = None
        if sid in local:
            rp = local[sid]
            fr = frames_entry(rp["meta"], sid)
            for path, nbytes, sha in frame_files(fr):
                frame_refs[path] = {"bytes": nbytes, "sha256": sha}
                if not frames_uploaded:
                    dst = out_root / path
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    if not dst.exists():
                        shutil.copy2(rp["dir"] / Path(path).name, dst)
        elif sid in prev_frames and prev_frames[sid]["trackHash"] == th:
            fr = json.loads(json.dumps(prev_frames[sid]["frames"]))   # already published under frames/
            for path, nbytes, sha in frame_files(fr):
                frame_refs[path] = {"bytes": nbytes, "sha256": sha, "published": True}
            reused_frames += 1
        if fr:
            h = fr["era5VsBestTrack"]
            replay[sid] = {"frames": fr["frames"], "ratio": h.get("headlineRatio"), "agency": h.get("headlineAgency")}
            frames_index.setdefault(int(s.season), {})[sid] = {"trackHash": th, "frames": fr}
        summ = summary_doc(s, lf_by.get(sid, empty_lf), place_names, fr, base, ex_by.get(sid), place_objs,
                           st_stats.get(sid))
        trk = track_doc(s, fx_by[sid], hr_by[sid])
        (sdir / "summary.json").write_bytes(dumps(summ))
        (sdir / "track.json").write_bytes(dumps(trk))
        h = hr_by[sid]
        (sdir / "og.png").write_bytes(og.render(s.to_dict(), h.lon.to_numpy(), h.lat.to_numpy(), h.wind_kt.to_numpy()))
        # content hash of the storm's documents (the summary lists every frame file's sha256, so it covers the
        # frames too); frame paths relative to the storm directory make it version-independent. Every version
        # keeps every storm folder: the web app reads v<N>/storms/<sid>/ (web/docs/DATA-LAYOUT.md), and
        # unchanged files cost nothing on the Hub (content-deduplicated).
        hsh = hashlib.sha256()
        for name in ("summary.json", "track.json", "og.png"):
            hsh.update(name.encode() + b"\0" + hashlib.sha256((sdir / name).read_bytes()).digest())
        content = hsh.hexdigest()[:32]
        path = base
        index_rows.append(omit({
            "sid": sid, "name": s["name"], "localNames": local_names(s), "designation": catalog.designation(s.atcf_id),
            "season": int(s.season), "basin": s.basin, "startedAt": iso(s.started_at), "endedAt": iso(s.ended_at), "peakWindKt": num(s.peak_wind_kt),
            "peakWindAgency": s.peak_wind_agency if isinstance(s.peak_wind_agency, str) else None,
            "minPressureHpa": num(s.min_pressure_hpa), "landfallCountries": list(s.landfall_countries),
            "replayAvailable": bool(fr), "frameCount": fr["frames"] if fr else None,
            "saffirSimpson": st_stats.get(sid, {}).get("saffirSimpson"), "ace": st_stats.get(sid, {}).get("ace"),
            "era5Ratio": replay[sid]["ratio"] if fr else None, "bbox": [num(v, 2) for v in s.bbox],
            "path": path, "contentHash": content, "trackHash": th,
        }))
    index = {
        "schema": SCHEMA, "dataVersion": version, "datasetVersion": version,
        "generatedAt": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": "storms: contract StormSummary + designation (JTWC number from USA_ATCF_ID, e.g. 03W), replayAvailable, "
                "frameCount, era5Ratio, bbox; `path` is the storm "
                "directory (dataset-root relative; may be an earlier version's when nothing changed).",
        "storms": index_rows,
        "places": f"{base_v}places/index.json", "manifest": f"{base_v}manifest.json", "tables": f"{base_v}tables.json",
        "framesIndexShards": frames_index_path(base_v, "{season}"), "era5Note": ERA5_HONESTY,
        "stats": {k: f"{base_v}stats/{k}.json" for k in ("seasons", "climatology", "admin", "records")},
        "selection": f"{base_v}selection.json",
    }
    (vdir / "index.json").write_bytes(dumps(index))
    for season, entries in frames_index.items():
        p = vdir / frames_index_path("", season)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(dumps(entries))
    write_places(vdir, base_v, pl, ex, st, out_root, frame_refs)
    write_stats(vdir, st, st_stats, lfs, pl, ex)
    sel_json = PROCESSED / "catalog/selection.json"
    if sel_json.exists():
        (vdir / "selection.json").write_bytes(sel_json.read_bytes())
    local_tables = out_root / f"tables-v{version}"      # full tables for typhoon.dbload (not uploaded)
    tinfo = tables.build_tables(local_tables, replay, st_stats)
    table_paths = publish_tables(local_tables, out_root, frame_refs)
    (vdir / "tables.json").write_bytes(dumps({"schema": SCHEMA, "note": "Content-addressed Parquet files of this "
                                              "version (paths relative to the dataset root); exposure is split per season.",
                                              "tables": table_paths}))
    write_manifest(vdir, version, index, tinfo, local, frame_refs, len(replay), reused_frames)
    log.info("built %s: %d storms, %d with frames (%d built now, %d reused)",
             vdir, len(index_rows), len(replay), len(local), reused_frames)
    return vdir


HITS_MAX_KM = 200   # static place shards carry hits within 200 km; the full 500 km table is in tables/


def put_shared(out_root: Path, rel_dir: str, data: bytes, ext: str, refs: dict[str, dict[str, Any]]) -> str:
    """Write a content-addressed file <rel_dir>/<sha16>.<ext> (shared by every version); return its path."""
    h = hashlib.sha256(data).hexdigest()
    rel_path = f"{rel_dir}/{h[:16]}.{ext}"
    dst = out_root / rel_path
    if not dst.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(data)
    refs[rel_path] = {"bytes": len(data), "sha256": h}
    return rel_path


def publish_tables(local: Path, out_root: Path, refs: dict[str, dict[str, Any]]) -> dict[str, list[str]]:
    """Content-addressed copies of the tables; exposure split per season so a refresh touches one file."""
    import pyarrow.parquet as pq

    out: dict[str, list[str]] = {}
    for name in tables.TABLES:
        src = local / f"{name}.parquet"
        if name == "exposure":
            t = pq.read_table(src)
            seasons = sorted(set(t.column("season").to_pylist()))
            paths = []
            for s in seasons:
                import pyarrow.compute as pc

                part = t.filter(pc.equal(t.column("season"), s))
                buf = io.BytesIO()
                pq.write_table(part, buf, compression="zstd")
                paths.append(put_shared(out_root, f"tables/exposure/season={s}", buf.getvalue(), "parquet", refs))
            out[name] = paths
        else:
            out[name] = [put_shared(out_root, f"tables/{name}", src.read_bytes(), "parquet", refs)]
    return out


def write_stats(vdir: Path, st: pd.DataFrame, st_stats: dict[str, dict[str, Any]], lfs: pd.DataFrame,
                pl: pd.DataFrame, ex: pd.DataFrame) -> None:
    sdir = ensure_dir(vdir / "stats")
    s = st.set_index("sid")
    docs = {
        "seasons": {"note": "Per season: catalogue storms (PH/JP-affecting), intensity classes by the preferred agency "
                            "(typhoon >= 64 kt; super typhoon = JTWC >= 130 kt), storms making PH/JP landfall, ACE "
                            "(JTWC, 6-hourly, >= 35 kt).", "seasons": stats.seasons(s, st_stats, lfs)},
        "climatology": stats.climatology(s.reset_index(), lfs),
        "admin": {"note": "Per PH province / JP prefecture (place shards): storms whose track came within 100 km of "
                          "any place, landfalls, the strongest (best-track wind within 100 km) and the latest.",
                  "admin": stats.admin(pl, ex, lfs, s)},
        "records": {"note": "Top 10 per measure over the catalogue.", **stats.records(s, st_stats)},
    }
    for name, doc in docs.items():
        (sdir / f"{name}.json").write_bytes(dumps(doc))


def write_places(vdir: Path, base_v: str, pl: pd.DataFrame, ex: pd.DataFrame, st: pd.DataFrame,
                 out_root: Path, refs: dict[str, dict[str, Any]]) -> None:
    pdir = ensure_dir(vdir / "places")
    names = st.set_index("sid")[["name", "season"]]
    shards: list[dict[str, Any]] = []
    search_rows: list[list[Any]] = []
    exb = ex.merge(pl[["place_id", "shard"]], on="place_id")
    summaries = stats.place_summaries(ex, st.set_index("sid"))
    for shard, g in pl.groupby("shard", sort=True):
        g = g.sort_values("place_id")
        pidx = {p: i for i, p in enumerate(g.place_id)}
        e = exb[(exb.shard == shard) & (exb.closest_approach_km <= HITS_MAX_KM)].sort_values(
            ["place_id", "closest_approach_km"])
        doc = {
            "schema": SCHEMA, "shard": shard, "country": g.country.iloc[0],
            "admin1": g.admin1.iloc[0], "admin2": g.admin2.iloc[0] if isinstance(g.admin2.iloc[0], str) else None,
            "places": [{k: v for k, v in {
                "id": r.place_id, "kind": r.kind, "name": r.name, "nameJa": r.name_ja if isinstance(r.name_ja, str) else None,
                "admin1": r.admin1, "admin1Ja": r.admin1_ja if isinstance(r.admin1_ja, str) else None,
                "admin2": r.admin2 if isinstance(r.admin2, str) else None, "areaKm2": r.area_km2,
                "centroid": [r.centroid_lon, r.centroid_lat], "bbox": list(r.bbox),
                "summary": summaries.get(r.place_id)}.items() if v is not None}
                for r in g.itertuples()],
            "exposureNote": "Best-track based, as served by GET /v1/places/{placeId}/storms: closest approach of the "
                            "hourly track to the boundary, and the best-track sustained wind / gust (kt) while the "
                            "centre was within each radius.",
            "hitsMaxKm": HITS_MAX_KM,
            "hits": {"columns": ["place", "sid", "km", "at", "w50", "w100", "w200", "g200", "h50", "h100", "h200"],
                     "rows": [[pidx[r.place_id], r.sid, float(r.closest_approach_km),
                               int(pd.Timestamp(r.closest_approach_at).timestamp()),
                               *(num(getattr(r, f"max_wind_kt_r{k}")) for k in (50, 100, 200)),
                               num(r.max_gust_kt_r200),
                               *(int(getattr(r, f"hours_r{k}")) for k in (50, 100, 200))]
                              for r in e.itertuples()]},
            "storms": {sid: [names.loc[sid, "name"], int(names.loc[sid, "season"])] for sid in pd.unique(e.sid)},
        }
        shard_path = put_shared(out_root, f"places/{shard}", dumps(doc), "json", refs)
        fc = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "id": r.place_id,
             "properties": {"name": r.name, "nameJa": r.name_ja if isinstance(r.name_ja, str) else None, "kind": r.kind},
             "geometry": json.loads(shapely.to_geojson(shapely.from_wkb(r.geom_display_wkb)))} for r in g.itertuples()]}
        geo_path = put_shared(out_root, f"places/{shard}", dumps(fc), "geojson", refs)
        search_rows += [[r.place_id, r.kind, r.name, r.name_ja if isinstance(r.name_ja, str) else None, r.admin1,
                         r.admin1_ja if isinstance(r.admin1_ja, str) else None,
                         r.admin2 if isinstance(r.admin2, str) else None, num(r.centroid_lon, 4), num(r.centroid_lat, 4),
                         len(shards),
                         (summaries.get(r.place_id) or {}).get("stormsWithin100Km")] for r in g.itertuples()]
        b = np.array([r for r in g.bbox])
        shards.append({"shard": shard, "country": g.country.iloc[0], "admin1": g.admin1.iloc[0],
                       "admin2": g.admin2.iloc[0] if isinstance(g.admin2.iloc[0], str) else None,
                       "places": len(g), "hits": len(e),
                       "bbox": [float(b[:, 0].min()), float(b[:, 1].min()), float(b[:, 2].max()), float(b[:, 3].max())],
                       "path": shard_path, "geojson": geo_path})
    (pdir / "index.json").write_bytes(dumps({
        "schema": SCHEMA, "note": "Shard files are content-addressed and shared by data versions; paths are "
                                  "relative to the dataset root.", "shards": shards,
        "search": f"{base_v}places/search.json"}))
    # The search box needs names and centroids only; without this file the app fetches every shard (~9 MB).
    (pdir / "search.json").write_bytes(dumps({
        "schema": "typhoon-replay/places-search@1", "columns": ["id", "kind", "name", "nameJa", "admin1", "admin1Ja", "admin2", "lon", "lat",
                                      "shard", "storms100"],
        "shards": [x["path"] for x in shards], "rows": search_rows}))


def write_manifest(vdir: Path, version: int, index: dict[str, Any], tinfo: dict[str, Any],
                   replay: dict[str, dict[str, Any]], remote_files: dict[str, dict[str, Any]],
                   with_frames: int, reused_frames: int) -> None:
    run = sources.RunManifest()
    # inputs: every local source's provenance + the ERA5 reads recorded per storm
    for p in sorted((PROCESSED.parent / "raw").rglob("*.provenance.json")):
        d = json.loads(p.read_text())
        d.pop("data_as_of", None)
        if "wikipedia-season-pages" in d["source_id"]:
            continue
        run.add(sources.Provenance(**d))
    era5: dict[str, dict[str, Any]] = {}
    for sid, r in replay.items():
        pf = r["dir"] / "provenance.json"
        if not pf.exists():
            continue
        for k, v in json.loads(pf.read_text())["sources"].items():
            e = era5.setdefault(k, {"bytes": 0, "objects": 0, "storms": 0, "fallback_storms": [], "served": {}})
            e["bytes"] += v["bytes"]
            e["objects"] += v["rows"] or 0
            e["storms"] += 1
            if v["fallback_used"]:
                e["fallback_storms"].append(sid)
            for a in v["attempts"]:
                if a["error"] == "served":
                    e["served"][a["link"]] = e["served"].get(a["link"], 0) + int(a["message"].split()[0])
    meta = sources.data_version_metadata(run, str(version))
    files = {}
    for p in sorted(vdir.rglob("*")):
        if p.is_file() and p.relative_to(vdir).as_posix() not in ("manifest.json", "files.json"):
            files[str(p.relative_to(vdir.parent))] = {"bytes": p.stat().st_size, "sha256": sha256_file(p)}
    for k, v in remote_files.items():   # content-addressed frames outside the version directory
        files[k] = dict(v, shared=True)
    fi = read_frames_index(vdir)
    ratios = [v["frames"]["era5VsBestTrack"].get("headlineRatio") for v in fi.values()]
    ratios = [r for r in ratios if r is not None]
    reg = {s["id"]: s for s in sources.registry().sources}
    web_sources = [{"id": a["id"], "name": " ".join(str(reg[a["id"]]["description"]).split())[:160],
                    "url": next((lk["url"] for lk in reg[a["id"]].get("links", []) if str(lk.get("url", "")).startswith("https")),
                                "https://github.com/abrycta/typhoon-replay/blob/main/pipeline/sources.yaml"),
                    "license": a["licence"], "attribution": a["attribution"]}
                   for a in sources.attributions() if a["kind"] != "live-feed"]
    manifest = {
        "schema": SCHEMA, "dataVersion": version, "datasetVersion": version, "createdAt": index["generatedAt"],
        "generatedAt": index["generatedAt"], "dataAsOf": meta.get("data_as_of") or ibtracs_as_of(run),
        "sources": web_sources, "repo": HF_REPO,
        "pipelineCommit": git_commit(),
        "provenance": meta, "era5Reads": era5,
        "attribution": list(sources.attributions()),
        "credits": [
            "Contains modified Copernicus Climate Change Service information (ERA5, CC BY 4.0).",
            "Best tracks: IBTrACS v04r01 (Knapp et al. 2010; Gahtan et al. 2024), NOAA NCEI.",
            "JMA typhoon numbers: RSMC Tokyo - Typhoon Center best track, Japan Meteorological Agency.",
            "PAGASA names: Wikipedia contributors (CC BY-SA 4.0) and the curated crosswalk (share-alike).",
            "PH boundaries: geoBoundaries (Runfola et al. 2020), NAMRIA/PSA via OCHA COD-AB (CC BY 3.0 IGO); PSGC (PSA).",
            "JP boundaries: 出典「国土数値情報（行政区域データ）」（国土交通省）を加工して作成; romanised names © OpenStreetMap contributors (ODbL) via geoBoundaries.",
            "Basemap: Natural Earth (public domain).",
        ],
        "licences": {"tables/pagasa_names.parquet": "CC BY-SA 4.0", "places (JP romanised names)": "ODbL 1.0",
                     "frames": "CC BY 4.0 (derived from ERA5)", "default": "CC BY 4.0"},
        "era5": {"note": ERA5_HONESTY, "stormsWithFrames": with_frames, "framesBuiltThisVersion": len(replay),
                 "framesReusedFromPrevious": reused_frames,
                 "medianHeadlineRatio": round(float(np.median(ratios)), 3) if ratios else None},
        "counts": {"storms": len(index["storms"]), "tables": tinfo},
        "frameSelection": selection_summary(),
        "fileList": f"{vdir.name}/files.json",
    }
    # the checksums of every file live in files.json (5 MB with the whole catalogue), not in manifest.json,
    # which the web app fetches on every page for the footer
    (vdir / "files.json").write_bytes(dumps({"schema": SCHEMA, "note": "Every file of this version (paths "
                                             "relative to the dataset root); shared = content-addressed outside "
                                             "the version directory.", "files": files}))
    (vdir / "manifest.json").write_bytes(json.dumps(manifest, ensure_ascii=False, indent=1).encode())


def file_list(man: dict[str, Any], load: Any) -> dict[str, dict[str, Any]]:
    """{path: {bytes, sha256, shared?}} of a version: manifest.json `files` (v1) or the `fileList` file, read
    with `load(dataset-root path) -> dict`."""
    return man["files"] if "files" in man else load(man["fileList"])["files"]


def read_frames_index(vdir: Path) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for p in sorted((vdir / "frames-index").glob("*.json")):
        out |= json.loads(p.read_text())
    return out


def selection_summary() -> dict[str, Any] | None:
    p = PROCESSED / "catalog/selection.json"
    if not p.exists():
        return None
    d = json.loads(p.read_text())
    return {k: v for k, v in d.items() if k != "selectedSids"} | {"list": "selection.json"}


def ibtracs_as_of(run: sources.RunManifest) -> str | None:
    p = run.items.get("ibtracs-wp")
    return p.data_as_of if p else None


# ----------------------------------------------------------------------------- checks (gates before latest flips)

class CheckFailed(Exception):
    pass


def check(vdir: Path) -> dict[str, Any]:
    """Validate an assembled version; raises CheckFailed with every problem found."""
    problems: list[str] = []
    root = vdir.parent
    man = json.loads((vdir / "manifest.json").read_text())
    files = file_list(man, lambda rel: json.loads((root / rel).read_text()))
    for rel, f in files.items():
        p = root / rel
        if f.get("shared") and not p.exists():
            continue  # a frame file uploaded by a batch job or published earlier; publish.verify checks it
        if not p.exists():
            problems.append(f"missing {rel}")
            continue
        if p.stat().st_size != f["bytes"] or sha256_file(p) != f["sha256"]:
            problems.append(f"checksum {rel}")
        if p.stat().st_size >= MAX_FILE_BYTES:
            problems.append(f"{rel} is {p.stat().st_size} bytes (>= 25 MiB)")
    idx = json.loads((vdir / "index.json").read_text())
    raw = (vdir / "index.json").stat().st_size
    if raw > INDEX_MAX_BYTES:
        problems.append(f"index.json is {raw} bytes")
    for name in PAGE_LOAD_FILES:
        n = (vdir / name).stat().st_size
        if n > PAGE_LOAD_MAX_BYTES:
            problems.append(f"{vdir.name}/{name} is {n} bytes (page-load budget {PAGE_LOAD_MAX_BYTES})")
    rows = idx["storms"]
    if len(rows) < 1500:
        problems.append(f"only {len(rows)} storms")
    fi = read_frames_index(vdir)
    replay = 0
    for r in rows:
        sdir = root / r["path"]
        if r["path"] != f"{vdir.name}/storms/{r['sid']}/":
            problems.append(f"{r['sid']}: path {r['path']} is not in this version")
            continue
        if not (sdir / "summary.json").exists():
            problems.append(f"{r['sid']}: summary.json missing")
            continue
        for name in ("summary.json", "track.json"):
            n = (sdir / name).stat().st_size if (sdir / name).exists() else 0
            if n > PAGE_LOAD_MAX_BYTES:
                problems.append(f"{r['path']}{name} is {n} bytes (page-load budget {PAGE_LOAD_MAX_BYTES})")
        s = json.loads((sdir / "summary.json").read_text())
        if s["sid"] != r["sid"] or s.get("replayAvailable") != r["replayAvailable"]:
            problems.append(f"{r['sid']}: summary/index disagree")
        if r["replayAvailable"] != (r["sid"] in fi):
            problems.append(f"{r['sid']}: index and frames-index disagree")
    for sid, entry in fi.items():
        fr = entry["frames"]
        replay += 1
        h = fr["era5VsBestTrack"]
        # No ratio is honest, not broken: many older storms have no agency wind to compare against, and the
        # app says so ("no best-track wind to compare"). Weak storms can sit a little above 1.5.
        if h.get("headlineRatio") is not None and not 0.05 < h["headlineRatio"] < 3.0:
            problems.append(f"{sid}: implausible ERA5 ratio {h['headlineRatio']}")
        if "tyf" in fr and (root / fr["tyf"]["path"]).exists():
            hdr, q = parse_tyf((root / fr["tyf"]["path"]).read_bytes())
            if hdr["sid"] != sid or hdr["frames"] != fr["frames"]:
                problems.append(f"{sid}: bad tyf header")
            nod = float((q[:, :4] == 255).mean())
            if nod > 0.01:
                problems.append(f"{sid}: {nod:.1%} nodata")
            ex = fr["exact"]
            names = [v["name"] for v in hdr["vars"]]
            for v in ex["vars"]:
                back = unsheet((root / v["path"]).read_bytes(), ex["frames"], ex["tileHeight"], ex["tileWidth"],
                               ex["cols"], ex["tileStride"])
                if not np.array_equal(back, q[ex["frameIndex"], names.index(v["name"])][:, ::2, ::2]):
                    problems.append(f"{sid}: exact {v['name']} differs from tyf")
    # tables
    import pyarrow.parquet as pq

    t = {n: pq.read_table(root / f"tables-{vdir.name}" / f"{n}.parquet") for n in tables.TABLES}
    sids = set(t["storms"].column("sid").to_pylist())
    pids = set(t["places"].column("place_id").to_pylist())
    for n in ("storm_fixes", "storm_landfalls", "pagasa_names", "exposure", "hourly_tracks"):
        extra = set(t[n].column("sid").to_pylist()) - sids
        if extra:
            problems.append(f"{n}: {len(extra)} sids not in storms")
    for n in ("exposure", "storm_landfalls"):
        extra = set(t[n].column("place_id").drop_null().to_pylist()) - pids
        if extra:
            problems.append(f"{n}: {len(extra)} place ids not in places")
    km = t["exposure"].column("closest_approach_km").to_numpy()
    if (km < 0).any() or (km > 500).any():
        problems.append("exposure distance outside 0..500 km")
    if len(sids) != len(rows):
        problems.append("storms table and index disagree")
    gz = len(gzip.compress((vdir / "index.json").read_bytes()))
    result = {"storms": len(rows), "replay": replay, "files": len(files), "indexGzipBytes": gz,
              "bytes": sum(f["bytes"] for f in files.values()), "problems": problems}
    if problems:
        raise CheckFailed(json.dumps(result, indent=1))
    return result


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--version", type=int, required=True)
    b.add_argument("--previous", help="dataset root (URL or dir) whose latest.json is the previous version")
    b.add_argument("--frames-uploaded", action="store_true")
    c = sub.add_parser("check")
    c.add_argument("--version", type=int, required=True)
    a = ap.parse_args(argv)
    if a.cmd == "build":
        vdir = build(a.version, a.previous, frames_uploaded=a.frames_uploaded)
        print(json.dumps(check(vdir), indent=1))
    else:
        print(json.dumps(check(BUILD / f"v{a.version}"), indent=1))


if __name__ == "__main__":
    main()
