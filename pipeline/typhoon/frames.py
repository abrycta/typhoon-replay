"""Quantised ERA5 replay frames per storm: `.tyf` segments and lossless WebP sprite sheets.

Usage: uv run python -m typhoon.frames --sid 2013306N07162 [--sid ...] [--formats tyf,webp]

Both formats carry the same uint8 values (the WebP sheets are byte-exact copies of the .tyf planes):

frames.tyf (little-endian), one file per storm (split only past SEGMENT_HOURS, the 25 MiB cap)
  bytes 0-3   magic b"TYF1"
  bytes 4-7   uint32 header length H (UTF-8 JSON, space-padded so the data starts on an 8-byte boundary)
  bytes 8..   JSON header (vars, encodings, per-frame time and NW corner, credit, ...)
  data        uint8[frames][vars][ny][nx], row 0 = north edge, col 0 = west edge
  Frame i of variable v starts at 8 + H + (i * nvars + v) * ny * nx: one hour is one contiguous range,
  so a client can fetch any hour with a single HTTP range request and decode it on its own.

WebP sprite sheets (<var>.webp), one per variable: greyscale (L) lossless, tiles of nx x ny laid out
row-major in a `cols` x `rows` grid (frame i at column i % cols, row i // cols); the same uint8 values.

Decoding (header.vars[*]):
  linear: value = offset + q * scale        (q == 255 -> nodata)
  sqrt:   value = (q * scale) ** 2          (precipitation: finer steps for light rain)
  angle:  degrees = q * 360 / 256           (direction the wind blows towards, clockwise from north)
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from PIL import Image

from . import era5, sources
from .config import ERA5_CREDIT, KT, PROCESSED, ensure_dir
from .track import lon180

log = logging.getLogger("typhoon.frames")
OUT = PROCESSED / "frames"
SEGMENT_HOURS = 744          # 31 days = 24.4 MB < 25 MiB; longer storms are split (none since 1940 is)
MAX_FILE_BYTES = 25 * 2**20  # hosting cap per file (Cloudflare Pages); HF has none, we keep it anyway
NODATA = 255


@dataclass(frozen=True)
class Enc:
    name: str
    units: str
    kind: str
    scale: float
    offset: float
    description: str


ENC = (
    Enc("wind", "m/s", "linear", 0.3, 0.0, "10 m wind speed from u/v (analysis, instantaneous); 0-76.2"),
    Enc("gust", "m/s", "linear", 0.4, 0.0, "maximum 10 m gust in the hour ending at the frame time (ERA5 10fg); 0-101.6"),
    Enc("mslp", "hPa", "linear", 0.65, 870.0, "mean sea-level pressure (analysis); 870-1035.1"),
    Enc("tp", "mm/h", "sqrt", 0.04, 0.0, "mean precipitation rate in the hour ending at the frame time (ERA5 mtpr); 0-103.2"),
    Enc("wdir", "deg", "angle", 360 / 256, 0.0, "direction the 10 m wind blows towards, clockwise from north"),
)


def quantise(x: np.ndarray, e: Enc) -> np.ndarray:
    if e.kind == "angle":
        q = (np.round(np.nan_to_num(x) / e.scale) % 256).astype(np.uint8)
        q[~np.isfinite(x)] = 0
        return q
    y = np.sqrt(np.maximum(x, 0)) if e.kind == "sqrt" else x - e.offset
    with np.errstate(invalid="ignore"):
        q = np.clip(np.round(y / e.scale), 0, 254)
    q[~np.isfinite(x)] = NODATA
    return q.astype(np.uint8)


def dequantise(q: np.ndarray, e: Enc) -> np.ndarray:
    v = q.astype(np.float32) * np.float32(e.scale)
    out = v**2 if e.kind == "sqrt" else v + np.float32(e.offset)
    if e.kind != "angle":
        out[q == NODATA] = np.nan
    return out


def physical_fields(w: era5.Windows) -> dict[str, np.ndarray]:
    u, v = w.fields["u10"], w.fields["v10"]
    return {
        "wind": np.hypot(u, v),
        "gust": w.fields["fg10"],
        "mslp": w.fields["msl"] / 100.0,
        "tp": w.fields["mtpr"] * 3600.0,
        "wdir": (np.degrees(np.arctan2(u, v)) + 360) % 360,
    }


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def tyf_bytes(q: np.ndarray, header: dict[str, Any]) -> tuple[bytes, int]:
    hb = json.dumps(header, separators=(",", ":"), ensure_ascii=False).encode()
    hb += b" " * ((-(8 + len(hb))) % 8)
    return b"TYF1" + len(hb).to_bytes(4, "little") + hb + q.tobytes(), 8 + len(hb)


def parse_tyf(blob: bytes) -> tuple[dict[str, Any], np.ndarray]:
    assert blob[:4] == b"TYF1"
    hl = int.from_bytes(blob[4:8], "little")
    h = json.loads(blob[8:8 + hl])
    q = np.frombuffer(blob[8 + hl:], np.uint8).reshape(h["frames"], len(h["vars"]), h["ny"], h["nx"])
    return h, q


def sprite(q: np.ndarray) -> tuple[bytes, int, int]:
    """Lossless greyscale WebP sheet of frames q[t, ny, nx]."""
    t, h, w = q.shape
    cols = math.ceil(math.sqrt(t))
    rows = math.ceil(t / cols)
    sheet = np.zeros((rows * h, cols * w), np.uint8)
    for i in range(t):
        r, c = divmod(i, cols)
        sheet[r * h:(r + 1) * h, c * w:(c + 1) * w] = q[i]
    buf = io.BytesIO()
    Image.fromarray(sheet, "L").save(buf, format="WEBP", lossless=True, quality=100, method=4, exact=True)
    return buf.getvalue(), cols, rows


def unsprite(data: bytes, frames: int, ny: int, nx: int, cols: int) -> np.ndarray:
    im = np.asarray(Image.open(io.BytesIO(data)).convert("L"))
    out = np.empty((frames, ny, nx), np.uint8)
    for i in range(frames):
        r, c = divmod(i, cols)
        out[i] = im[r * ny:(r + 1) * ny, c * nx:(c + 1) * nx]
    return out


# ----------------------------------------------------------------------------- honesty cross-check

def honesty(fields: dict[str, np.ndarray], nw_lat: np.ndarray, nw_lon: np.ndarray, hourly: pd.DataFrame,
            radius_deg: float = 2.0) -> dict[str, Any]:
    """ERA5 maximum 10 m wind within `radius_deg` of the best-track centre vs the best-track winds.

    Returns our full cross-check plus `reanalysisCheck`, the shape the web app reads (web/docs/DATA-LAYOUT.md).
    """
    n = era5.N
    off = (np.arange(n) - n // 2) * 0.25
    rows = []
    for i in range(len(hourly)):
        clat = nw_lat[i] - (n // 2) * 0.25
        clon = nw_lon[i] + (n // 2) * 0.25
        dy = -off[:, None] + (clat - hourly.lat.iloc[i])
        dlon = ((off[None, :] + clon - hourly.lon.iloc[i] + 180) % 360) - 180
        dx = dlon * math.cos(math.radians(hourly.lat.iloc[i]))
        m = np.hypot(dy, dx) <= radius_deg
        wind, gust, p = fields["wind"][i][m], fields["gust"][i][m], fields["mslp"][i][m]
        rows.append({"time": hourly.time.iloc[i],
                     "era5_wind": float(np.nanmax(wind)) if np.isfinite(wind).any() else np.nan,
                     "era5_gust": float(np.nanmax(gust)) if np.isfinite(gust).any() else np.nan,
                     "era5_mslp": float(np.nanmin(p)) if np.isfinite(p).any() else np.nan,
                     "jtwc": hourly.jtwc_wind_kt.iloc[i] * KT, "jma": hourly.jma_wind_kt.iloc[i] * KT,
                     "jma_p": hourly.jma_pressure_hpa.iloc[i], "jtwc_p": hourly.jtwc_pressure_hpa.iloc[i]})
    df = pd.DataFrame(rows)

    def r(x: Any, d: int = 3) -> float | None:
        return None if x is None or not np.isfinite(x) else round(float(x), d)

    out: dict[str, Any] = {"radiusDeg": radius_deg, "method": (
        "ERA5 max 10 m wind within 2 deg of the hourly best-track centre, compared with the best-track "
        "sustained wind (JTWC 1-min, JMA 10-min) at the same hour")}
    for ag in ("jtwc", "jma"):
        s = df[ag]
        if s.notna().any() and s.max() > 0:
            k = int(s.idxmax())
            strong = df[s >= 64 * KT]
            out[ag] = {
                "peakAt": pd.Timestamp(df.time[k]).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "bestTrackPeakMs": r(s[k], 1), "era5AtPeakMs": r(df.era5_wind[k], 1),
                "ratioAtPeak": r(df.era5_wind[k] / s[k]),
                "ratioLifetimeMax": r(df.era5_wind.max() / s.max()),
                "medianRatioTyphoonHours": r((strong.era5_wind / strong[ag]).median()) if len(strong) else None,
                "typhoonHours": len(strong),
            }
    out["era5MaxWindMs"] = r(df.era5_wind.max(), 1)
    out["era5MaxGustMs"] = r(df.era5_gust.max(), 1)
    out["era5MinMslpHpa"] = r(df.era5_mslp.min(), 1)
    bp = df.jma_p.min() if df.jma_p.notna().any() else df.jtwc_p.min()
    out["bestTrackMinPressureHpa"] = r(bp, 0)
    out["pressureBiasHpa"] = r(df.era5_mslp.min() - bp, 1) if np.isfinite(bp) else None
    ref = out.get("jtwc") or out.get("jma")
    out["headlineRatio"] = ref["ratioAtPeak"] if ref else None
    out["headlineAgency"] = "jtwc" if out.get("jtwc") else ("jma" if out.get("jma") else None)
    # the web app's shape: everything at the JTWC peak (JMA's when JTWC has no winds)
    if ref:
        k = int(df[out["headlineAgency"]].idxmax())
        out["reanalysisCheck"] = {k2: v for k2, v in {
            "radiusDeg": radius_deg, "peakTime": pd.Timestamp(df.time[k]).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "atPeak": {k3: v3 for k3, v3 in {
                "jtwcMs": r(df.jtwc[k], 1), "jmaMs": r(df.jma[k], 1), "era5WindMs": r(df.era5_wind[k], 1),
                "era5GustMs": r(df.era5_gust[k], 1),
                "ratioToJtwc": r(df.era5_wind[k] / df.jtwc[k]) if df.jtwc[k] else None,
                "ratioToJma": r(df.era5_wind[k] / df.jma[k]) if df.jma[k] else None,
                "era5MslpMinHpa": r(df.era5_mslp[k], 1), "jmaPressureHpa": r(df.jma_p[k], 0)}.items()
                if v3 is not None},
            "typhoonHoursMedianRatioToJtwc": (out.get("jtwc") or {}).get("medianRatioTyphoonHours"),
            "typhoonHoursMedianRatioToJma": (out.get("jma") or {}).get("medianRatioTyphoonHours"),
        }.items() if v is not None}
    return out


# ----------------------------------------------------------------------------- per storm

def iso(t: Any) -> str:
    return pd.Timestamp(t).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_frames(sid: str, q: np.ndarray, hours: np.ndarray, nw_lat: np.ndarray, nw_lon: np.ndarray,
                 storm: dict[str, Any], served: dict[str, Any], qerr: dict[str, Any], check: dict[str, Any],
                 out: Path, formats: tuple[str, ...] = ("tyf", "webp")) -> dict[str, Any]:
    """Write frames.tyf (+ <var>.webp sheets) for one storm and its frames.json manifest.

    One file per storm (what the web app reads). Only a storm longer than SEGMENT_HOURS, which would pass
    the 25 MiB per-file cap, is split into frames.s<k>.tyf segments.
    """
    for old in out.glob("*"):
        if old.name != "provenance.json":
            old.unlink()
    years = sorted({int(str(h)[:4]) for h in hours})
    credit = ERA5_CREDIT.format(years=f"{years[0]}" if years[0] == years[-1] else f"{years[0]}-{years[-1]}")
    unix = hours.astype("datetime64[s]").astype("int64").tolist()
    nseg = math.ceil(len(hours) / SEGMENT_HOURS)
    var_meta = [{"name": e.name, "units": e.units, "encoding": e.kind, "scale": e.scale, "offset": e.offset,
                 "description": e.description} for e in ENC]
    segs = []
    for s in range(nseg):
        a, b = s * SEGMENT_HOURS, min((s + 1) * SEGMENT_HOURS, len(hours))
        stem = "frames" if nseg == 1 else f"frames.s{s}"
        seg: dict[str, Any] = {"index": s, "frames": b - a, "start": iso(hours[a]), "end": iso(hours[b - 1]),
                               "firstFrame": a}
        header = {
            "format": "TYF1", "version": 1, "sid": sid, "name": storm.get("name"), "season": storm.get("season"),
            "segment": s, "segments": nseg, "first_frame": a, "frames": b - a, "nx": era5.N, "ny": era5.N,
            "res_deg": 0.25, "nodata": NODATA, "layout": "uint8[frames][vars][ny][nx], row 0 north, col 0 west",
            "vars": var_meta, "time": unix[a:b],
            "nw_lat": [round(float(x), 2) for x in nw_lat[a:b]],
            "nw_lon": [round(float(lon180(x)), 2) for x in nw_lon[a:b]],
            "source": "ERA5 hourly single levels, 0.25 deg (NSF NCAR ds633.0 / ARCO-ERA5)", "served_by": served,
            "credit": credit, "licence": "CC BY 4.0",
        }
        if "tyf" in formats:
            blob, hlen = tyf_bytes(q[a:b], header)
            assert len(blob) < MAX_FILE_BYTES
            (out / f"{stem}.tyf").write_bytes(blob)
            seg["tyf"] = {"file": f"{stem}.tyf", "bytes": len(blob), "sha256": sha256(blob), "headerBytes": hlen,
                          "frameBytes": len(ENC) * era5.N * era5.N}
        if "webp" in formats:
            seg["webp"] = {}
            for vi, e in enumerate(ENC):
                data, cols, rows = sprite(q[a:b, vi])
                assert np.array_equal(unsprite(data, b - a, era5.N, era5.N, cols), q[a:b, vi]), "webp not lossless"
                name = f"{e.name}.webp" if nseg == 1 else f"{e.name}.s{s}.webp"
                (out / name).write_bytes(data)
                seg["webp"][e.name] = {"file": name, "bytes": len(data), "sha256": sha256(data), "cols": cols,
                                       "rows": rows, "tileWidth": era5.N, "tileHeight": era5.N}
        segs.append(seg)
    meta = {
        "sid": sid, "frames": len(hours), "start": segs[0]["start"], "end": segs[-1]["end"], "nx": era5.N,
        "ny": era5.N, "resDeg": 0.25, "segmentHours": SEGMENT_HOURS, "formats": list(formats), "vars": var_meta,
        "nodata": NODATA, "segments": segs, "servedBy": served, "credit": credit, "quantisation": qerr,
        "era5VsBestTrack": check,
    }
    (out / "frames.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False))
    return meta


def quantisation_report(q: np.ndarray, fields: dict[str, np.ndarray]) -> dict[str, Any]:
    qerr: dict[str, Any] = {}
    for vi, e in enumerate(ENC):
        if e.kind == "angle":
            continue
        d = dequantise(q[:, vi], e) - fields[e.name]
        ok = np.isfinite(d)
        qerr[e.name] = {"maxAbs": round(float(np.abs(d[ok]).max()), 4) if ok.any() else None,
                        "clipped": int((q[:, vi] == 254).sum()), "nodata": int((q[:, vi] == NODATA).sum())}
    return qerr


def build_storm(sid: str, hourly: pd.DataFrame, storm: dict[str, Any], *, formats: tuple[str, ...] = ("tyf", "webp"),
                manifest: sources.RunManifest | None = None, out_root: Path = OUT) -> dict[str, Any]:
    """Read ERA5 windows along the hourly track, write the frame files, return the frames manifest."""
    hourly = hourly.sort_values("time").reset_index(drop=True)
    hours = hourly.time.dt.tz_convert("UTC").dt.tz_localize(None).to_numpy().astype("datetime64[h]")
    w = era5.read_windows(hours, hourly.lat.to_numpy(), hourly.lon.to_numpy(), manifest=manifest)
    fields = physical_fields(w)
    q = np.stack([quantise(fields[e.name], e) for e in ENC], axis=1)       # T, V, ny, nx
    served = {k: {lk: v.count(lk) for lk in dict.fromkeys(v)} for k, v in w.served.items()}
    return write_frames(sid, q, hours, w.nw_lat, w.nw_lon, storm, served, quantisation_report(q, fields),
                        honesty(fields, w.nw_lat, w.nw_lon, hourly), ensure_dir(out_root / sid), formats)


def repack(d: Path, hourly: pd.DataFrame, storm: dict[str, Any]) -> dict[str, Any]:
    """Rewrite a storm built with an older file layout (7-day segments, `rain`, camelCase header keys) in
    the current layout, without re-reading ERA5. The cross-check is recomputed from the stored values."""
    meta = json.loads((d / "frames.json").read_text())
    parts, lat, lon, times = [], [], [], []
    for seg in meta["segments"]:
        h, q = parse_tyf((d / seg["tyf"]["file"]).read_bytes())
        parts.append(q)
        lat += h.get("nw_lat") or h["nwLat"]
        lon += h.get("nw_lon") or h["nwLon"]
        times += h["time"]
    q = np.concatenate(parts)
    hours = np.array(times, dtype="datetime64[s]").astype("datetime64[h]")
    nw_lat, nw_lon = np.array(lat, float), np.array(lon, float) % 360
    fields = {e.name: dequantise(q[:, vi], e) for vi, e in enumerate(ENC)}
    hourly = hourly.sort_values("time").reset_index(drop=True)
    assert len(hourly) == len(hours), f"{d.name}: track has {len(hourly)} hours, frames {len(hours)}"
    return write_frames(d.name, q, hours, nw_lat, nw_lon, storm, meta["servedBy"], meta["quantisation"],
                        honesty(fields, nw_lat, nw_lon, hourly), d, tuple(meta.get("formats", ("tyf", "webp"))))


def validate_storm(d: Path) -> None:
    """Gate before a storm's frames leave the machine: header, sizes, checksums, nodata, WebP == tyf."""
    meta = json.loads((d / "frames.json").read_text())
    for seg in meta["segments"]:
        if "tyf" not in seg:
            continue
        blob = (d / seg["tyf"]["file"]).read_bytes()
        if sha256(blob) != seg["tyf"]["sha256"] or len(blob) >= MAX_FILE_BYTES:
            raise ValueError(f"{d.name}: bad tyf segment {seg['index']}")
        h, q = parse_tyf(blob)
        if h["frames"] != seg["frames"]:
            raise ValueError(f"{d.name}: frame count mismatch in segment {seg['index']}")
        nod = float((q[:, :4] == NODATA).mean())
        if nod > 0.01:
            raise ValueError(f"{d.name}: {nod:.1%} nodata in segment {seg['index']}")
        names = [v["name"] for v in h["vars"]]
        for name, w in seg.get("webp", {}).items():
            back = unsprite((d / w["file"]).read_bytes(), seg["frames"], h["ny"], h["nx"], w["cols"])
            if not np.array_equal(back, q[:, names.index(name)]):
                raise ValueError(f"{d.name}: webp {name} differs from tyf in segment {seg['index']}")


