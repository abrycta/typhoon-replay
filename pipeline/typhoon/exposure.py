"""Place x storm exposure ("typhoons that hit my town"), per contract radius band.

Usage: uv run python -m typhoon.exposure      -> data/processed/exposure/exposure.parquet

For every place and every catalogue storm whose hourly centre came within 500 km of the place boundary:
  closest_approach_km / _at   geodesic distance from the track (the hourly polyline) to the boundary
                              (~100 m geometry), 0.1 km, and when it happened (interpolated);
  hours_r{R}                  hourly centres within R km of the boundary;
  max_wind_kt_r{R}            the best-track sustained wind (JTWC, else JMA, else WMO; interpolated hourly)
                              while the centre was within R km; max_gust_kt_r{R} likewise (JTWC gust, sparse).
This matches catalog.place_storm_exposure (contracts/db/migrations) and the contract fixture SQL.

Distances are computed per place in an azimuthal equidistant projection centred on the place, which
keeps distances from the place within ~0.1 % out to 500 km. Hour-band membership uses the boundary
simplified to 500 m (error under 0.5 km); the closest approach uses the ~100 m boundary.
"""
from __future__ import annotations

import logging
import math

import numpy as np
import pandas as pd
import shapely
import shapely.ops
from pyproj import Transformer

from . import catalog
from . import places as places_mod
from .config import EARTH_R_KM, PROCESSED, RADII_KM, ensure_dir
from .track import lon180

log = logging.getLogger("typhoon.exposure")
OUT = PROCESSED / "exposure"
MAX_KM = 500.0


def haversine_km(lon1: np.ndarray, lat1: np.ndarray, lon2: float, lat2: float) -> np.ndarray:
    p1, p2 = np.radians(lat1), math.radians(lat2)
    dl = np.radians(lon1 - lon2)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * math.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * EARTH_R_KM * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def _opt(v: float) -> float | None:
    return None if v is None or not np.isfinite(v) else int(round(v))  # noqa: RUF046


def compute(places: pd.DataFrame, hourly: pd.DataFrame, storms: pd.DataFrame) -> pd.DataFrame:
    hourly = hourly.sort_values(["sid", "time"]).reset_index(drop=True)
    x = lon180(hourly.lon.to_numpy(float))
    y = hourly.lat.to_numpy(float)
    sid_arr = hourly.sid.to_numpy()
    t_arr = hourly.time.to_numpy()
    wind = hourly.wind_kt.to_numpy(float)
    gust = hourly.gust_kt.to_numpy(float)
    tree = shapely.STRtree(shapely.points(x, y))
    season = storms.set_index("sid").season
    rows = []
    for k, p in enumerate(places.itertuples()):
        g = shapely.from_wkb(p.geom_wkb)
        cx, cy = float(p.centroid_lon), float(p.centroid_lat)
        coords = shapely.get_coordinates(g)
        r_km = float(haversine_km(coords[:, 0], coords[:, 1], cx, cy).max())
        dlat = (MAX_KM + r_km) / 111.0 + 0.1
        dlon = dlat / max(math.cos(math.radians(min(abs(cy) + dlat, 89))), 0.05)
        idx = tree.query(shapely.box(cx - dlon, cy - dlat, cx + dlon, cy + dlat))
        if len(idx) == 0:
            continue
        idx = idx[haversine_km(x[idx], y[idx], cx, cy) <= MAX_KM + r_km + 1]
        if len(idx) == 0:
            continue
        idx.sort()
        tf = Transformer.from_crs("EPSG:4326", f"+proj=aeqd +lat_0={cy} +lon_0={cx} +datum=WGS84 +units=m",
                                  always_xy=True)
        px, py = tf.transform(x[idx], y[idx])
        fine = shapely.transform(g, lambda c, tf=tf: np.column_stack(tf.transform(c[:, 0], c[:, 1])))
        coarse = shapely.simplify(fine, 500.0, preserve_topology=True)
        d = shapely.distance(shapely.points(px, py), coarse) / 1000.0
        keep = d <= MAX_KM + 1
        if not keep.any():
            continue
        idx, px, py, d = idx[keep], px[keep], py[keep], d[keep]
        sids = sid_arr[idx]
        for sid in pd.unique(sids):
            m = np.flatnonzero(sids == sid)
            j = m[int(np.argmin(d[m]))]
            # refine: distance from the track polyline around the closest hour to the ~100 m boundary
            gi = idx[j]
            lo = gi - 1 if gi > 0 and sid_arr[gi - 1] == sid else gi
            hi = gi + 1 if gi + 1 < len(sid_arr) and sid_arr[gi + 1] == sid else gi
            sx, sy = tf.transform(x[lo:hi + 1], y[lo:hi + 1])
            line = shapely.linestrings(np.column_stack([sx, sy])) if hi > lo else shapely.points(sx[0], sy[0])
            dd = float(shapely.distance(line, fine)) / 1000.0
            if dd > MAX_KM:
                continue
            if hi > lo:
                near = shapely.ops.nearest_points(line, fine)[0]
                f = float(shapely.line_locate_point(line, near, normalized=True)) * (hi - lo)
                i0 = lo + min(int(f), hi - lo - 1)
                t0, t1 = t_arr[i0], t_arr[i0 + 1]
                at = pd.Timestamp(t0 + (t1 - t0) * (f - int(f) if int(f) < hi - lo else 1.0))
            else:
                at = pd.Timestamp(t_arr[gi])
            row = {"place_id": p.place_id, "sid": sid, "season": int(season[sid]),
                   "closest_approach_km": round(min(dd, d[m].min()), 1), "closest_approach_at": at.floor("min")}
            for r in RADII_KM:
                inr = m[d[m] <= r]
                row[f"hours_r{r}"] = len(inr)
                wv = wind[idx[inr]] if len(inr) else np.array([])
                gv = gust[idx[inr]] if len(inr) else np.array([])
                row[f"max_wind_kt_r{r}"] = _opt(np.nanmax(wv)) if len(wv) and np.isfinite(wv).any() else None
                row[f"max_gust_kt_r{r}"] = _opt(np.nanmax(gv)) if len(gv) and np.isfinite(gv).any() else None
            rows.append(row)
        if k % 500 == 0:
            log.info("exposure: %d/%d places, %d pairs", k, len(places), len(rows))
    cols = ["place_id", "sid", "season", "closest_approach_km", "closest_approach_at"] + \
        [f"max_wind_kt_r{r}" for r in RADII_KM] + [f"max_gust_kt_r{r}" for r in RADII_KM] + \
        [f"hours_r{r}" for r in RADII_KM]
    out = pd.DataFrame(rows, columns=cols)
    for c in cols[5:]:
        out[c] = out[c].astype("Int16")
    return out.sort_values(["place_id", "closest_approach_km", "sid"]).reset_index(drop=True)


def build() -> pd.DataFrame:
    ensure_dir(OUT)
    ex = compute(places_mod.load(), catalog.load("hourly"), catalog.load("storms"))
    ex.to_parquet(OUT / "exposure.parquet", index=False, compression="zstd")
    log.info("exposure: %d pairs, %d places, %d storms", len(ex), ex.place_id.nunique(), ex.sid.nunique())
    return ex


def load() -> pd.DataFrame:
    return pd.read_parquet(OUT / "exposure.parquet")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ex = build()
    print(ex.describe().T.to_string())


if __name__ == "__main__":
    main()
