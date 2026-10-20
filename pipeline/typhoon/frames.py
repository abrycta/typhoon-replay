"""Quantise storm-centred ERA5 windows to uint8 and pack a per-storm frame file (+ sprite sheets,
track JSON, coastline JSON for the spike viewer) and cross-check ERA5 vs IBTrACS intensity.

Usage: uv run python -m typhoon.frames --npz data/processed/era5/2013306N07162_direct_223h.npz

Frame file layout (.tyf, little-endian):
  bytes 0-3   magic b"TYF1"
  bytes 4-7   uint32 header length H (UTF-8 JSON)
  bytes 8..   JSON header, space-padded so the data starts on an 8-byte boundary
  data        uint8[frames][vars][ny][nx], row 0 = north edge, col 0 = west edge
Decoding per variable (see header.vars[*]):
  linear: value = offset + q * scale        (q == nodata -> missing)
  sqrt:   value = (q * scale) ** 2          (precipitation: more precision for light rain)
  angle:  degrees = q * 360 / 256           (direction the wind blows towards, clockwise from north)
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
import shapely
from PIL import Image
from shapely.geometry import shape

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data/processed/frames"
KT = 0.514444  # m/s per knot

ENC = [  # name, units, kind, scale, offset
    ("wind", "m/s", "linear", 0.3, 0.0),     # 0 .. 76.2
    ("gust", "m/s", "linear", 0.4, 0.0),     # 0 .. 101.6
    ("mslp", "hPa", "linear", 0.65, 870.0),  # 870 .. 1035.1
    ("tp", "mm/h", "sqrt", 0.04, 0.0),       # 0 .. 103.2
    ("wdir", "deg", "angle", 360 / 256, 0.0),
]
NODATA = 255


def quantise(x: np.ndarray, kind: str, scale: float, offset: float) -> np.ndarray:
    if kind == "angle":
        return (np.round(x / scale) % 256).astype(np.uint8)
    y = np.sqrt(np.maximum(x, 0)) if kind == "sqrt" else x - offset
    q = np.clip(np.round(y / scale), 0, 254)
    q[~np.isfinite(x)] = NODATA
    return q.astype(np.uint8)


def dequantise(q: np.ndarray, kind: str, scale: float, offset: float) -> np.ndarray:
    v = q.astype(np.float32) * scale
    return v**2 if kind == "sqrt" else v + offset


def sprite(q: np.ndarray, path: Path) -> dict:
    t, h, w = q.shape
    cols = math.ceil(math.sqrt(t))
    rows = math.ceil(t / cols)
    sheet = np.zeros((rows * h, cols * w), np.uint8)
    for i in range(t):
        r, c = divmod(i, cols)
        sheet[r * h:(r + 1) * h, c * w:(c + 1) * w] = q[i]
    im = Image.fromarray(sheet, "L")
    im.save(path.with_suffix(".png"), optimize=True)
    im.save(path.with_suffix(".webp"), lossless=True, quality=100, method=6)
    return {"cols": cols, "rows": rows, "png": path.with_suffix(".png").stat().st_size,
            "webp": path.with_suffix(".webp").stat().st_size}


def coastline(path: Path, bbox=(90, -15, 190, 65)):
    gj = json.loads((ROOT / "data/raw/naturalearth/ne_50m_coastline.geojson").read_text())
    box = shapely.box(-180, bbox[1], 180, bbox[3])
    lines = []
    for f in gj["features"]:
        g = shapely.intersection(shape(f["geometry"]), box)
        for part in getattr(g, "geoms", [g]):
            if part.is_empty or part.geom_type != "LineString":
                continue
            cs = [[round(x % 360, 2), round(y, 2)] for x, y in part.simplify(0.05).coords]
            if any(bbox[0] <= x <= bbox[2] for x, _ in cs):
                lines.append(cs)
    path.write_text(json.dumps(lines, separators=(",", ":")))


def cross_check(fields: dict, tr: pd.DataFrame, lat_nw, lon_nw, radius_deg=2.0) -> dict:
    n = fields["wind"].shape[1]
    off = (np.arange(n) - n // 2) * 0.25
    dy, dx = np.meshgrid(off, off, indexing="ij")
    rows = []
    for i in range(len(tr)):
        clat = lat_nw[i] - (n // 2) * 0.25
        clon = lon_nw[i] + (n // 2) * 0.25
        # distance of each cell from the IBTrACS centre (not the snapped grid centre)
        ddy = dy * -1 + (clat - tr.lat[i])
        ddx = (dx + (clon - tr.lon[i])) * math.cos(math.radians(tr.lat[i]))
        m = np.hypot(ddy, ddx) <= radius_deg
        rows.append({
            "time": tr.time[i], "era5_wind_max": float(np.nanmax(fields["wind"][i][m])),
            "era5_gust_max": float(np.nanmax(fields["gust"][i][m])),
            "era5_mslp_min": float(np.nanmin(fields["mslp"][i][m])),
            "usa_wind": tr.usa_wind_kt[i] * KT, "jma_wind": tr.tokyo_wind_kt[i] * KT,
            "usa_pres": tr.usa_pres_hpa[i], "jma_pres": tr.tokyo_pres_hpa[i],
        })
    df = pd.DataFrame(rows)
    pk = df.usa_wind.idxmax()
    strong = df[df.usa_wind >= 64 * KT]
    return {
        "radius_deg": radius_deg,
        "peak_time": str(df.time[pk]),
        "at_usa_peak": {
            "usa_1min_ms": round(df.usa_wind[pk], 1), "jma_10min_ms": round(df.jma_wind[pk], 1),
            "era5_wind_ms": round(df.era5_wind_max[pk], 1), "era5_gust_ms": round(df.era5_gust_max[pk], 1),
            "ratio_era5_to_usa": round(df.era5_wind_max[pk] / df.usa_wind[pk], 3),
            "ratio_era5_to_jma": round(df.era5_wind_max[pk] / df.jma_wind[pk], 3),
            "era5_mslp_min": round(df.era5_mslp_min[pk], 1), "jma_pres": df.jma_pres[pk],
        },
        "lifetime_max": {
            "usa_1min_ms": round(df.usa_wind.max(), 1), "jma_10min_ms": round(df.jma_wind.max(), 1),
            "era5_wind_ms": round(df.era5_wind_max.max(), 1), "era5_gust_ms": round(df.era5_gust_max.max(), 1),
            "era5_mslp_min": round(df.era5_mslp_min.min(), 1), "jma_pres_min": df.jma_pres.min(),
            "ratio_era5_to_usa": round(df.era5_wind_max.max() / df.usa_wind.max(), 3),
            "ratio_era5_to_jma": round(df.era5_wind_max.max() / df.jma_wind.max(), 3),
        },
        "typhoon_hours_median_ratio_to_usa": round(float((strong.era5_wind_max / strong.usa_wind).median()), 3),
        "typhoon_hours_median_ratio_to_jma": round(float((strong.era5_wind_max / strong.jma_wind).median()), 3),
        "typhoon_hours": int(len(strong)),
        "_series": df,
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--npz", type=Path, default=ROOT / "data/processed/era5/2013306N07162_direct_223h.npz")
    ap.add_argument("--sid", default="2013306N07162")
    a = ap.parse_args(argv)
    z = np.load(a.npz)
    tr = pd.read_parquet(ROOT / f"data/processed/era5/{a.sid}_track_hourly.parquet")
    st = pd.read_parquet(ROOT / "data/processed/ibtracs/storms.parquet").set_index("sid").loc[a.sid]
    fields = {
        "wind": np.hypot(z["u10"], z["v10"]),
        "gust": z["gust"],
        "mslp": z["mslp"] / 100.0,
        "tp": z["tp"] * 1000.0,
        "wdir": (np.degrees(np.arctan2(z["u10"], z["v10"])) + 360) % 360,
    }
    T, ny, nx = fields["wind"].shape
    OUT.mkdir(parents=True, exist_ok=True)
    q = np.stack([quantise(fields[n], k, s, o) for n, _, k, s, o in ENC], axis=1)  # T,V,ny,nx
    qerr = {}
    for vi, (n, _, k, s, o) in enumerate(ENC):
        if k == "angle":
            continue
        d = dequantise(q[:, vi], k, s, o) - fields[n]
        qerr[n] = {"max_abs": round(float(np.abs(d).max()), 4), "rmse": round(float(np.sqrt((d**2).mean())), 4),
                   "data_min": round(float(fields[n].min()), 2), "data_max": round(float(fields[n].max()), 2),
                   "clipped_cells": int(((q[:, vi] == 254)).sum())}
    header = {
        "format": "TYF1", "sid": a.sid, "name": st["name"], "season": int(st.season),
        "source": "ERA5 hourly via ARCO-ERA5 (gs://gcp-public-data-arco-era5), 0.25 deg",
        "credit": "Contains modified Copernicus Climate Change Service information (ERA5, CC BY 4.0)",
        "nx": nx, "ny": ny, "res_deg": 0.25, "frames": T, "nodata": NODATA,
        "layout": "uint8[frames][vars][ny][nx], row 0 north",
        "vars": [{"name": n, "units": u, "encoding": k, "scale": s, "offset": o} for n, u, k, s, o in ENC],
        "time": [int(t) for t in z["time"]],  # unix seconds UTC
        "nw_lat": [float(x) for x in z["nw_lat"]], "nw_lon": [float(x) for x in z["nw_lon"]],
    }
    hb = json.dumps(header, separators=(",", ":")).encode()
    pad = (-(8 + len(hb))) % 8
    hb += b" " * pad
    blob = b"TYF1" + len(hb).to_bytes(4, "little") + hb + q.tobytes()
    fpath = OUT / f"{a.sid}.tyf"
    fpath.write_bytes(blob)
    gz = len(gzip.compress(blob, 9))
    sprites = {n: sprite(q[:, vi], OUT / f"{a.sid}_{n}") for vi, (n, *_) in enumerate(ENC)}
    # Track for the viewer: hourly interpolated + original best-track fixes
    fx = pd.read_parquet(ROOT / "data/processed/ibtracs/fixes.parquet", filters=[("sid", "==", a.sid)])
    track = {
        "sid": a.sid, "name": st["name"], "season": int(st.season),
        "fixes": [{"t": int(r.iso_time.timestamp()), "lat": r.lat, "lon": r.lon,
                   "usa_kt": None if pd.isna(r.usa_wind_kt) else r.usa_wind_kt,
                   "jma_kt": None if pd.isna(r.tokyo_wind_kt) else r.tokyo_wind_kt,
                   "jma_hpa": None if pd.isna(r.tokyo_pres_hpa) else r.tokyo_pres_hpa}
                  for r in fx.itertuples()],
    }
    (OUT / f"{a.sid}_track.json").write_text(json.dumps(track, separators=(",", ":")))
    coastline(OUT / "coast.json")
    cc = cross_check(fields, tr, z["nw_lat"], z["nw_lon"])
    cc.pop("_series").to_csv(OUT / f"{a.sid}_crosscheck.csv", index=False)
    per_hour_raw = len(blob) / T
    per_hour_gz = gz / T
    s = json.loads((ROOT / "data/processed/ibtracs/summary.json").read_text())
    storms = pd.read_parquet(ROOT / "data/processed/ibtracs/storms.parquet")
    s40 = storms[storms.season >= 1940]
    longest = float(s40.duration_h.max()) + 1
    report = {
        "frames": T, "window": f"{ny}x{nx}", "vars": len(ENC),
        "tyf_bytes": len(blob), "tyf_gzip9_bytes": gz, "header_bytes": len(hb) + 8,
        "sprites": sprites, "quantisation_error": qerr,
        "extrapolation": {
            "bytes_per_storm_hour_raw": round(per_hour_raw), "bytes_per_storm_hour_gzip": round(per_hour_gz),
            "all_since_1940_storm_hours": s["storm_hours_since_1940"],
            "all_since_1940_raw_GB": round(per_hour_raw * s["storm_hours_since_1940"] / 1e9, 2),
            "all_since_1940_gzip_GB": round(per_hour_gz * s["storm_hours_since_1940"] / 1e9, 2),
            "ph_jp_affecting_raw_GB": round(per_hour_raw * s["storm_hours_since_1940_ph_or_jp_affecting"] / 1e9, 2),
            "longest_storm_h": longest, "longest_storm_raw_MiB": round(per_hour_raw * longest / 2**20, 2),
            "mean_storm_raw_MiB": round(per_hour_raw * (s40.duration_h.mean() + 1) / 2**20, 2),
            "files": int(len(s40)),
        },
        "cross_check": cc,
    }
    (OUT / f"{a.sid}_report.json").write_text(json.dumps(report, indent=2, default=str))
    print(json.dumps(report, indent=2, default=str))


if __name__ == "__main__":
    main()
