"""Contract-shaped Parquet tables of a data version (the catalog.* schema, one file per table).

The dataset publishes these under v<N>/tables/ and typhoon.dbload COPYs them into Postgres. Column names
and units follow contracts/db/migrations/*_catalog.sql; geometry is WKB (EPSG:4326) or lon/lat columns.

  storms.parquet          catalog.storm (+ index extras: name_pagasa, bbox, duration_h, replay fields)
  storm_fixes.parquet     catalog.storm_fix (observed best-track fixes; lon/lat)
  storm_landfalls.parquet catalog.storm_landfall (lon/lat)
  pagasa_names.parquet    catalog.pagasa_name
  places.parquet          catalog.place (geom_wkb, geom_display_wkb; centroid lon/lat)
  exposure.parquet        catalog.place_storm_exposure
  hourly_tracks.parquet   hourly interpolated tracks (static replay; not in the database)
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import shapely

from . import catalog, exposure, places as places_mod
from .track import lon180

INT_COL = re.compile(r"(_kt(_r\d+)?|_hpa|^number|jma_number|jma_season|jma_grade|sshs.*|_km|_deg|_deg$)$")
TABLES = ("storms", "storm_fixes", "storm_landfalls", "pagasa_names", "places", "exposure", "hourly_tracks")


def _utc(s: pd.Series) -> pd.Series:
    return pd.to_datetime(s, utc=True).dt.floor("s")


def storms_table(replay: dict[str, dict[str, Any]]) -> pd.DataFrame:
    st = catalog.load("storms").copy()
    fx = catalog.load("fixes")
    line = {sid: shapely.to_wkb(shapely.linestrings(g[["lon", "lat"]].to_numpy())) if len(g) > 1 else None
            for sid, g in fx.sort_values("observed_at").groupby("sid")}
    st["track_wkb"] = st.sid.map(line)
    st["replay_available"] = st.sid.isin(replay)
    st["frames"] = st.sid.map(lambda s: replay.get(s, {}).get("frames")).astype("Int32")
    st["era5_ratio"] = st.sid.map(lambda s: replay.get(s, {}).get("ratio"))
    st["era5_ratio_agency"] = st.sid.map(lambda s: replay.get(s, {}).get("agency"))
    for c in ("started_at", "ended_at", "peak_at"):
        st[c] = _utc(st[c])
    return st


def places_table() -> pd.DataFrame:
    p = places_mod.load().copy()
    return p.drop(columns=["psgc_name"], errors="ignore")


def build_tables(out: Path, replay: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Write every table to `out`; returns {table: {rows, bytes}}."""
    out.mkdir(parents=True, exist_ok=True)
    fx = catalog.load("fixes")
    fx["observed_at"] = _utc(fx.observed_at)
    lf = catalog.load("landfalls")
    lf["at"] = _utc(lf["at"])
    pg = catalog.load("pagasa")[["sid", "pagasa_name", "intl_name", "season", "source_url"]]
    # PAGASA-only depressions have no international name; catalog.pagasa_name.intl_name is NOT NULL, so
    # use the catalogue's display name ('Unnamed'), as GET /v1/storms/{sid} would show it.
    names = catalog.load("storms").set_index("sid")["name"]
    pg["intl_name"] = pg.intl_name.fillna(pg.sid.map(names))
    ex = exposure.load()
    ex["closest_approach_at"] = _utc(ex.closest_approach_at)
    hr = catalog.load("hourly")
    hr["lon"] = lon180(hr.lon.to_numpy()).round(3)
    hr["lat"] = hr.lat.round(3)
    frames = {"storms": storms_table(replay), "storm_fixes": fx, "storm_landfalls": lf, "pagasa_names": pg,
              "places": places_table(), "exposure": ex, "hourly_tracks": hr}
    info = {}
    for name, df in frames.items():
        for c in df.columns:  # integer-valued measurements with gaps: nullable ints, not floats
            if df[c].dtype == "float64" and INT_COL.search(c) and (df[c].dropna() % 1 == 0).all():
                df[c] = df[c].astype("Int32")
        path = out / f"{name}.parquet"
        table = pa.Table.from_pandas(df, preserve_index=False)
        pq.write_table(table, path, compression="zstd", row_group_size=200_000)
        info[name] = {"rows": int(len(df)), "bytes": path.stat().st_size}
    return info
