"""Hero-storm spike: storm-centred ERA5 frames from ARCO-ERA5 (anonymous GCS).

Store: gs://gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3 (Zarr v2 format,
1940-01-01 -> ERA5T, chunks = 1 hour x full 721x1440 globe per variable, blosc-lz4 float32).
Because chunks are whole-globe, the bytes read are independent of the window size.

Two read paths:
  --mode xarray : lazy xr.open_zarr + .isel per frame (what a naive user does)
  --mode direct : fetch the exact chunk objects concurrently with gcsfs.cat, decode with numcodecs,
                  cut the window locally (exact byte accounting, tunable concurrency)

Usage: uv run python -m typhoon.era5_arco --sid 2013306N07162 [--hours N] [--mode direct]
Writes data/processed/era5/<sid>_raw.npz (float32 windows) + a JSON log of measurements.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import gcsfs
import numcodecs
import numpy as np
import pandas as pd
import psutil

ROOT = Path(__file__).resolve().parents[2]
STORE = "gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3"
VARS = {
    "u10": "10m_u_component_of_wind",
    "v10": "10m_v_component_of_wind",
    "gust": "instantaneous_10m_wind_gust",
    "mslp": "mean_sea_level_pressure",
    "tp": "total_precipitation",
}
HALF = 40  # +-10 deg at 0.25 deg -> 81x81
NLAT, NLON = 721, 1440
T_ORIGIN = np.datetime64("1900-01-01T00")


def hourly_track(sid: str) -> pd.DataFrame:
    fx = pd.read_parquet(ROOT / "data/processed/ibtracs/fixes.parquet", filters=[("sid", "==", sid)])
    fx = fx.set_index(fx.iso_time.dt.tz_localize(None))
    hrs = pd.date_range(fx.index.min().ceil("h"), fx.index.max().floor("h"), freq="h")
    idx = fx.index.union(hrs)
    num = fx[["lat", "lon", "usa_wind_kt", "tokyo_wind_kt", "usa_pres_hpa", "tokyo_pres_hpa"]]
    tr = num.reindex(idx).interpolate(method="time", limit_area="inside").loc[hrs]
    tr.index.name = "time"
    return tr.reset_index()


def window_index(lat: float, lon: float):
    ci = int(round((90 - lat) / 0.25))
    cj = int(round((lon % 360) / 0.25))
    ci = min(max(ci, HALF), NLAT - 1 - HALF)
    rows = np.arange(ci - HALF, ci + HALF + 1)
    cols = np.arange(cj - HALF, cj + HALF + 1) % NLON
    return rows, cols, 90 - (ci - HALF) * 0.25, ((cj - HALF) * 0.25) % 360  # NW corner


def run_direct(tr, concurrency: int, batch_hours: int):
    fs = gcsfs.GCSFileSystem(token="anon")
    meta = json.loads(fs.cat(f"{STORE}/{VARS['u10']}/.zarray"))
    codec = numcodecs.get_codec(meta["compressor"])
    tidx = ((tr.time.values - T_ORIGIN) / np.timedelta64(1, "h")).astype(int)
    out = {k: np.empty((len(tr), 2 * HALF + 1, 2 * HALF + 1), np.float32) for k in VARS}
    nbytes, decode_s = 0, 0.0
    for b0 in range(0, len(tr), batch_hours):
        sl = range(b0, min(b0 + batch_hours, len(tr)))
        keys = [f"{STORE}/{VARS[k]}/{tidx[i]}.0.0" for i in sl for k in VARS]
        blobs = fs.cat(keys, batch_size=concurrency)
        t = time.perf_counter()
        for i in sl:
            rows, cols, *_ = window_index(tr.lat[i], tr.lon[i])
            for k in VARS:
                raw = blobs[f"{STORE}/{VARS[k]}/{tidx[i]}.0.0"]
                nbytes += len(raw)
                a = np.frombuffer(codec.decode(raw), "<f4").reshape(NLAT, NLON)
                out[k][i] = a[np.ix_(rows, cols)]
        decode_s += time.perf_counter() - t
        print(f"  {sl.stop}/{len(tr)} h, {nbytes/1e9:.2f} GB", flush=True)
    return out, nbytes, decode_s


def run_xarray(tr):
    import xarray as xr
    ds = xr.open_zarr("gs://" + STORE, chunks=None, storage_options=dict(token="anon"))
    out = {k: np.empty((len(tr), 2 * HALF + 1, 2 * HALF + 1), np.float32) for k in VARS}
    for i in range(len(tr)):
        rows, cols, *_ = window_index(tr.lat[i], tr.lon[i])
        sub = ds[list(VARS.values())].sel(time=tr.time[i]).isel(latitude=rows, longitude=cols).load()
        for k, v in VARS.items():
            out[k][i] = sub[v].values
    return out, None, None


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", default="2013306N07162")
    ap.add_argument("--hours", type=int, default=0, help="limit frames (0 = full lifetime)")
    ap.add_argument("--mode", choices=["direct", "xarray"], default="direct")
    ap.add_argument("--concurrency", type=int, default=64)
    ap.add_argument("--batch-hours", type=int, default=24)
    a = ap.parse_args(argv)
    tr = hourly_track(a.sid)
    if a.hours:
        tr = tr.iloc[: a.hours].reset_index(drop=True)
    net0 = psutil.net_io_counters().bytes_recv
    t0 = time.perf_counter()
    out, nbytes, decode_s = (run_direct(tr, a.concurrency, a.batch_hours) if a.mode == "direct"
                             else run_xarray(tr))
    wall = time.perf_counter() - t0
    net = psutil.net_io_counters().bytes_recv - net0
    corners = np.array([window_index(la, lo)[2:] for la, lo in zip(tr.lat, tr.lon)])
    d = ROOT / "data/processed/era5"
    d.mkdir(parents=True, exist_ok=True)
    tag = f"{a.sid}_{a.mode}_{len(tr)}h"
    np.savez_compressed(d / f"{tag}.npz", time=tr.time.values.astype("datetime64[s]").astype("int64"),
                        nw_lat=corners[:, 0], nw_lon=corners[:, 1], **out)
    tr.to_parquet(d / f"{a.sid}_track_hourly.parquet", index=False)
    window_cells = (2 * HALF + 1) ** 2
    log = {
        "sid": a.sid, "mode": a.mode, "frames": len(tr), "vars": list(VARS.values()),
        "wall_s": round(wall, 1), "chunk_bytes_read": nbytes, "nic_bytes_recv": net,
        "decode_cut_s": None if decode_s is None else round(decode_s, 1),
        "throughput_MBps": round(net / wall / 1e6, 1),
        "useful_fraction": window_cells / (NLAT * NLON),
        "concurrency": a.concurrency if a.mode == "direct" else "zarr default",
    }
    (d / f"{tag}_log.json").write_text(json.dumps(log, indent=2))
    print(json.dumps(log, indent=2))


if __name__ == "__main__":
    main()
