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

from . import catalog, exposure, og, sources, tables
from . import places as places_mod
from .config import BUILD, ERA5_HONESTY, HF_REPO, PROCESSED, ensure_dir
from .frames import MAX_FILE_BYTES, parse_tyf, unsprite
from .frames import OUT as FRAMES_DIR
from .track import AGENCY_COLUMNS, lon180

log = logging.getLogger("typhoon.dataset")
SCHEMA = "typhoon-replay/dataset@1"
INDEX_MAX_BYTES = 1_500_000   # raw; about 150 kB gzipped


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


def track_doc(s: Any, fixes: pd.DataFrame, hourly: pd.DataFrame) -> dict[str, Any]:
    f = fixes.sort_values("observed_at")
    h = hourly.sort_values("time")
    return {
        "sid": s.sid, "name": s["name"],
        "note": "Observed best-track fixes (IBTrACS, original O flags) and an hourly track interpolated "
                "linearly in time between IBTrACS rows; 'obs' marks hours that coincide with an observed fix. "
                "Wind in knots: JTWC 1-min, JMA 10-min; 'agency' says which value 'windKt' is.",
        "fixes": {
            "t": [int(pd.Timestamp(t).timestamp()) for t in f.observed_at],
            "lon": [num(v, 2) for v in f.lon], "lat": [num(v, 2) for v in f.lat],
            "windKt": [num(v) for v in f.wind_kt], "agency": [a if isinstance(a, str) else None for a in f.wind_agency],
            "pressureHpa": [num(v) for v in f.pressure_hpa],
            "jtwcKt": [num(v) for v in f.jtwc_wind_kt], "jmaKt": [num(v) for v in f.jma_wind_kt],
            "jmaHpa": [num(v) for v in f.jma_pressure_hpa], "nature": list(f.nature.where(f.nature.notna(), None)),
        },
        "hourly": {
            "t": [int(pd.Timestamp(t).timestamp()) for t in h.time],
            "lon": [num(v, 3) for v in lon180(h.lon.to_numpy())], "lat": [num(v, 3) for v in h.lat],
            "windKt": [num(v) for v in h.wind_kt], "agency": [a or None for a in h.wind_agency],
            "pressureHpa": [num(v) for v in h.pressure_hpa],
            "jtwcKt": [num(v) for v in h.jtwc_wind_kt], "jmaKt": [num(v) for v in h.jma_wind_kt],
            "obs": [int(bool(v)) for v in h.observed],
        },
    }


def summary_doc(s: Any, landfalls: pd.DataFrame, place_names: dict[str, str], frames: dict[str, Any] | None,
                base: str) -> dict[str, Any]:
    intensity = []
    for ag, (_, _, minutes) in AGENCY_COLUMNS.items():
        w, p = s[f"{ag}_max_wind_kt"], s[f"{ag}_min_pressure_hpa"]
        if num(w) is not None or num(p) is not None:
            d: dict[str, Any] = {"agency": ag, "windAveragingMinutes": minutes}
            if num(w) is not None:
                d["maxWindKt"] = num(w)
            if num(p) is not None:
                d["minPressureHpa"] = num(p)
            intensity.append(d)
    peak: dict[str, Any] = {}
    if num(s.peak_wind_kt) is not None:
        peak = {"windKt": num(s.peak_wind_kt), "agency": s.peak_wind_agency, "at": iso(s.peak_at),
                "position": [num(s.peak_lon, 4), num(s.peak_lat, 4)]}
    if num(s.min_pressure_hpa) is not None:
        peak["pressureHpa"] = num(s.min_pressure_hpa)
    doc: dict[str, Any] = {
        "schema": SCHEMA, "sid": s.sid, "name": s["name"], "nameIbtracs": s.name_ibtracs, "localNames": local_names(s),
        "season": int(s.season), "basin": s.basin, "number": num(s.number), "atcfId": s.atcf_id if isinstance(s.atcf_id, str) else None,
        "jmaNumber": num(s.jma_number), "trackType": s.track_type,
        "startedAt": iso(s.started_at), "endedAt": iso(s.ended_at), "durationHours": num(s.duration_h, 1),
        "fixCount": int(s.fix_count), "hours": int(s.hours), "landfallCountries": list(s.landfall_countries),
        "enteredPar": bool(s.entered_par), "bbox": list(s.bbox), "peak": peak, "intensity": intensity,
        "landfalls": [{"country": r.country, "at": iso(r.at), "position": [r.lon, r.lat], "placeId": r.place_id,
                       "placeName": place_names.get(r.place_id)} for r in landfalls.sort_values("seq").itertuples()],
        "replayAvailable": frames is not None,
        "sources": ["ibtracs-wp"] + (["era5-an-sfc", "era5-fc-gust", "era5-fc-precip-rate"] if frames else []),
        "track": f"{base}track.json", "og": f"{base}og.png",
    }
    if frames:
        doc["frames"] = frames
        doc["era5VsBestTrack"] = frames.pop("era5VsBestTrack")
        doc["era5Note"] = ERA5_HONESTY
    return {k: v for k, v in doc.items() if v is not None}


