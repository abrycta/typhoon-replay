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
    v<N>/places/<shard>.json            places of one PH province / JP prefecture + their storm exposure
    v<N>/places/<shard>.geojson         display geometry (<= 1,500 vertices per place)
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
from .frames import MAX_FILE_BYTES, parse_tyf, unsprite
from .frames import OUT as FRAMES_DIR
from .track import AGENCY_COLUMNS, lon180

log = logging.getLogger("typhoon.dataset")
SCHEMA = "typhoon-replay/dataset@1"
INDEX_MAX_BYTES = 2_500_000   # raw; about 200 kB gzipped


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


def frames_entry(meta: dict[str, Any], base: str) -> dict[str, Any]:
    """frames.json -> the frames record with dataset-root paths (stored in frames-index.json)."""
    segs = meta["segments"]
    first = segs[0]
    out: dict[str, Any] = {
        "format": "tyf", "path": base + first["tyf"]["file"], "bytes": first["tyf"]["bytes"],
        "sha256": first["tyf"]["sha256"], "headerBytes": first["tyf"]["headerBytes"],
        "frameBytes": first["tyf"]["frameBytes"], "frames": meta["frames"], "start": meta["start"], "end": meta["end"],
        "nx": meta["nx"], "ny": meta["ny"], "resDeg": meta["resDeg"], "nodata": meta["nodata"],
        "vars": meta["vars"], "servedBy": meta["servedBy"], "credit": meta["credit"],
        "quantisation": meta["quantisation"], "era5VsBestTrack": meta["era5VsBestTrack"],
    }
    if len(segs) == 1 and "webp" in first:
        out["webp"] = {k: {kk: (base + vv if kk == "file" else vv) for kk, vv in v.items()}
                       for k, v in first["webp"].items()}
        for v in out["webp"].values():
            v["path"] = v.pop("file")
    if len(segs) > 1:
        out["segments"] = [{"index": sg["index"], "frames": sg["frames"], "start": sg["start"], "end": sg["end"],
                            "path": base + sg["tyf"]["file"], "bytes": sg["tyf"]["bytes"], "sha256": sg["tyf"]["sha256"],
                            "headerBytes": sg["tyf"]["headerBytes"],
                            "webp": {k: dict(v, path=base + v["file"]) for k, v in sg.get("webp", {}).items()}}
                           for sg in segs]
    return out


def frame_files(fr: dict[str, Any]) -> list[tuple[str, int, str]]:
    """(root path, bytes, sha256) of every file a frames record references."""
    out = [(fr["path"], fr["bytes"], fr["sha256"])]
    for v in fr.get("webp", {}).values():
        out.append((v["path"], v["bytes"], v["sha256"]))
    for sg in fr.get("segments", [])[1:]:
        out.append((sg["path"], sg["bytes"], sg["sha256"]))
    for sg in fr.get("segments", []):
        out += [(v["path"], v["bytes"], v["sha256"]) for v in sg.get("webp", {}).values()]
    return list(dict.fromkeys(out))


def summary_frames(fr: dict[str, Any], storm_base: str) -> dict[str, Any]:
    """The summary's `frames`: paths relative to the storm directory, cross-check moved out."""
    out = json.loads(json.dumps(fr))
    out.pop("era5VsBestTrack", None)
    out["path"] = rel(out["path"], storm_base)
    for v in out.get("webp", {}).values():
        v["path"] = rel(v["path"], storm_base)
    for sg in out.get("segments", []):
        sg["path"] = rel(sg["path"], storm_base)
        for v in sg.get("webp", {}).values():
            v["path"] = rel(v["path"], storm_base)
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
        "atcfId": s.atcf_id if isinstance(s.atcf_id, str) else None, "jmaNumber": num(s.jma_number),
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


def load_previous(root: str | None) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """(index.json, frames-index.json) of the version `latest.json` points at under `root` (URL or dir)."""
    if not root:
        return None, {}
    latest = _get_json(root, "latest.json")
    if not latest:
        return None, {}
    return _get_json(root, latest["index"]), _get_json(root, latest["path"] + "frames-index.json") or {}


