"""IBTrACS v04r01 WP ingest -> tidy Parquet (fixes + storms).

Usage: uv run python -m typhoon.ibtracs [--csv PATH] [--out DIR]

Units (as published by IBTrACS, unchanged here):
  *_wind  knots   (USA = 1-min sustained, TOKYO/WMO in WP = JMA 10-min sustained)
  *_pres  hPa (mb)
  dist2land / landfall  km
  usa_r34_* etc. nautical miles
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
import shapely
from shapely.geometry import Polygon, shape

from . import sources
from .config import PROCESSED

OUT = PROCESSED / "ibtracs"

# PAGASA Philippine Area of Responsibility (PAR) polygon, lon/lat.
PAR = Polygon([(120, 25), (135, 25), (135, 5), (115, 5), (115, 15), (120, 21), (120, 25)])
# Broad PH/JP study box used in big-data-ideas.md sizing (4-46N, 116-146E).
STUDY_BOX = shapely.box(116, 4, 146, 46)
JP_NEAR_DEG = 1.8  # ~200 km buffer around Japan land, in degrees (approximate)

KEEP = {
    "SID": "sid", "SEASON": "season", "NUMBER": "number", "BASIN": "basin",
    "SUBBASIN": "subbasin", "NAME": "name", "ISO_TIME": "iso_time", "NATURE": "nature",
    "LAT": "lat", "LON": "lon", "WMO_WIND": "wmo_wind_kt", "WMO_PRES": "wmo_pres_hpa",
    "WMO_AGENCY": "wmo_agency", "TRACK_TYPE": "track_type", "DIST2LAND": "dist2land_km",
    "LANDFALL": "landfall_km", "IFLAG": "iflag", "USA_ATCF_ID": "usa_atcf_id",
    "USA_WIND": "usa_wind_kt", "USA_PRES": "usa_pres_hpa", "USA_SSHS": "usa_sshs",
    "USA_RMW": "usa_rmw_nmi", "USA_ROCI": "usa_roci_nmi", "USA_GUST": "usa_gust_kt",
    "USA_R34_NE": "usa_r34_ne_nmi", "USA_R34_SE": "usa_r34_se_nmi",
    "USA_R34_SW": "usa_r34_sw_nmi", "USA_R34_NW": "usa_r34_nw_nmi",
    "USA_R64_NE": "usa_r64_ne_nmi", "USA_R64_SE": "usa_r64_se_nmi",
    "USA_R64_SW": "usa_r64_sw_nmi", "USA_R64_NW": "usa_r64_nw_nmi",
    "TOKYO_GRADE": "tokyo_grade", "TOKYO_WIND": "tokyo_wind_kt", "TOKYO_PRES": "tokyo_pres_hpa",
    "TOKYO_R50_LONG": "tokyo_r50_long_nmi", "TOKYO_R30_LONG": "tokyo_r30_long_nmi",
    "TOKYO_LAND": "tokyo_land", "CMA_WIND": "cma_wind_kt", "HKO_WIND": "hko_wind_kt",
    "KMA_WIND": "kma_wind_kt", "STORM_SPEED": "storm_speed_kt", "STORM_DIR": "storm_dir_deg",
}
NUMERIC = [v for k, v in KEEP.items() if v.endswith(("_kt", "_hpa", "_km", "_nmi", "_deg"))] + [
    "lat", "lon", "season", "number", "usa_sshs", "tokyo_grade", "tokyo_land"]


def load_fixes(csv: Path) -> pd.DataFrame:
    # Row 2 of the file is a units row; blanks are single spaces.
    df = pd.read_csv(csv, skiprows=[1], usecols=list(KEEP), keep_default_na=False,
                     na_values=[" ", ""], dtype=str)
    df = df.rename(columns=KEEP)
    for c in NUMERIC:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["iso_time"] = pd.to_datetime(df["iso_time"], utc=True)
    df["season"] = df["season"].astype("int16")
    df["lon"] = df["lon"].where(df["lon"] >= 0, df["lon"] + 360)  # 0..360 for the dateline-crossing WP
    df = df.sort_values(["sid", "iso_time"], kind="stable").reset_index(drop=True)
    df["is_synoptic"] = df["iso_time"].dt.hour % 3 == 0  # IBTrACS 3-hourly (interpolated) vs extra fixes
    return df


def _countries() -> dict[str, shapely.Geometry]:
    gj = json.loads(sources.ensure("naturalearth-50m-countries").read_text())
    out = {}
    for f in gj["features"]:
        a3 = f["properties"]["ADM0_A3"]
        if a3 in ("PHL", "JPN"):
            out[a3] = shape(f["geometry"])
    return out


def add_geo_flags(fx: pd.DataFrame) -> pd.DataFrame:
    c = _countries()
    lon = fx["lon"].to_numpy()
    lon180 = np.where(lon > 180, lon - 360, lon)
    pts = shapely.points(lon180, fx["lat"].to_numpy())
    fx["in_par"] = shapely.contains_xy(PAR, lon180, fx["lat"].to_numpy())
    fx["in_study_box"] = shapely.contains_xy(STUDY_BOX, lon180, fx["lat"].to_numpy())
    fx["over_ph"] = shapely.contains(c["PHL"], pts)
    fx["over_jp"] = shapely.contains(c["JPN"], pts)
    fx["near_jp"] = shapely.dwithin(c["JPN"], pts, JP_NEAR_DEG)
    # Landfall: segment from previous fix to this fix crosses into the country (catches fast crossings
    # between 3-hourly fixes, e.g. Haiyan over the Visayas).
    same = fx["sid"].eq(fx["sid"].shift())
    plon, plat = np.roll(lon180, 1), np.roll(fx["lat"].to_numpy(), 1)
    segs = shapely.linestrings(np.stack([np.stack([plon, lon180], 1),
                                         np.stack([plat, fx["lat"].to_numpy()], 1)], 2))
    for a3, col in (("PHL", "seg_hits_ph"), ("JPN", "seg_hits_jp")):
        hit = shapely.intersects(c[a3], segs) & same.to_numpy()
        fx[col] = hit | fx["over_" + a3[:2].lower()]
    return fx


def build_storms(fx: pd.DataFrame) -> pd.DataFrame:
    g = fx.groupby("sid", sort=True)
    st = g.agg(
        season=("season", "first"), name=("name", "first"), basin=("basin", "first"),
        usa_atcf_id=("usa_atcf_id", lambda s: s.dropna().iloc[0] if s.notna().any() else None),
        first_time=("iso_time", "min"), last_time=("iso_time", "max"), n_fixes=("iso_time", "size"),
        track_type=("track_type", "first"),
        max_usa_wind_kt=("usa_wind_kt", "max"), min_usa_pres_hpa=("usa_pres_hpa", "min"),
        max_usa_sshs=("usa_sshs", "max"),
        max_tokyo_wind_kt=("tokyo_wind_kt", "max"), min_tokyo_pres_hpa=("tokyo_pres_hpa", "min"),
        max_tokyo_grade=("tokyo_grade", "max"),
        max_wmo_wind_kt=("wmo_wind_kt", "max"), min_wmo_pres_hpa=("wmo_pres_hpa", "min"),
        max_cma_wind_kt=("cma_wind_kt", "max"), max_hko_wind_kt=("hko_wind_kt", "max"),
        max_kma_wind_kt=("kma_wind_kt", "max"),
        entered_par=("in_par", "any"), entered_study_box=("in_study_box", "any"),
        landfall_ph=("seg_hits_ph", "any"), landfall_jp=("seg_hits_jp", "any"),
        near_jp_200km=("near_jp", "any"),
        any_landfall=("landfall_km", lambda s: bool((s == 0).any())),
    ).reset_index()
    st["duration_h"] = (st["last_time"] - st["first_time"]).dt.total_seconds() / 3600
    # Peak-intensity time (USA, else Tokyo)
    w = fx["usa_wind_kt"].fillna(fx["tokyo_wind_kt"]).fillna(-1)
    idx = w.groupby(fx["sid"]).idxmax()
    st["peak_time"] = fx.loc[idx.values, "iso_time"].values
    st["peak_lat"] = fx.loc[idx.values, "lat"].values
    st["peak_lon"] = fx.loc[idx.values, "lon"].values
    first_ph = fx[fx["seg_hits_ph"]].groupby("sid")["iso_time"].min()
    first_jp = fx[fx["seg_hits_jp"]].groupby("sid")["iso_time"].min()
    st["first_ph_landfall_time"] = st["sid"].map(first_ph)
    st["first_jp_landfall_time"] = st["sid"].map(first_jp)
    st["ph_or_jp_affecting"] = st["entered_par"] | st["landfall_jp"] | st["near_jp_200km"]
    return st


def build(manifest: sources.RunManifest | None = None, *, refresh: bool = False,
          csv: Path | None = None, out: Path = OUT) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Fetch IBTrACS WP through archivekit (refresh=True re-downloads) and write fixes/storms Parquet."""
    if csv is None:
        csv = sources.ensure("ibtracs-wp", manifest, refresh=refresh)
    sources.ensure("naturalearth-50m-countries", manifest)
    out.mkdir(parents=True, exist_ok=True)
    fx = add_geo_flags(load_fixes(csv))
    st = build_storms(fx)
    fx.to_parquet(out / "fixes.parquet", index=False, compression="zstd")
    st.to_parquet(out / "storms.parquet", index=False, compression="zstd")
    return fx, st


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--refresh", action="store_true", help="re-download IBTrACS (it updates 3x a week)")
    a = ap.parse_args(argv)
    a.out.mkdir(parents=True, exist_ok=True)
    if a.csv is None:
        a.csv = sources.ensure("ibtracs-wp", refresh=a.refresh)
    fx = add_geo_flags(load_fixes(a.csv))
    st = build_storms(fx)
    fx.to_parquet(a.out / "fixes.parquet", index=False, compression="zstd")
    st.to_parquet(a.out / "storms.parquet", index=False, compression="zstd")
    s40 = st[st.season >= 1940]
    main_only = s40[s40.track_type == "main"]
    summary = {
        "rows": len(fx), "storms": len(st),
        "season_range": [int(st.season.min()), int(st.season.max())],
        "storms_since_1940": len(s40), "storms_since_1940_main_track": len(main_only),
        "storm_hours_since_1940": float(s40.duration_h.sum()),
        "mean_duration_h_since_1940": float(s40.duration_h.mean()),
        "since_1940_entered_study_box": int(s40.entered_study_box.sum()),
        "since_1940_entered_par": int(s40.entered_par.sum()),
        "since_1940_landfall_ph": int(s40.landfall_ph.sum()),
        "since_1940_landfall_jp": int(s40.landfall_jp.sum()),
        "since_1940_near_jp_200km": int(s40.near_jp_200km.sum()),
        "since_1940_ph_or_jp_affecting": int(s40.ph_or_jp_affecting.sum()),
        "storm_hours_since_1940_ph_or_jp_affecting": float(s40[s40.ph_or_jp_affecting].duration_h.sum()),
    }
    (a.out / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