def frames_entry(meta: dict[str, Any], base: str) -> dict[str, Any]:
    """frames.json -> the summary's frame manifest with dataset-root-relative paths."""
    m = json.loads(json.dumps(meta))
    for seg in m["segments"]:
        if "tyf" in seg:
            seg["tyf"]["path"] = base + seg["tyf"].pop("file")
        for v in seg.get("webp", {}).values():
            v["path"] = base + v.pop("file")
    m.pop("sid", None)
    return m


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


def _get_json(root: str, rel: str) -> Any:
    if root.startswith("https://"):
        import httpx

        r = httpx.get(f"{root.rstrip('/')}/{rel}", follow_redirects=True, timeout=120)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()
    p = Path(root) / rel
    return json.loads(p.read_text()) if p.exists() else None


def load_previous(root: str | None) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """(index.json, frames-index.json) of the version `latest.json` points at under `root` (URL or dir)."""
    if not root:
        return None, {}
    latest = _get_json(root, "latest.json")
    if not latest:
        return None, {}
    return _get_json(root, latest["index"]), _get_json(root, latest["path"] + "frames-index.json") or {}


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
    local = replay_storms()
    prev, prev_frames = load_previous(previous)
    prev_paths = {}
    if prev:
        cols = prev["storms"]["columns"]
        for row in prev["storms"]["rows"]:
            r = dict(zip(cols, row, strict=True))
            prev_paths[r["sid"]] = (r["path"], r["contentHash"])
    fx_by, lf_by, hr_by = dict(tuple(fixes.groupby("sid"))), dict(tuple(lfs.groupby("sid"))), dict(tuple(hourly.groupby("sid")))
    empty_lf = lfs.iloc[0:0]
    index_rows: list[list[Any]] = []
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
            for seg in rp["meta"]["segments"]:
                items = ([seg["tyf"]] if "tyf" in seg else []) + list(seg.get("webp", {}).values())
                for it in items:
                    if frames_uploaded:
                        remote_files[base + it["file"]] = {"bytes": it["bytes"], "sha256": it["sha256"]}
                    else:
                        shutil.copy2(rp["dir"] / it["file"], sdir / it["file"])
        elif sid in prev_frames and prev_frames[sid]["trackHash"] == th:
            fr = json.loads(json.dumps(prev_frames[sid]["frames"]))   # paths point at the older version
            reused_frames += 1
        if fr:
            h = fr["era5VsBestTrack"]
            replay[sid] = {"frames": fr["frames"], "ratio": h.get("headlineRatio"), "agency": h.get("headlineAgency")}
            frames_index[sid] = {"trackHash": th, "frames": json.loads(json.dumps(fr))}
        summ = summary_doc(s, lf_by.get(sid, empty_lf), place_names, fr, base)
        trk = track_doc(s, fx_by[sid], hr_by[sid])
        (sdir / "summary.json").write_bytes(dumps(summ))
        (sdir / "track.json").write_bytes(dumps(trk))
        h = hr_by[sid]
        (sdir / "og.png").write_bytes(og.render(s.to_dict(), h.lon.to_numpy(), h.lat.to_numpy(), h.wind_kt.to_numpy()))
        # content hash of the storm's documents with this version's prefix normalised away (the summary lists
        # every frame file's sha256, so it covers the frames too)
        hsh = hashlib.sha256()
        for name in ("summary.json", "track.json", "og.png"):
            data = (sdir / name).read_bytes()
            if name.endswith(".json"):
                data = data.replace(base_v.encode(), b"v{N}/")
            hsh.update(name.encode() + b"\0" + hashlib.sha256(data).digest())
        content = hsh.hexdigest()[:32]
        path = f"{base_v}storms/{sid}/"
        if sid in prev_paths and prev_paths[sid][1] == content and sid not in local:
            path = prev_paths[sid][0]
            shutil.rmtree(sdir)
            reused += 1
        index_rows.append([
            sid, s["name"], s.name_pagasa if isinstance(s.name_pagasa, str) else None,
            s.name_ja if isinstance(s.name_ja, str) else None, int(s.season), iso(s.started_at), iso(s.ended_at),
            num(s.peak_wind_kt), s.peak_wind_agency if isinstance(s.peak_wind_agency, str) else None,
            num(s.min_pressure_hpa), list(s.landfall_countries), [num(v, 2) for v in s.bbox], bool(fr),
            replay[sid]["ratio"] if fr else None, path, content, th,
        ])
    index = {
        "schema": SCHEMA, "dataVersion": version, "generatedAt": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "storms": {"columns": ["sid", "name", "pagasa", "ja", "season", "start", "end", "peakWindKt", "peakAgency",
                               "minPressureHpa", "landfall", "bbox", "replay", "era5Ratio", "path", "contentHash",
                               "trackHash"],
                   "rows": index_rows},
        "places": f"{base_v}places/index.json", "manifest": f"{base_v}manifest.json", "tables": f"{base_v}tables/",
        "framesIndex": f"{base_v}frames-index.json", "era5Note": ERA5_HONESTY,
    }
    (vdir / "index.json").write_bytes(dumps(index))
    (vdir / "frames-index.json").write_bytes(dumps(frames_index))
    write_places(vdir, base_v, pl, ex, st)
    tinfo = tables.build_tables(vdir / "tables", replay)
    write_manifest(vdir, version, index, tinfo, local, reused, remote_files, len(replay), reused_frames)
    log.info("built %s: %d storms, %d with frames (%d built now, %d reused), %d storm folders reused",
             vdir, len(index_rows), len(replay), len(local), reused_frames, reused)
    return vdir