def index_storms(prev: dict[str, Any] | None) -> list[dict[str, Any]]:
    return list(prev["storms"]) if prev else []


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
    prev, prev_frames = load_previous(previous)
    prev_paths = {r["sid"]: (r["path"], r["contentHash"]) for r in index_storms(prev)}
    fx_by, lf_by, hr_by = dict(tuple(fixes.groupby("sid"))), dict(tuple(lfs.groupby("sid"))), dict(tuple(hourly.groupby("sid")))
    empty_lf = lfs.iloc[0:0]
    index_rows: list[dict[str, Any]] = []
    frames_index: dict[str, Any] = {}
    remote_files: dict[str, dict[str, Any]] = {}
    replay: dict[str, dict[str, Any]] = {}
    reused = reused_frames = 0
    for row in st.sort_values(["season", "started_at", "sid"]).itertuples(index=False):
        s: Any = pd.Series(row._asdict())
        sid = s.sid
        sdir = ensure_dir(vdir / "storms" / sid)
        base = f"{base_v}storms/{sid}/"
        th = track_hash(hr_by[sid])
        fr = None
        if sid in local:
            rp = local[sid]
            fr = frames_entry(rp["meta"], base)
            for path, nbytes, sha in frame_files(fr):
                if frames_uploaded:
                    remote_files[path] = {"bytes": nbytes, "sha256": sha}
                else:
                    shutil.copy2(rp["dir"] / path[len(base):], sdir / path[len(base):])
        elif sid in prev_frames and prev_frames[sid]["trackHash"] == th:
            fr = json.loads(json.dumps(prev_frames[sid]["frames"]))   # root paths into the older version
            reused_frames += 1
        if fr:
            h = fr["era5VsBestTrack"]
            replay[sid] = {"frames": fr["frames"], "ratio": h.get("headlineRatio"), "agency": h.get("headlineAgency")}
            frames_index[sid] = {"trackHash": th, "frames": fr}
        summ = summary_doc(s, lf_by.get(sid, empty_lf), place_names, fr, base, ex_by.get(sid), place_objs,
                           st_stats.get(sid))
        trk = track_doc(s, fx_by[sid], hr_by[sid])
        (sdir / "summary.json").write_bytes(dumps(summ))
        (sdir / "track.json").write_bytes(dumps(trk))
        h = hr_by[sid]
        (sdir / "og.png").write_bytes(og.render(s.to_dict(), h.lon.to_numpy(), h.lat.to_numpy(), h.wind_kt.to_numpy()))
        # content hash of the storm's documents (the summary lists every frame file's sha256, so it covers the
        # frames too); frame paths relative to the storm directory make it version-independent
        hsh = hashlib.sha256()
        for name in ("summary.json", "track.json", "og.png"):
            hsh.update(name.encode() + b"\0" + hashlib.sha256((sdir / name).read_bytes()).digest())
        content = hsh.hexdigest()[:32]
        path = base
        if sid in prev_paths and prev_paths[sid][1] == content and sid not in local:
            path = prev_paths[sid][0]
            shutil.rmtree(sdir)
            reused += 1
        index_rows.append(omit({
            "sid": sid, "name": s["name"], "localNames": local_names(s), "season": int(s.season), "basin": s.basin,
            "startedAt": iso(s.started_at), "endedAt": iso(s.ended_at), "peakWindKt": num(s.peak_wind_kt),
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
        "note": "storms: contract StormSummary + replayAvailable, frameCount, era5Ratio, bbox; `path` is the storm "
                "directory (dataset-root relative; may be an earlier version's when nothing changed).",
        "storms": index_rows,
        "places": f"{base_v}places/index.json", "manifest": f"{base_v}manifest.json", "tables": f"{base_v}tables/",
        "framesIndex": f"{base_v}frames-index.json", "era5Note": ERA5_HONESTY,
        "stats": {k: f"{base_v}stats/{k}.json" for k in ("seasons", "climatology", "admin", "records")},
    }
    (vdir / "index.json").write_bytes(dumps(index))
    (vdir / "frames-index.json").write_bytes(dumps(frames_index))
    write_places(vdir, base_v, pl, ex, st)
    write_stats(vdir, st, st_stats, lfs, pl, ex)
    tinfo = tables.build_tables(vdir / "tables", replay, st_stats)
    write_manifest(vdir, version, index, tinfo, local, reused, remote_files, len(replay), reused_frames)
    log.info("built %s: %d storms, %d with frames (%d built now, %d reused), %d storm folders reused",
             vdir, len(index_rows), len(replay), len(local), reused_frames, reused)
    return vdir


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


def write_places(vdir: Path, base_v: str, pl: pd.DataFrame, ex: pd.DataFrame, st: pd.DataFrame) -> None:
    pdir = ensure_dir(vdir / "places")
    names = st.set_index("sid")[["name", "season"]]
    shards = []
    exb = ex.merge(pl[["place_id", "shard"]], on="place_id")
    summaries = stats.place_summaries(ex, st.set_index("sid"))
    for shard, g in pl.groupby("shard", sort=True):
        g = g.sort_values("place_id")
        pidx = {p: i for i, p in enumerate(g.place_id)}
        e = exb[exb.shard == shard].sort_values(["place_id", "closest_approach_km"])
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
            "hits": {"columns": ["place", "sid", "km", "at", "w50", "w100", "w200", "w300", "w500", "g500",
                                 "h50", "h100", "h200", "h300", "h500"],
                     "rows": [[pidx[r.place_id], r.sid, float(r.closest_approach_km),
                               int(pd.Timestamp(r.closest_approach_at).timestamp()),
                               *(num(getattr(r, f"max_wind_kt_r{k}")) for k in (50, 100, 200, 300, 500)),
                               num(r.max_gust_kt_r500),
                               *(int(getattr(r, f"hours_r{k}")) for k in (50, 100, 200, 300, 500))]
                              for r in e.itertuples()]},
            "storms": {sid: [names.loc[sid, "name"], int(names.loc[sid, "season"])] for sid in pd.unique(e.sid)},
        }
        (pdir / f"{shard}.json").write_bytes(dumps(doc))
        fc = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "id": r.place_id,
             "properties": {"name": r.name, "nameJa": r.name_ja if isinstance(r.name_ja, str) else None, "kind": r.kind},
             "geometry": json.loads(shapely.to_geojson(shapely.from_wkb(r.geom_display_wkb)))} for r in g.itertuples()]}
        (pdir / f"{shard}.geojson").write_bytes(dumps(fc))
        b = np.array([r for r in g.bbox])
        shards.append({"shard": shard, "country": g.country.iloc[0], "admin1": g.admin1.iloc[0],
                       "admin2": g.admin2.iloc[0] if isinstance(g.admin2.iloc[0], str) else None,
                       "places": len(g), "hits": len(e),
                       "bbox": [float(b[:, 0].min()), float(b[:, 1].min()), float(b[:, 2].max()), float(b[:, 3].max())],
                       "path": f"{base_v}places/{shard}.json", "geojson": f"{base_v}places/{shard}.geojson"})
    (pdir / "index.json").write_bytes(dumps({"schema": SCHEMA, "shards": shards}))


