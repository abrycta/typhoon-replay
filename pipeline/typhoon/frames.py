"""Quantised ERA5 replay frames per storm, in three published forms.

Usage: uv run python -m typhoon.frames --sid 2013306N07162 [--sid ...] [--formats webp,tyf]

1. field  (always): lossy WebP sprite sheets, hourly, one per variable: wind, gust, mslp, tp, u, v.
   Greyscale, quality FIELD_QUALITY, tiles of 81 x 81 placed on a 96 px stride (edge-padded, so the
   codec's 16 px blocks never mix two hours). About 1.2 kB per storm-hour for all six variables. For
   drawing and animation only: values are within about +-1 m/s (p99 +-2) of the exact ones.
2. exact  (always): lossless WebP sheets, every 3rd hour, every other cell (0.5 deg, 41 x 41): wind, gust,
   mslp, tp, wdir. Exact quantised values for numeric readouts (hover, legends). About 1.2 kB per storm-hour.
   The per-hour maxima near the centre and the ERA5-vs-best-track ratios are computed before quantisation
   and stored as numbers in frames.json (`series`, `era5VsBestTrack`).
3. tyf    (optional, the original spike format): frames.tyf, uint8[frames][vars][81][81] lossless,
   33 kB per storm-hour; one hour per HTTP range. Kept for the storms the web app already reads it for.

Every file name starts with the first 16 hex digits of its sha256: files are content-addressed and are
published once under frames/<sid>/, outside the data versions (typhoon.dataset).

.tyf layout (little-endian): b"TYF1", uint32 header length H, JSON header (space-padded to 8 bytes), then
uint8[frames][vars][ny][nx], row 0 = north edge. Frame i of variable v starts at 8 + H + (i*nvars+v)*ny*nx.

Sprite sheets: frame k (k-th published hour) is the tile at column k % cols, row k // cols, its top-left
pixel at (col * stride, row * stride). Decoding per variable (`vars[*]`):
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
import random
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
        wind, gust, p, tp = fields["wind"][i][m], fields["gust"][i][m], fields["mslp"][i][m], fields["tp"][i][m]
        rows.append({"time": hourly.time.iloc[i],
                     "era5_wind": float(np.nanmax(wind)) if np.isfinite(wind).any() else np.nan,
                     "era5_gust": float(np.nanmax(gust)) if np.isfinite(gust).any() else np.nan,
                     "era5_mslp": float(np.nanmin(p)) if np.isfinite(p).any() else np.nan,
                     "era5_tp": float(np.nanmax(tp)) if np.isfinite(tp).any() else np.nan,
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
    out["series"] = {
        "note": f"Per frame, within {radius_deg:g} deg of the best-track centre, from the unquantised ERA5 fields.",
        "era5MaxWindMs": [r(x, 1) for x in df.era5_wind], "era5MaxGustMs": [r(x, 1) for x in df.era5_gust],
        "era5MinMslpHpa": [r(x, 1) for x in df.era5_mslp], "era5MaxRainMmh": [r(x, 1) for x in df.era5_tp]}
    return out


# ----------------------------------------------------------------------------- ERA5 centre vs best track

CENTRE_SEARCH_KM = 500     # look for ERA5's low within this distance of the best-track position
CENTRE_EDGE_KM = 450       # a minimum beyond this sits on the search edge: no closed low near the track
CENTRE_RING_KM = (250, 400)  # environment ring around the found minimum, for the closed-low depth
CENTRE_MIN_DEPTH_HPA = 2.0   # weaker than this: ERA5 has no identifiable centre


def _km(lat1: Any, lon1: Any, lat2: Any, lon2: Any) -> Any:
    p1, p2, dl = np.radians(lat1), np.radians(lat2), np.radians(np.asarray(lon2) - np.asarray(lon1))
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * 6371.0088 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def centre_offsets(mslp: np.ndarray, nw_lat: np.ndarray, nw_lon: np.ndarray, res: float, lat: np.ndarray,
                   lon: np.ndarray, frame_index: list[int]) -> dict[str, Any]:
    """Where ERA5 puts the storm centre, per frame, against the best-track position the app draws.

    mslp[F, ny, nx] in hPa (NaN = nodata), row 0 north, NW cell centre (nw_lat, nw_lon) per frame; lat/lon the
    best-track position at the same frames. The centre is the lowest sea-level pressure within
    CENTRE_SEARCH_KM of the track (sub-cell by a parabola fit); a frame gets null when that minimum lies on the
    search edge or is not a closed low (less than CENTRE_MIN_DEPTH_HPA below its 250-400 km ring), i.e. when ERA5
    has no identifiable vortex near the track. Bearing: from the best-track position to ERA5's centre.
    """
    F, ny, nx = mslp.shape
    rows: list[tuple[float | None, ...]] = []
    none = (None, None, None, None)
    for i in range(F):
        glat = nw_lat[i] - np.arange(ny) * res
        glon = nw_lon[i] + np.arange(nx) * res
        LA, LO = np.meshgrid(glat, glon, indexing="ij")
        p = mslp[i]
        d = _km(lat[i], lon[i], LA, LO)
        m = np.where((d <= CENTRE_SEARCH_KM) & np.isfinite(p), p, np.inf)
        if not np.isfinite(m).any():
            rows.append(none)
            continue
        r, c = np.unravel_index(int(np.argmin(m)), m.shape)

        def para(a: float, b: float, cc: float) -> float:
            den = a - 2 * b + cc
            return float(np.clip(0.5 * (a - cc) / den, -0.5, 0.5)) if np.isfinite(den) and den > 0 else 0.0

        dr = para(p[r - 1, c], p[r, c], p[r + 1, c]) if 0 < r < ny - 1 else 0.0
        dc = para(p[r, c - 1], p[r, c], p[r, c + 1]) if 0 < c < nx - 1 else 0.0
        elat, elon = float(nw_lat[i] - (r + dr) * res), float(nw_lon[i] + (c + dc) * res)
        dc_ = _km(elat, elon, LA, LO)
        ring = p[(dc_ >= CENTRE_RING_KM[0]) & (dc_ <= CENTRE_RING_KM[1]) & np.isfinite(p)]
        depth = float(ring.mean() - p[r, c]) if ring.size else 0.0
        if d[r, c] > CENTRE_EDGE_KM or depth < CENTRE_MIN_DEPTH_HPA:
            rows.append(none)
            continue
        p1, p2 = math.radians(lat[i]), math.radians(elat)
        dl = math.radians(elon - lon[i])
        b = math.degrees(math.atan2(math.sin(dl) * math.cos(p2),
                                    math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)))
        rows.append((round(float(_km(lat[i], lon[i], elat, elon))), round((b + 360) % 360),
                     round(elat, 2), round(float(lon180(elon % 360)), 2)))
    km, brg, clat, clon = (list(x) for x in zip(*rows, strict=True)) if rows else ([], [], [], [])
    return {"method": (f"Lowest ERA5 sea-level pressure within {CENTRE_SEARCH_KM} km of the best-track position, on "
                       f"the lossless 3-hourly grid; null when ERA5 has no closed low there (minimum on the search "
                       f"edge, or less than {CENTRE_MIN_DEPTH_HPA:g} hPa below its {CENTRE_RING_KM[0]}-"
                       f"{CENTRE_RING_KM[1]} km ring)."),
            "frameIndex": list(frame_index), "km": km, "bearingDeg": brg, "lat": clat, "lon": clon}


def centre_offsets_from_codes(q: np.ndarray, nw_lat: np.ndarray, nw_lon: np.ndarray, res: float,
                              hourly: pd.DataFrame, frame_index: list[int]) -> dict[str, Any]:
    """centre_offsets from exact mslp codes q[F, ny, nx]; `hourly` holds the track rows of every hourly frame."""
    mslp = dequantise(q, ENCODINGS["mslp"]).astype(float)
    hourly = hourly.sort_values("time").reset_index(drop=True)
    idx = np.asarray(frame_index)
    return centre_offsets(mslp, np.asarray(nw_lat, float)[idx], np.asarray(nw_lon, float)[idx], res,
                          hourly.lat.to_numpy(float)[idx], hourly.lon.to_numpy(float)[idx], list(frame_index))


# ----------------------------------------------------------------------------- per storm

FIELD_QUALITY = 80
FIELD_QUALITIES = (FIELD_QUALITY, 90, 97)  # tried in order per variable
MAX_FIELD_CODE_ERROR = 40
TILE_STRIDE = 96
EXACT_STEP_H, EXACT_STRIDE = 3, 2
UV = (Enc("u", "m/s", "linear", 0.6, -76.2, "10 m eastward wind (analysis); -76.2..76.2"),
      Enc("v", "m/s", "linear", 0.6, -76.2, "10 m northward wind (analysis); -76.2..76.2"))
FIELD_VARS = ("wind", "gust", "mslp", "tp", "u", "v")
EXACT_VARS = ("wind", "gust", "mslp", "tp", "wdir")
ENCODINGS = {e.name: e for e in (*ENC, *UV)}


def var_meta(e: Enc) -> dict[str, Any]:
    return {"name": e.name, "units": e.units, "encoding": e.kind, "scale": e.scale, "offset": e.offset,
            "description": e.description}


def sheet(q: np.ndarray, stride: int) -> tuple[np.ndarray, int, int]:
    """Tiles q[t, h, w] on a stride x stride grid, each edge-padded (no codec block spans two frames)."""
    t, h, w = q.shape
    cols = math.ceil(math.sqrt(t))
    rows = math.ceil(t / cols)
    s = np.zeros((rows * stride, cols * stride), np.uint8)
    for i in range(t):
        r, c = divmod(i, cols)
        s[r * stride:(r + 1) * stride, c * stride:(c + 1) * stride] = np.pad(
            q[i], ((0, stride - h), (0, stride - w)), mode="edge")
    return s, cols, rows


def unsheet(data: bytes, frames: int, ny: int, nx: int, cols: int, stride: int) -> np.ndarray:
    im = np.asarray(Image.open(io.BytesIO(data)).convert("L"))
    out = np.empty((frames, ny, nx), np.uint8)
    for i in range(frames):
        r, c = divmod(i, cols)
        out[i] = im[r * stride:r * stride + ny, c * stride:c * stride + nx]
    return out


def encode_webp(s: np.ndarray, quality: int | None) -> bytes:
    buf = io.BytesIO()
    if quality is None:
        Image.fromarray(s, "L").save(buf, format="WEBP", lossless=True, quality=100, method=4, exact=True)
    else:
        Image.fromarray(s, "L").save(buf, format="WEBP", quality=quality, method=6)
    return buf.getvalue()


def uv_codes(wind: np.ndarray, wdir: np.ndarray) -> dict[str, np.ndarray]:
    u, v = wind * np.sin(np.radians(wdir)), wind * np.cos(np.radians(wdir))
    return {"u": quantise(u, UV[0]), "v": quantise(v, UV[1])}


def iso(t: Any) -> str:
    return pd.Timestamp(t).strftime("%Y-%m-%dT%H:%M:%SZ")


def _named(out: Path, data: bytes, suffix: str) -> dict[str, Any]:
    h = sha256(data)
    name = f"{h[:16]}.{suffix}"
    (out / name).write_bytes(data)
    return {"file": name, "bytes": len(data), "sha256": h}


def write_frames(sid: str, codes: dict[str, np.ndarray], hours: np.ndarray, nw_lat: np.ndarray, nw_lon: np.ndarray,
                 storm: dict[str, Any], served: dict[str, Any], qerr: dict[str, Any], check: dict[str, Any],
                 out: Path, formats: tuple[str, ...] = ("webp",), hourly: pd.DataFrame | None = None) -> dict[str, Any]:
    """Write a storm's published frame files (content-addressed names) and its frames.json manifest.

    `codes` holds uint8 codes per variable ([T, 81, 81]) for wind, gust, mslp, tp, wdir, u, v; `hourly` (the
    track row of every frame) adds `centreOffset`, ERA5's centre against the best track on the exact grid.
    """
    for old in out.glob("*"):
        if old.name != "provenance.json":
            old.unlink()
    T = len(hours)
    years = sorted({int(str(h)[:4]) for h in hours})
    credit = ERA5_CREDIT.format(years=f"{years[0]}" if years[0] == years[-1] else f"{years[0]}-{years[-1]}")
    unix = hours.astype("datetime64[s]").astype("int64").tolist()
    files: dict[str, Any] = {}
    # 1. field: lossy, hourly
    fvars = []
    for n in FIELD_VARS:
        s, cols, rows = sheet(codes[n], TILE_STRIDE)
        # Start at FIELD_QUALITY; a field with sharp edges can exceed the error bound, so step up until it fits.
        for q in FIELD_QUALITIES:
            data = encode_webp(s, q)
            back = unsheet(data, T, era5.N, era5.N, cols, TILE_STRIDE)
            err = np.abs(back.astype(int) - codes[n].astype(int))[codes[n] != NODATA]
            max_err = int(err.max()) if err.size else 0
            if max_err <= MAX_FIELD_CODE_ERROR:
                break
        fvars.append(dict(var_meta(ENCODINGS[n]), **_named(out, data, f"field.{n}.webp"),
                          quality=q, maxCodeError=max_err))
    files["field"] = {"kind": "webp-lossy", "quality": FIELD_QUALITY, "stepHours": 1, "frames": T, "cols": cols,
                      "rows": rows, "tileWidth": era5.N, "tileHeight": era5.N, "tileStride": TILE_STRIDE,
                      "resDeg": 0.25, "vars": fvars,
                      "note": "For drawing only; read numbers from `exact`, `series` or `era5VsBestTrack`."}
    # 2. exact: lossless, 3-hourly, 0.5 deg
    idx = np.arange(0, T, EXACT_STEP_H)
    evars = []
    for n in EXACT_VARS:
        sub = codes[n][idx][:, ::EXACT_STRIDE, ::EXACT_STRIDE]
        s, ecols, erows = sheet(sub, sub.shape[1])
        data = encode_webp(s, None)
        assert np.array_equal(unsheet(data, len(idx), sub.shape[1], sub.shape[2], ecols, sub.shape[1]), sub)
        evars.append(dict(var_meta(ENCODINGS[n]), **_named(out, data, f"exact.{n}.webp")))
    files["exact"] = {"kind": "webp-lossless", "stepHours": EXACT_STEP_H, "frameIndex": idx.tolist(),
                      "frames": len(idx), "cols": ecols, "rows": erows, "tileWidth": sub.shape[2],
                      "tileHeight": sub.shape[1], "tileStride": sub.shape[1], "cellStride": EXACT_STRIDE,
                      "resDeg": 0.25 * EXACT_STRIDE, "vars": evars,
                      "note": "Exact quantised values every 3rd hour at every other cell of the field grid "
                              "(same NW corner); for numeric readouts."}
    # 3. tyf: the lossless spike format
    if "tyf" in formats:
        q = np.stack([codes[e.name] for e in ENC], axis=1)
        header = {
            "format": "TYF1", "version": 1, "sid": sid, "name": storm.get("name"), "season": storm.get("season"),
            "frames": T, "nx": era5.N, "ny": era5.N, "res_deg": 0.25, "nodata": NODATA,
            "layout": "uint8[frames][vars][ny][nx], row 0 north, col 0 west", "vars": [var_meta(e) for e in ENC],
            "time": unix, "nw_lat": [round(float(x), 2) for x in nw_lat],
            "nw_lon": [round(float(lon180(x)), 2) for x in nw_lon],
            "source": "ERA5 hourly single levels, 0.25 deg (NSF NCAR ds633.0 / ARCO-ERA5)", "served_by": served,
            "credit": credit, "licence": "CC BY 4.0",
        }
        blob, hlen = tyf_bytes(q, header)
        if len(blob) < MAX_FILE_BYTES:
            files["tyf"] = dict(_named(out, blob, "tyf"), headerBytes=hlen, frameBytes=len(ENC) * era5.N * era5.N)
        else:
            log.warning("%s: .tyf would be %d bytes (> 25 MiB); published as WebP only", sid, len(blob))
    meta = {
        "sid": sid, "frames": T, "start": iso(hours[0]), "end": iso(hours[-1]), "nx": era5.N, "ny": era5.N,
        "resDeg": 0.25, "nodata": NODATA, "time": unix, "nwLat": [round(float(x), 2) for x in nw_lat],
        "nwLon": [round(float(lon180(x)), 2) for x in nw_lon], "files": files, "servedBy": served,
        "credit": credit, "quantisation": qerr, "series": check.pop("series", None), "era5VsBestTrack": check,
    }
    if hourly is not None:
        meta["centreOffset"] = centre_offsets_from_codes(
            codes["mslp"][idx][:, ::EXACT_STRIDE, ::EXACT_STRIDE], nw_lat, nw_lon, 0.25 * EXACT_STRIDE, hourly,
            idx.tolist())
    (out / "frames.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False))
    return meta


def quantisation_report(codes: dict[str, np.ndarray], fields: dict[str, np.ndarray]) -> dict[str, Any]:
    qerr: dict[str, Any] = {}
    for e in ENC:
        if e.kind == "angle":
            continue
        d = dequantise(codes[e.name], e) - fields[e.name]
        ok = np.isfinite(d)
        qerr[e.name] = {"maxAbs": round(float(np.abs(d[ok]).max()), 4) if ok.any() else None,
                        "clipped": int((codes[e.name] == 254).sum()), "nodata": int((codes[e.name] == NODATA).sum())}
    return qerr


def build_storm(sid: str, hourly: pd.DataFrame, storm: dict[str, Any], *, formats: tuple[str, ...] = ("webp",),
                manifest: sources.RunManifest | None = None, out_root: Path = OUT) -> dict[str, Any]:
    """Read ERA5 windows along the hourly track, write the frame files, return the frames manifest."""
    hourly = hourly.sort_values("time").reset_index(drop=True)
    hours = hourly.time.dt.tz_convert("UTC").dt.tz_localize(None).to_numpy().astype("datetime64[h]")
    w = era5.read_windows(hours, hourly.lat.to_numpy(), hourly.lon.to_numpy(), manifest=manifest)
    fields = physical_fields(w)
    codes = {e.name: quantise(fields[e.name], e) for e in ENC}
    u, v = w.fields["u10"], w.fields["v10"]
    codes["u"], codes["v"] = quantise(u, UV[0]), quantise(v, UV[1])
    served = {k: {lk: v.count(lk) for lk in dict.fromkeys(v)} for k, v in w.served.items()}
    return write_frames(sid, codes, hours, w.nw_lat, w.nw_lon, storm, served, quantisation_report(codes, fields),
                        honesty(fields, w.nw_lat, w.nw_lon, hourly), ensure_dir(out_root / sid), formats, hourly)


def repack(d: Path, hourly: pd.DataFrame, storm: dict[str, Any], formats: tuple[str, ...]) -> dict[str, Any]:
    """Rewrite a storm built in an earlier layout from its stored .tyf codes, without re-reading ERA5.
    The cross-check and series are recomputed from the stored (quantised) values."""
    meta = json.loads((d / "frames.json").read_text())
    if "files" in meta and "tyf" in meta["files"]:
        tyfs = [meta["files"]["tyf"]["file"]]
    else:
        tyfs = [seg["tyf"]["file"] for seg in meta["segments"]]
    parts, lat, lon, times = [], [], [], []
    for f in tyfs:
        h, q = parse_tyf((d / f).read_bytes())
        parts.append(q)
        lat += h.get("nw_lat") or h["nwLat"]
        lon += h.get("nw_lon") or h["nwLon"]
        times += h["time"]
    q = np.concatenate(parts)
    names = [v["name"] for v in h["vars"]]
    codes = {("tp" if n == "rain" else n): q[:, i] for i, n in enumerate(names)}
    fields = {e.name: dequantise(codes[e.name], e) for e in ENC}
    codes.update(uv_codes(fields["wind"], fields["wdir"]))
    hours = np.array(times, dtype="datetime64[s]").astype("datetime64[h]")
    nw_lat, nw_lon = np.array(lat, float), np.array(lon, float) % 360
    hourly = hourly.sort_values("time").reset_index(drop=True)
    assert len(hourly) == len(hours), f"{d.name}: track has {len(hourly)} hours, frames {len(hours)}"
    return write_frames(d.name, codes, hours, nw_lat, nw_lon, storm, meta["servedBy"], meta["quantisation"],
                        honesty(fields, nw_lat, nw_lon, hourly), d, formats, hourly)


def validate_storm(d: Path) -> None:
    """Gate before a storm's frames leave the machine: names = content, sizes, exact == tyf, lossy bounds."""
    meta = json.loads((d / "frames.json").read_text())
    files = meta["files"]
    entries = [*files["field"]["vars"], *files["exact"]["vars"]] + ([files["tyf"]] if "tyf" in files else [])
    for f in entries:
        data = (d / f["file"]).read_bytes()
        if sha256(data) != f["sha256"] or not f["file"].startswith(f["sha256"][:16]) or len(data) >= MAX_FILE_BYTES:
            raise ValueError(f"{d.name}: {f['file']} does not match its manifest entry")
    for f in files["field"]["vars"]:
        if f["maxCodeError"] > MAX_FIELD_CODE_ERROR:
            raise ValueError(f"{d.name}: lossy {f['name']} off by {f['maxCodeError']} codes")
    if "tyf" in files:
        h, q = parse_tyf((d / files["tyf"]["file"]).read_bytes())
        if h["frames"] != meta["frames"]:
            raise ValueError(f"{d.name}: tyf frame count")
        nod = float((q[:, :4] == NODATA).mean())
        if nod > 0.01:
            raise ValueError(f"{d.name}: {nod:.1%} nodata")
        ex = files["exact"]
        names = [v["name"] for v in h["vars"]]
        for f in ex["vars"]:
            back = unsheet((d / f["file"]).read_bytes(), ex["frames"], ex["tileHeight"], ex["tileWidth"], ex["cols"],
                           ex["tileStride"])
            if not np.array_equal(back, q[ex["frameIndex"], names.index(f["name"])][:, ::2, ::2]):
                raise ValueError(f"{d.name}: exact {f['name']} differs from tyf")