def write_places(vdir: Path, base_v: str, pl: pd.DataFrame, ex: pd.DataFrame, st: pd.DataFrame) -> None:
    pdir = ensure_dir(vdir / "places")
    names = st.set_index("sid")[["name", "season"]]
    shards = []
    exb = ex.merge(pl[["place_id", "shard"]], on="place_id")
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
                "centroid": [r.centroid_lon, r.centroid_lat], "bbox": list(r.bbox)}.items() if v is not None}
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
    manifest = {
        "schema": SCHEMA, "dataVersion": version, "createdAt": index["generatedAt"], "repo": HF_REPO,
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
        "counts": {"storms": len(index["storms"]["rows"]), "reusedStormFolders": reused, "tables": tinfo},
        "files": files,
    }
    (vdir / "manifest.json").write_bytes(json.dumps(manifest, ensure_ascii=False, indent=1).encode())


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
    cols = idx["storms"]["columns"]
    rows = [dict(zip(cols, r, strict=True)) for r in idx["storms"]["rows"]]
    if len(rows) < 1500:
        problems.append(f"only {len(rows)} storms")
    replay = 0
    for r in rows:
        sdir = root / r["path"]
        if not (sdir / "summary.json").exists() and r["path"].startswith(vdir.name + "/"):
            problems.append(f"{r['sid']}: summary.json missing")
            continue
        if not r["path"].startswith(vdir.name + "/"):
            continue  # reused from a previous, already-validated version
        s = json.loads((sdir / "summary.json").read_text())
        if s["sid"] != r["sid"] or s.get("replayAvailable") != r["replay"]:
            problems.append(f"{r['sid']}: summary/index disagree")
        if r["replay"]:
            replay += 1
            fr = s["frames"]
            h = s.get("era5VsBestTrack", {})
            if h.get("headlineRatio") is None:
                problems.append(f"{r['sid']}: no ERA5 honesty ratio")
            elif not 0.05 < h["headlineRatio"] < 1.5:
                problems.append(f"{r['sid']}: implausible ERA5 ratio {h['headlineRatio']}")
            total = 0
            for seg in fr["segments"]:
                total += seg["frames"]
                if "tyf" in seg and (root / seg["tyf"]["path"]).exists():
                    hdr, q = parse_tyf((root / seg["tyf"]["path"]).read_bytes())
                    if hdr["frames"] != seg["frames"] or hdr["sid"] != r["sid"]:
                        problems.append(f"{r['sid']}: bad tyf header in segment {seg['index']}")
                    nod = float((q[:, :4] == 255).mean())
                    if nod > 0.01:
                        problems.append(f"{r['sid']}: {nod:.1%} nodata in segment {seg['index']}")
                    for vi, (name, w) in enumerate(seg.get("webp", {}).items()):
                        data = (root / w["path"]).read_bytes()
                        if not np.array_equal(unsprite(data, seg["frames"], hdr["ny"], hdr["nx"], w["cols"]),
                                              q[:, [v["name"] for v in hdr["vars"]].index(name)]):
                            problems.append(f"{r['sid']}: webp {name} differs from tyf in segment {seg['index']}")
                        del vi
            if total != fr["frames"]:
                problems.append(f"{r['sid']}: segment frames {total} != {fr['frames']}")
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