def write_manifest(vdir: Path, version: int, index: dict[str, Any], tinfo: dict[str, Any],
                   replay: dict[str, dict[str, Any]], reused: int, remote_files: dict[str, dict[str, Any]],
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
        if p.is_file() and p.name != "manifest.json":
            files[str(p.relative_to(vdir.parent))] = {"bytes": p.stat().st_size, "sha256": sha256_file(p)}
    for k, v in remote_files.items():   # frames uploaded by the batch jobs (checked there, verified remotely)
        files[k] = dict(v, uploadedByBatch=True)
    fi = json.loads((vdir / "frames-index.json").read_text())
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
        "counts": {"storms": len(index["storms"]), "reusedStormFolders": reused, "tables": tinfo},
        "files": files,
    }
    (vdir / "manifest.json").write_bytes(json.dumps(manifest, ensure_ascii=False, indent=1).encode())


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
    for rel, f in man["files"].items():
        p = root / rel
        if f.get("uploadedByBatch"):
            continue  # validated by its batch job; publish.verify checks the remote size
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
    rows = idx["storms"]
    if len(rows) < 1500:
        problems.append(f"only {len(rows)} storms")
    fi = json.loads((vdir / "frames-index.json").read_text())
    replay = 0
    for r in rows:
        sdir = root / r["path"]
        if not r["path"].startswith(vdir.name + "/"):
            continue  # reused from a previous, already-validated version
        if not (sdir / "summary.json").exists():
            problems.append(f"{r['sid']}: summary.json missing")
            continue
        s = json.loads((sdir / "summary.json").read_text())
        if s["sid"] != r["sid"] or s.get("replayAvailable") != r["replayAvailable"]:
            problems.append(f"{r['sid']}: summary/index disagree")
        if r["replayAvailable"] != (r["sid"] in fi):
            problems.append(f"{r['sid']}: index and frames-index disagree")
    for sid, entry in fi.items():
        fr = entry["frames"]
        replay += 1
        h = fr["era5VsBestTrack"]
        if h.get("headlineRatio") is None:
            problems.append(f"{sid}: no ERA5 honesty ratio")
        elif not 0.05 < h["headlineRatio"] < 1.5:
            problems.append(f"{sid}: implausible ERA5 ratio {h['headlineRatio']}")
        tyf = root / fr["path"]
        if not tyf.exists():
            continue  # uploaded by a batch job, or reused from an earlier version
        hdr, q = parse_tyf(tyf.read_bytes())
        if hdr["sid"] != sid or (not fr.get("segments") and hdr["frames"] != fr["frames"]):
            problems.append(f"{sid}: bad tyf header")
        nod = float((q[:, :4] == 255).mean())
        if nod > 0.01:
            problems.append(f"{sid}: {nod:.1%} nodata")
        names = [v["name"] for v in hdr["vars"]]
        for name, w in fr.get("webp", {}).items():
            back = unsprite((root / w["path"]).read_bytes(), hdr["frames"], hdr["ny"], hdr["nx"], w["cols"])
            if not np.array_equal(back, q[:, names.index(name)]):
                problems.append(f"{sid}: webp {name} differs from tyf")
    # tables
    import pyarrow.parquet as pq

    t = {n: pq.read_table(vdir / "tables" / f"{n}.parquet") for n in tables.TABLES}
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
    result = {"storms": len(rows), "replay": replay, "files": len(man["files"]), "indexGzipBytes": gz,
              "bytes": sum(f["bytes"] for f in man["files"].values()), "problems": problems}
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
