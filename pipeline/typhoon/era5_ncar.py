"""Compare route: NSF NCAR ERA5 on AWS (s3://nsf-ncar-era5, anonymous).

Monthly NetCDF-4 per variable, HDF5 chunks (27 h, 139 lat, 279 lon), gzip-1. Unlike ARCO-ERA5
(one global hour per chunk) the chunks are spatially tiled, so a storm-following window touches
few chunks. This computes the exact compressed bytes needed for the storm's +-10 deg windows
(from HDF5 chunk metadata) and times reading those chunks.

Usage: uv run python -m typhoon.era5_ncar --sid 2013306N07162 --var 128_165_10u:VAR_10U
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import h5py
import pandas as pd
import s3fs

ROOT = Path(__file__).resolve().parents[2]
HALF = 40


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", default="2013306N07162")
    ap.add_argument("--var", default="128_165_10u:VAR_10U", help="file code:dataset name (an.sfc)")
    a = ap.parse_args(argv)
    code, dsname = a.var.split(":")
    tr = pd.read_parquet(ROOT / f"data/processed/era5/{a.sid}_track_hourly.parquet")
    fs = s3fs.S3FileSystem(anon=True)
    total, nchunks, t0 = 0, 0, time.perf_counter()
    for month, g in tr.groupby(tr.time.dt.strftime("%Y%m")):
        start = pd.Timestamp(month + "01")
        end = start + pd.offsets.MonthEnd(0) + pd.Timedelta("23h")
        p = (f"nsf-ncar-era5/e5.oper.an.sfc/{month}/e5.oper.an.sfc.{code}.ll025sc."
             f"{start:%Y%m%d}00_{end:%Y%m%d%H}.nc")
        v = h5py.File(fs.open(p, block_size=2**20, cache_type="none"), "r")[dsname]
        C = v.chunks
        need = set()
        for t, la, lo in zip(g.time, g.lat, g.lon):
            ti = int((t - start) / pd.Timedelta("1h"))
            ci, cj = round((90 - la) / 0.25), round((lo % 360) / 0.25)
            for r in range(max(ci - HALF, 0) // C[1], min(ci + HALF, 720) // C[1] + 1):
                for c in range((cj - HALF) // C[2], (cj + HALF) // C[2] + 1):
                    need.add((ti // C[0], r, c % (1440 // C[2] + 1)))
        for a_, b, c in sorted(need):
            info = v.id.get_chunk_info_by_coord((a_ * C[0], b * C[1], c * C[2]))
            total += info.size
            v[a_ * C[0]:(a_ + 1) * C[0], b * C[1]:(b + 1) * C[1], c * C[2]:(c + 1) * C[2]]
        nchunks += len(need)
    wall = time.perf_counter() - t0
    log = {"sid": a.sid, "var": a.var, "frames": len(tr), "chunks": nchunks, "chunk_bytes": total,
           "wall_s_sequential": round(wall, 1), "chunk_shape": list(C)}
    d = ROOT / "data/processed/era5"
    (d / f"{a.sid}_ncar_{code}_log.json").write_text(json.dumps(log, indent=2))
    print(json.dumps(log, indent=2))


if __name__ == "__main__":
    main()