def upload_storm(d: Path, version: int) -> None:
    """Push one storm's frame files to v<version>/storms/<sid>/ (retrying concurrent-commit conflicts)."""
    from huggingface_hub import HfApi

    from .config import HF_REPO
    from .publish import token

    for k in range(5):
        try:
            HfApi(token=token()).upload_folder(
                repo_id=HF_REPO, repo_type="dataset", folder_path=str(d), path_in_repo=f"v{version}/storms/{d.name}",
                allow_patterns=["*.tyf", "*.webp"], commit_message=f"v{version}: frames for {d.name}")
            return
        except Exception as e:  # noqa: BLE001  concurrent batch commits can conflict: retry
            log.warning("upload of %s failed (%s), retry %d", d.name, e, k + 1)
            time.sleep(10 * (k + 1))
    raise RuntimeError(f"could not upload {d.name}")


def read_list(path: Path) -> list[str]:
    """SIDs from a curated list file (one per line, '#' comments)."""
    out = []
    for line in path.read_text().splitlines():
        s = line.split("#", 1)[0].strip()
        if s:
            out.append(s)
    return out


def main(argv: list[str] | None = None) -> None:
    from . import catalog

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", action="append", default=[])
    ap.add_argument("--list", type=Path, help="file of SIDs (e.g. curated/replay-v1.txt)")
    ap.add_argument("--formats", default="tyf,webp")
    ap.add_argument("--skip-existing", action="store_true", help="skip storms whose frames.json exists")
    ap.add_argument("--repack", action="store_true",
                    help="rewrite already-built storms in the current file layout (no ERA5 reads)")
    ap.add_argument("--plan", type=Path, help="batch plan JSON from `python -m typhoon plan`")
    ap.add_argument("--batch", help="batch number within --plan")
    ap.add_argument("--upload-version", type=int,
                    help="after building and validating each storm, upload its frame files to v<N>/storms/<sid>/ "
                         "on the Hugging Face dataset (invisible until latest.json flips)")
    a = ap.parse_args(argv)
    sids = a.sid + (read_list(a.list) if a.list else [])
    if a.plan:
        sids += json.loads(a.plan.read_text())[str(a.batch)]
    st = catalog.load("storms").set_index("sid")
    hr = catalog.load("hourly")
    for n, sid in enumerate(sids, 1):
        if sid not in st.index:
            log.error("%s is not in the catalogue; skipped", sid)
            continue
        if a.repack:
            if (OUT / sid / "frames.json").exists():
                repack(OUT / sid, hr[hr.sid == sid], {"name": st.loc[sid, "name"], "season": int(st.loc[sid, "season"])})
                validate_storm(OUT / sid)
                log.info("repacked %s", sid)
            continue
        if a.skip_existing and (OUT / sid / "frames.json").exists():
            continue
        t0 = time.time()
        man = sources.RunManifest()
        m = build_storm(sid, hr[hr.sid == sid], {"name": st.loc[sid, "name"], "season": int(st.loc[sid, "season"])},
                        formats=tuple(a.formats.split(",")), manifest=man)
        man.write(OUT / sid / "provenance.json")
        validate_storm(OUT / sid)
        if a.upload_version:
            upload_storm(OUT / sid, a.upload_version)
        h = m["era5VsBestTrack"]
        log.info("[%d/%d] %s %s: %d frames in %.0f s, %.0f MB read, ratio %s (%s), served %s", n, len(sids), sid,
                 st.loc[sid, "name"], m["frames"], time.time() - t0,
                 sum(p.bytes for p in man.items.values()) / 1e6, h["headlineRatio"], h["headlineAgency"],
                 {k: list(v) for k, v in m["servedBy"].items()})


if __name__ == "__main__":
    main()
