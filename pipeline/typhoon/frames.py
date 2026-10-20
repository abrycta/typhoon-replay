"""Quantised ERA5 replay frames per storm: `.tyf` segments and lossless WebP sprite sheets.

Usage: uv run python -m typhoon.frames --sid 2013306N07162 [--sid ...] [--formats tyf,webp]

Both formats carry the same uint8 values (the WebP sheets are byte-exact copies of the .tyf planes):

.tyf (little-endian), one file per segment of at most SEGMENT_HOURS frames
  bytes 0-3   magic b"TYF1"
  bytes 4-7   uint32 header length H (UTF-8 JSON, space-padded so the data starts on an 8-byte boundary)
  bytes 8..   JSON header (vars, encodings, per-frame time and NW corner, credit, ...)
  data        uint8[frames][vars][ny][nx], row 0 = north edge, col 0 = west edge
  Frame i of variable v starts at 8 + H + (i * nvars + v) * ny * nx: one hour is one contiguous range,
  so a client can fetch any hour with a single HTTP range request and decode it on its own.

WebP sprite sheets, one per variable per segment: greyscale (L) lossless, tiles of nx x ny laid out
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
SEGMENT_HOURS = 168          # 7 days: 5.5 MB per .tyf segment, a 13 x 13 sprite grid (1053 px)
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
    Enc("rain", "mm/h", "sqrt", 0.04, 0.0, "mean precipitation rate in the hour ending at the frame time (ERA5 mtpr); 0-103.2"),
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
        "rain": w.fields["mtpr"] * 3600.0,
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

def honesty(fields: dict[str, np.ndarray], w: era5.Windows, hourly: pd.DataFrame, radius_deg: float = 2.0) -> dict[str, Any]:
    """ERA5 maximum 10 m wind within `radius_deg` of the best-track centre vs the best-track winds."""
    n = era5.N
    off = (np.arange(n) - n // 2) * 0.25
    rows = []
    for i in range(len(hourly)):
        clat = w.nw_lat[i] - (n // 2) * 0.25
        clon = w.nw_lon[i] + (n // 2) * 0.25
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

    def r(x: float, d: int = 3) -> float | None:
        return None if x is None or not np.isfinite(x) else round(float(x), d)

    out: dict[str, Any] = {"radiusDeg": radius_deg, "method": (
        "ERA5 max 10 m wind within 2 deg of the hourly best-track centre, compared with the best-track "
        "sustained wind (JTWC 1-min, JMA 10-min) at the same hour")}
    for ag, col in (("jtwc", "jtwc"), ("jma", "jma")):
        s = df[col]
        if s.notna().any() and s.max() > 0:
            k = int(s.idxmax())
            strong = df[s >= 64 * KT]
            out[ag] = {
                "peakAt": pd.Timestamp(df.time[k]).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "bestTrackPeakMs": r(s[k], 1), "era5AtPeakMs": r(df.era5_wind[k], 1),
                "ratioAtPeak": r(df.era5_wind[k] / s[k]),
                "ratioLifetimeMax": r(df.era5_wind.max() / s.max()),
                "medianRatioTyphoonHours": r((strong.era5_wind / strong[col]).median()) if len(strong) else None,
                "typhoonHours": int(len(strong)),
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
    return out


# ----------------------------------------------------------------------------- per storm

def build_storm(sid: str, hourly: pd.DataFrame, storm: dict[str, Any], *, formats: tuple[str, ...] = ("tyf", "webp"),
                manifest: sources.RunManifest | None = None, out_root: Path = OUT) -> dict[str, Any]:
    """Read ERA5 windows along the hourly track, write the frame files, return the frames manifest."""
    hourly = hourly.sort_values("time").reset_index(drop=True)
    hours = hourly.time.dt.tz_convert("UTC").dt.tz_localize(None).to_numpy().astype("datetime64[h]")
    w = era5.read_windows(hours, hourly.lat.to_numpy(), hourly.lon.to_numpy(), manifest=manifest)
    fields = physical_fields(w)
    q = np.stack([quantise(fields[e.name], e) for e in ENC], axis=1)       # T, V, ny, nx
    out = ensure_dir(out_root / sid)
    for old in out.glob("*"):
        old.unlink()
    years = sorted({int(str(h)[:4]) for h in hours})
    credit = ERA5_CREDIT.format(years=f"{years[0]}" if years[0] == years[-1] else f"{years[0]}-{years[-1]}")
    nw_lat, nw_lon = w.nw_lat, w.nw_lon
    unix = (hours.astype("datetime64[s]").astype("int64")).tolist()
    served = {k: {lk: v.count(lk) for lk in dict.fromkeys(v)} for k, v in w.served.items()}
    qerr: dict[str, Any] = {}
    for vi, e in enumerate(ENC):
        if e.kind == "angle":
            continue
        d = dequantise(q[:, vi], e) - fields[e.name]
        ok = np.isfinite(d)
        qerr[e.name] = {"maxAbs": round(float(np.abs(d[ok]).max()), 4) if ok.any() else None,
                        "clipped": int((q[:, vi] == 254).sum()), "nodata": int((q[:, vi] == NODATA).sum())}
    segs = []
    nseg = math.ceil(len(hours) / SEGMENT_HOURS)
    for s in range(nseg):
        a, b = s * SEGMENT_HOURS, min((s + 1) * SEGMENT_HOURS, len(hours))
        seg: dict[str, Any] = {"index": s, "frames": b - a, "start": pd.Timestamp(hours[a]).strftime("%Y-%m-%dT%H:%M:%SZ"),
                               "end": pd.Timestamp(hours[b - 1]).strftime("%Y-%m-%dT%H:%M:%SZ"), "firstFrame": a}
        header = {
            "format": "TYF1", "version": 1, "sid": sid, "name": storm.get("name"), "season": storm.get("season"),
            "segment": s, "segments": nseg, "firstFrame": a, "frames": b - a, "nx": era5.N, "ny": era5.N,
            "resDeg": 0.25, "nodata": NODATA, "layout": "uint8[frames][vars][ny][nx], row 0 north, col 0 west",
            "vars": [{"name": e.name, "units": e.units, "encoding": e.kind, "scale": e.scale, "offset": e.offset,
                      "description": e.description} for e in ENC],
            "time": unix[a:b], "nwLat": [round(float(x), 2) for x in nw_lat[a:b]],
            "nwLon": [round(float(lon180(x)), 2) for x in nw_lon[a:b]],
            "source": "ERA5 hourly single levels, 0.25 deg (NSF NCAR ds633.0 / ARCO-ERA5)", "servedBy": served,
            "credit": credit, "licence": "CC BY 4.0",
        }
        if "tyf" in formats:
            blob, hlen = tyf_bytes(q[a:b], header)
            assert len(blob) < MAX_FILE_BYTES
            name = f"{sid}.s{s}.tyf"
            (out / name).write_bytes(blob)
            seg["tyf"] = {"file": name, "bytes": len(blob), "sha256": sha256(blob), "headerBytes": hlen,
                          "frameBytes": len(ENC) * era5.N * era5.N}
        if "webp" in formats:
            seg["webp"] = {}
            for vi, e in enumerate(ENC):
                data, cols, rows = sprite(q[a:b, vi])
                assert np.array_equal(unsprite(data, b - a, era5.N, era5.N, cols), q[a:b, vi]), "webp not lossless"
                name = f"{sid}.s{s}.{e.name}.webp"
                (out / name).write_bytes(data)
                seg["webp"][e.name] = {"file": name, "bytes": len(data), "sha256": sha256(data), "cols": cols,
                                       "rows": rows}
        segs.append(seg)
    meta = {
        "sid": sid, "frames": len(hours), "start": segs[0]["start"], "end": segs[-1]["end"], "nx": era5.N,
        "ny": era5.N, "resDeg": 0.25, "segmentHours": SEGMENT_HOURS, "formats": list(formats),
        "vars": [{"name": e.name, "units": e.units, "encoding": e.kind, "scale": e.scale, "offset": e.offset,
                  "description": e.description} for e in ENC],
        "nodata": NODATA, "segments": segs, "servedBy": served, "credit": credit,
        "quantisation": qerr, "era5VsBestTrack": honesty(fields, w, hourly),
    }
    (out / "frames.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False))
    return meta


def main(argv: list[str] | None = None) -> None:
    from . import catalog

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", action="append", required=True)
    ap.add_argument("--formats", default="tyf,webp")
    a = ap.parse_args(argv)
    st = catalog.load("storms").set_index("sid")
    hr = catalog.load("hourly")
    for sid in a.sid:
        m = build_storm(sid, hr[hr.sid == sid], {"name": st.loc[sid, "name"], "season": int(st.loc[sid, "season"])},
                        formats=tuple(a.formats.split(",")))
        print(json.dumps({k: m[k] for k in ("sid", "frames", "servedBy", "quantisation", "era5VsBestTrack")}, indent=1))


if __name__ == "__main__":
    main()