UPLOAD_EVERY = 40  # storms per Hugging Face commit; per-storm commits from 16 jobs hit the Hub's commit rate limit


def upload_storms(dirs: list[Path]) -> None:
    """Push several storms' content-addressed frame files to frames/<sid>/ in one commit (retrying conflicts and
    rate limits). They are invisible to the app until a summary.json of a published version references them."""
    if not dirs:
        return
    from huggingface_hub import CommitOperationAdd, HfApi

    from .config import HF_REPO
    from .publish import token

    ops = [CommitOperationAdd(path_in_repo=f"frames/{d.name}/{f.name}", path_or_fileobj=str(f))
           for d in dirs for f in sorted(d.iterdir()) if f.suffix in (".tyf", ".webp")]
    for k in range(6):
        try:
            HfApi(token=token()).create_commit(
                repo_id=HF_REPO, repo_type="dataset", operations=ops,
                commit_message=f"frames for {len(dirs)} storms ({dirs[0].name} .. {dirs[-1].name})")
            log.info("uploaded frames for %d storms (%d files)", len(dirs), len(ops))
            return
        except Exception as e:  # noqa: BLE001  concurrent batch commits can conflict: retry
            log.warning("upload of %d storms failed (%s), retry %d", len(dirs), e, k + 1)
            time.sleep(30 * (k + 1) + random.uniform(0, 30))
    raise RuntimeError(f"could not upload frames for {[d.name for d in dirs]}")


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
    ap.add_argument("--formats", default="webp", help="webp (always) plus optionally tyf")
    ap.add_argument("--skip-existing", action="store_true", help="skip storms whose frames.json exists")
    ap.add_argument("--repack", action="store_true",
                    help="rewrite already-built storms in the current file layout (no ERA5 reads)")
    ap.add_argument("--plan", type=Path, help="batch plan JSON from `python -m typhoon plan`")
    ap.add_argument("--batch", help="batch number within --plan")
    ap.add_argument("--upload", action="store_true",
                    help="after building and validating each storm, upload its frame files to frames/<sid>/ on the "
                         "Hugging Face dataset (content-addressed; referenced only once a version is published)")
    a = ap.parse_args(argv)
    sids = a.sid + (read_list(a.list) if a.list else [])
    if a.plan:
        sids += json.loads(a.plan.read_text())[str(a.batch)]
    st = catalog.load("storms").set_index("sid")
    hr = catalog.load("hourly")
    pending: list[Path] = []
    for n, sid in enumerate(sids, 1):
        if sid not in st.index:
            log.error("%s is not in the catalogue; skipped", sid)
            continue
        if a.repack:
            if (OUT / sid / "frames.json").exists():
                repack(OUT / sid, hr[hr.sid == sid], {"name": st.loc[sid, "name"], "season": int(st.loc[sid, "season"])},
                       tuple(a.formats.split(",")))
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
        if a.upload:
            pending.append(OUT / sid)
            if len(pending) >= UPLOAD_EVERY:
                upload_storms(pending)
                pending = []
        h = m["era5VsBestTrack"]
        log.info("[%d/%d] %s %s: %d frames in %.0f s, %.0f MB read, ratio %s (%s), served %s", n, len(sids), sid,
                 st.loc[sid, "name"], m["frames"], time.time() - t0,
                 sum(p.bytes for p in man.items.values()) / 1e6, h["headlineRatio"], h["headlineAgency"],
                 {k: list(v) for k, v in m["servedBy"].items()})
    upload_storms(pending)


if __name__ == "__main__":
    main()
