"""typhoon.dbload against a throwaway PostGIS (testcontainers): stage -> validate -> swap -> dataset_version.

The Docker tests skip when Docker is unavailable. The full preview load is opt-in:
    TR_DBLOAD_PREVIEW=1 PYTHONPATH=. uv run pytest tests/test_dbload.py -k preview -s
"""
import os
import sys
import time
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
import shapely

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # pipeline/ is not an installed package
from typhoon import dbload

REPO = Path(__file__).resolve().parents[2]
MIGRATIONS = sorted((REPO / "contracts/db/migrations").glob("*.sql"))
PREVIEW_ENV = os.environ.get("TR_DBLOAD_PREVIEW", "")  # "1" = data/build/tables-preview, or a tables dir
PREVIEW = Path(PREVIEW_ENV) if PREVIEW_ENV not in ("", "1") else REPO / "data/build/tables-preview"
IMAGE = "postgis/postgis:18-3.6"  # production: Neon PostgreSQL 18 + PostGIS 3.6 + pg_trgm


# --- pure conversion (no Docker) ---------------------------------------------------------------------------


def test_lon180_rounds_and_normalises():
    got = dbload._lon180(np.array([180.0, -180.0, 190.5, 359.99999, -179.99996, 125.123456]))
    assert got.tolist() == [180.0, 180.0, -169.5, 0.0, 180.0, 125.1235]


def test_column_conversion():
    batch = pa.RecordBatch.from_pydict({
        "w": pa.array([1.0, None, float("nan")], pa.float64()),
        "lon": [190.0, None, 120.0], "lat": [10.123456, 5.0, 6.0],
        "t": pa.array([datetime(2013, 11, 8), None, None], pa.timestamp("s")),
        "arr": [["PH"], None, []],
    })
    assert dbload._column(batch, dbload.Col("w", "int")) == [1, None, None]
    assert dbload._column(batch, dbload.Col("p", "point", ("lon", "lat"))) == [
        "POINT(-170.0 10.1235)", None, "POINT(120.0 6.0)"]
    assert dbload._column(batch, dbload.Col("t", "ts"))[0] == datetime(2013, 11, 8, tzinfo=UTC)
    assert dbload._column(batch, dbload.Col("arr", "textarr", default=[])) == [["PH"], [], []]
    assert dbload._column(batch, dbload.Col("population", "int", optional=True)) == [None] * 3
    with pytest.raises(ValueError, match="non-integer"):
        dbload._column(pa.RecordBatch.from_pydict({"w": [1.5]}), dbload.Col("w", "int"))


# --- synthetic tables ---------------------------------------------------------------------------------------


T0 = datetime(2013, 11, 7, tzinfo=UTC)


def _box(x: float, y: float, d: float = 0.1) -> shapely.Geometry:
    return shapely.box(x, y, x + d, y + d)


def write_tables(out: Path, sids: list[str], *, bad_exposure_sid: bool = False) -> dict[str, int]:
    """Tables-shaped Parquet: storms 0..n with 3 fixes each; storm 0 crosses the dateline."""
    out.mkdir(parents=True, exist_ok=True)
    storms, fixes, landfalls, pagasa, exposure = [], [], [], [], []
    for i, sid in enumerate(sids):
        lons = [179.8, -179.9, -179.5] if i == 0 else [125.0 + i, 124.0 + i, 123.0 + i]
        lats = [10.0, 10.5, 11.0]
        for k, (lon, lat) in enumerate(zip(lons, lats, strict=True)):
            fixes.append({"sid": sid, "observed_at": T0 + timedelta(hours=6 * k), "lon": lon, "lat": lat,
                          "wind_kt": 100 + k if k else None, "wind_agency": "jtwc" if k else None,
                          "pressure_hpa": 950, "gust_kt": None, "jtwc_wind_kt": 100 + k if k else None,
                          "jtwc_pressure_hpa": 950, "jma_wind_kt": None, "jma_pressure_hpa": None,
                          "jma_grade": 5, "sshs_category": 3, "nature": "tropical", "dist_to_land_km": 300,
                          "speed_kt": 12, "direction_deg": 270})
        track = shapely.to_wkb(shapely.linestrings(list(zip(lons, lats, strict=True))))
        storms.append({"sid": sid, "season": 2013, "basin": "WP", "number": 89 + i, "name": f"Storm{i}",
                       "name_ibtracs": f"STORM{i}", "name_pagasa": "Yolanda" if i == 1 else None,
                       "name_ja": "台風第30号" if i == 1 else None, "jma_number": 30 if i == 1 else None,
                       "atcf_id": None, "track_type": "main", "started_at": T0, "ended_at": T0 + timedelta(hours=12),
                       "fix_count": 3, "peak_wind_kt": 102, "peak_wind_agency": "jtwc",
                       "peak_at": T0 + timedelta(hours=12), "peak_lon": lons[2], "peak_lat": 11.0,
                       "min_pressure_hpa": 950, "jtwc_max_wind_kt": 102, "jtwc_min_pressure_hpa": 950,
                       "jma_max_wind_kt": None, "jma_min_pressure_hpa": None, "wmo_max_wind_kt": None,
                       "wmo_min_pressure_hpa": None, "landfall_countries": ["PH"] if i == 1 else [],
                       "search_text": f"storm{i} | storm{i}", "track_wkb": track, "replay_available": i == 1,
                       "bbox": [0.0, 0.0, 1.0, 1.0]})  # an extra column the loader ignores
        exposure.append({"place_id": "PH-0000000001", "sid": sid, "season": 2013, "closest_approach_km": 12.3 * i,
                         "closest_approach_at": T0 + timedelta(hours=6), **{
                             f"{m}_r{r}": (90 if r >= 100 else None) for m in ("max_wind_kt", "max_gust_kt")
                             for r in dbload._RADII}, **{f"hours_r{r}": 3 for r in dbload._RADII}})
    sid1 = sids[1]
    landfalls.append({"sid": sid1, "seq": 1, "at": T0 + timedelta(hours=6), "country": "PH", "lon": 125.0,
                      "lat": 11.05, "place_id": "PH-0000000001"})
    pagasa.append({"sid": sid1, "pagasa_name": "Yolanda", "intl_name": "Storm1", "season": 2013,
                   "source_url": None})
    if bad_exposure_sid:
        exposure.append({**exposure[0], "sid": "1999001N10100"})
    places = [
        {"place_id": "PH-0000000001", "country": "PH", "kind": "city", "name": "Tacloban", "name_ja": None,
         "admin1": "Eastern Visayas", "admin1_ja": None, "admin2": "Leyte", "area_km2": 201.72,
         "centroid_lon": 125.0, "centroid_lat": 11.25,
         "geom_wkb": shapely.to_wkb(shapely.MultiPolygon([_box(124.95, 11.2)])),
         "geom_display_wkb": shapely.to_wkb(_box(124.95, 11.2)),  # Polygon: the loader makes it Multi
         "search_text": "tacloban | eastern visayas | leyte"},
        {"place_id": "JP-13101", "country": "JP", "kind": "special-ward", "name": "Chiyoda", "name_ja": "千代田区",
         "admin1": "Tokyo", "admin1_ja": "東京都", "admin2": None, "area_km2": 11.66,
         "centroid_lon": 139.7536, "centroid_lat": 35.6940,
         "geom_wkb": shapely.to_wkb(shapely.MultiPolygon([_box(139.73, 35.67, 0.05)])),
         "geom_display_wkb": shapely.to_wkb(shapely.MultiPolygon([_box(139.73, 35.67, 0.05)])),
         "search_text": "chiyoda | 千代田区 | tokyo | 東京都"},
    ]
    frames = {"storms": storms, "storm_fixes": fixes, "storm_landfalls": landfalls, "pagasa_names": pagasa,
              "places": places, "exposure": exposure}
    counts = {}
    for name, rows in frames.items():
        df = pd.DataFrame(rows)
        for c in df.columns:  # nullable ints, as typhoon.tables writes them
            if df[c].dtype == "float64" and dbload_int_col(c):
                df[c] = df[c].astype("Int32")
        pq.write_table(pa.Table.from_pandas(df, preserve_index=False), out / f"{name}.parquet")
        counts[name] = len(df)
    return counts


def dbload_int_col(c: str) -> bool:
    return any(c == col.name and col.kind == "int" for t in dbload.TABLES for col in t.cols)


# --- PostGIS container ------------------------------------------------------------------------------------


def _docker_ok() -> bool:
    try:
        import docker

        docker.from_env().ping()
        return True
    except Exception:  # noqa: BLE001  (no daemon, no socket, permission: all mean skip)
        return False


def _migrate(dsn: str) -> None:
    """Apply the `-- migrate:up` sections in order, one transaction each (like dbmate)."""
    import psycopg

    with psycopg.connect(dsn, autocommit=True) as conn:
        for path in MIGRATIONS:
            up = path.read_text().split("-- migrate:up", 1)[1].split("-- migrate:down", 1)[0]
            with conn.transaction():
                conn.execute(up)  # type: ignore[arg-type]


@pytest.fixture(scope="module")
def dsn() -> Iterator[str]:
    if not _docker_ok():
        pytest.skip("Docker is not available")
    from testcontainers.community.postgres import PostgresContainer

    pg = PostgresContainer(IMAGE, username="tr", password="tr", dbname="typhoon", driver=None)
    # amd64-only image (emulated on Apple silicon); hide the init script that pre-creates postgis/tiger/topology
    # so the first migration's CREATE EXTENSION runs on an empty database, as on Neon (see compose.yaml).
    pg.with_kwargs(platform="linux/amd64").with_tmpfs_mount("/docker-entrypoint-initdb.d")
    pg.with_env("POSTGRES_INITDB_ARGS", "--no-sync")
    with pg:  # random host port
        url = pg.get_connection_url()
        _migrate(url)
        yield url


def q(dsn: str, query: str, *args: Any) -> list[tuple[Any, ...]]:
    import psycopg

    with psycopg.connect(dsn) as conn:
        return conn.execute(query, args or None).fetchall()  # type: ignore[arg-type]


SCHEMA_SNAPSHOT = """
SELECT 'index', tablename, indexname || ': ' || indexdef FROM pg_indexes WHERE schemaname = 'catalog'
UNION ALL
SELECT 'constraint', conrelid::regclass::text, conname || ': ' || pg_get_constraintdef(c.oid)
  FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'catalog'
UNION ALL
SELECT 'column', c.relname, a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull
       || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ' comment=' || coalesce(col_description(c.oid, a.attnum), '')
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = 'catalog' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL
SELECT 'table', c.relname, coalesce(obj_description(c.oid, 'pg_class'), '')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'catalog' AND c.relkind IN ('r', 'v')
ORDER BY 1, 2, 3
"""

SIDS_A = ["2013301N10180", "2013306N07162", "2013310N10130"]
SIDS_B = ["2014001N10120", "2013306N07162"]


def _version(dsn: str) -> int | None:
    return q(dsn, "SELECT max(version) FROM catalog.dataset_version")[0][0]


def _load(dsn: str, d: Path, desc: str) -> int:
    return dbload.load(dsn, d, ibtracs_version="v04r01", source_commit="test", description=desc)


def test_load_swap_and_reload(dsn: str, tmp_path: Path):
    schema_before = q(dsn, SCHEMA_SNAPSHOT)
    v0 = _version(dsn) or 0
    counts = write_tables(tmp_path / "a", SIDS_A)
    v1 = _load(dsn, tmp_path / "a", "A")
    assert v1 == v0 + 1
    assert q(dsn, "SELECT ibtracs_version, source_commit, description FROM catalog.current_dataset_version"
                  " JOIN catalog.dataset_version USING (version)") == [("v04r01", "test", "A")]
    for t in dbload.TABLES:
        assert q(dsn, f"SELECT count(*) FROM catalog.{t.name}")[0][0] == counts[t.parquet]
    # the swapped-in tables have exactly the migrations' columns, indexes, constraints and comments
    assert q(dsn, SCHEMA_SNAPSHOT) == schema_before
    assert q(dsn, "SELECT count(*) FROM pg_namespace WHERE nspname = 'catalog_next'") == [(0,)]

    # geography values
    assert q(dsn, "SELECT round(ST_X(position::geometry)::numeric, 4)::float, ST_Y(position::geometry)"
                  " FROM catalog.storm_fix WHERE sid = %s ORDER BY observed_at", SIDS_A[0]) == [
        (179.8, 10.0), (-179.9, 10.5), (-179.5, 11.0)]
    # dateline-crossing track: geodesic length ~ 135 km, not the ~ 39,000 km of a wrap-around
    length_km = q(dsn, "SELECT ST_Length(track) / 1000 FROM catalog.storm WHERE sid = %s", SIDS_A[0])[0][0]
    assert 120 < length_km < 150
    assert q(dsn, "SELECT ST_X(peak_position::geometry), ST_Y(peak_position::geometry), landfall_countries,"
                  " replay_available, name_ja, jma_number, atcf_id FROM catalog.storm WHERE sid = %s", SIDS_A[1]) == [
        (124.0, 11.0, ["PH"], True, "台風第30号", 30, None)]
    assert q(dsn, "SELECT p.place_id FROM catalog.place p, catalog.storm_landfall l"
                  " WHERE ST_DWithin(p.centroid, l.position, 25000) ORDER BY 1") == [("PH-0000000001",)]
    assert q(dsn, "SELECT ST_GeometryType(geom_display::geometry), population, area_km2::float"
                  " FROM catalog.place WHERE place_id = 'PH-0000000001'") == [("ST_MultiPolygon", None, 201.72)]
    assert q(dsn, "SELECT place_id FROM catalog.place WHERE ST_Covers(geom, ST_Point(139.75, 35.69, 4326)::geography)"
             ) == [("JP-13101",)]
    assert q(dsn, "SELECT closest_approach_km::float, max_wind_kt_r50, max_wind_kt_r100, hours_r500"
                  " FROM catalog.place_storm_exposure WHERE sid = %s", SIDS_A[2]) == [(24.6, None, 90, 3)]
    assert q(dsn, "SELECT wind_kt, wind_agency, gust_kt FROM catalog.storm_fix WHERE sid = %s"
                  " ORDER BY observed_at LIMIT 1", SIDS_A[0]) == [(None, None, None)]

    # second load swaps cleanly; the old rows are gone
    write_tables(tmp_path / "b", SIDS_B)
    v2 = _load(dsn, tmp_path / "b", "B")
    assert v2 == v1 + 1
    assert q(dsn, "SELECT sid FROM catalog.storm ORDER BY sid") == [(s,) for s in sorted(SIDS_B)]
    assert q(dsn, "SELECT DISTINCT sid FROM catalog.place_storm_exposure ORDER BY sid") == [(s,) for s in sorted(SIDS_B)]
    assert q(dsn, SCHEMA_SNAPSHOT) == schema_before
    assert q(dsn, "SELECT holder IS NOT NULL, last_ok_at IS NOT NULL, lease_until < now() FROM ops.job_lease"
                  " WHERE job = 'catalog-load'") == [(True, True, True)]


def test_failed_validation_leaves_catalogue_untouched(dsn: str, tmp_path: Path):
    write_tables(tmp_path / "ok", SIDS_A)
    v = _load(dsn, tmp_path / "ok", "ok")
    before = q(dsn, "SELECT sid FROM catalog.storm ORDER BY sid")
    write_tables(tmp_path / "bad", SIDS_B, bad_exposure_sid=True)
    with pytest.raises(dbload.ValidationError, match=r"1 place_storm_exposure rows whose sid is not in storm"):
        _load(dsn, tmp_path / "bad", "bad")
    assert _version(dsn) == v
    assert q(dsn, "SELECT sid FROM catalog.storm ORDER BY sid") == before
    assert q(dsn, "SELECT count(*) FROM catalog.place_storm_exposure")[0][0] == len(SIDS_A)
    assert q(dsn, "SELECT count(*) FROM pg_namespace WHERE nspname = 'catalog_next'") == [(0,)]

    # a contract CHECK violation fails during COPY, with the same outcome
    write_tables(tmp_path / "check", SIDS_B)
    st = pq.read_table(tmp_path / "check/storms.parquet").to_pandas()
    st.loc[0, "basin"] = "XX"
    pq.write_table(pa.Table.from_pandas(st, preserve_index=False), tmp_path / "check/storms.parquet")
    import psycopg

    with pytest.raises(psycopg.errors.CheckViolation):
        _load(dsn, tmp_path / "check", "check")
    assert _version(dsn) == v


def test_concurrent_load_is_refused(dsn: str, tmp_path: Path):
    import psycopg

    write_tables(tmp_path / "a", SIDS_A)
    with psycopg.connect(dsn) as other:
        other.execute("SELECT 1 FROM ops.job_lease WHERE job = 'catalog-load' FOR UPDATE")
        with pytest.raises(dbload.LoadBusyError):
            _load(dsn, tmp_path / "a", "busy")


def test_size_guard_refuses_before_staging(dsn: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    write_tables(tmp_path / "a", SIDS_A)
    v = _load(dsn, tmp_path / "a", "a")
    before = q(dsn, "SELECT sid FROM catalog.storm ORDER BY sid")
    monkeypatch.setenv("TR_DB_CAP_MB", "1")  # any real database is over 85 % of 1 MB
    with pytest.raises(dbload.SizeGuardError, match="refused before staging"):
        _load(dsn, tmp_path / "a", "too big")
    assert _version(dsn) == v
    assert q(dsn, "SELECT sid FROM catalog.storm ORDER BY sid") == before
    assert q(dsn, "SELECT count(*) FROM pg_namespace WHERE nspname = 'catalog_next'") == [(0,)]
    monkeypatch.delenv("TR_DB_CAP_MB")
    sizes: dict[str, int] = {}
    dbload.load(dsn, tmp_path / "a", ibtracs_version="v04r01", source_commit="test", description="ok", sizes=sizes)
    assert sizes["cap"] == dbload.DEFAULT_CAP_MB * dbload.MB  # plain PostGIS: no neon.max_cluster_size
    assert 0 < sizes["staged"] and 0 < sizes["after"] < sizes["limit"]


def test_leftover_staging_schema_is_dropped(dsn: str, tmp_path: Path):
    import psycopg

    with psycopg.connect(dsn) as conn:
        conn.execute("CREATE SCHEMA catalog_next")
        conn.execute("CREATE TABLE catalog_next.junk AS SELECT generate_series(1, 1000) i")
    write_tables(tmp_path / "a", SIDS_A)
    v = _load(dsn, tmp_path / "a", "after leftover")
    assert _version(dsn) == v
    assert q(dsn, "SELECT count(*) FROM pg_namespace WHERE nspname = 'catalog_next'") == [(0,)]


TABLES_Q = ("SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
            " WHERE c.relkind = 'r' AND n.nspname IN ('catalog', 'catalog_next') ORDER BY 1")


def test_failure_mid_load_leaves_no_orphans(dsn: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    write_tables(tmp_path / "a", SIDS_A)
    v = _load(dsn, tmp_path / "a", "a")
    before = q(dsn, TABLES_Q)
    real_stage, calls = dbload._stage, []

    def stage_then_die(cur: Any, table: Any, path: Path) -> int:
        calls.append(table.name)
        if len(calls) == 4:  # three tables staged, the fourth half-way: the job dies
            raise RuntimeError("simulated crash mid-load")
        return real_stage(cur, table, path)

    monkeypatch.setattr(dbload, "_stage", stage_then_die)
    write_tables(tmp_path / "b", SIDS_B)
    with pytest.raises(RuntimeError, match="simulated crash"):
        _load(dsn, tmp_path / "b", "dies")
    after_failure = q(dsn, TABLES_Q)
    print(f"\ntables before: {len(before)}, after the failed load: {len(after_failure)}"
          f" (catalog_next: {sum(t[0].startswith('catalog_next.') for t in after_failure)})")
    assert after_failure == before and _version(dsn) == v
    monkeypatch.setattr(dbload, "_stage", real_stage)
    v2 = _load(dsn, tmp_path / "b", "next run")
    assert v2 == v + 1 and q(dsn, TABLES_Q) == before  # same six live tables, zero orphans
    assert not [t for t in q(dsn, TABLES_Q) if t[0].startswith("catalog_next.")]


@pytest.mark.skipif(not PREVIEW_ENV, reason="set TR_DBLOAD_PREVIEW=1 (slow: full preview)")
@pytest.mark.skipif(not PREVIEW.exists(), reason=f"{PREVIEW} not built")
def test_preview_load(dsn: str):
    t0 = time.monotonic()
    v = dbload.load(dsn, PREVIEW, ibtracs_version="v04r01", source_commit=None, description="preview")
    elapsed = time.monotonic() - t0
    rows = {t.name: q(dsn, f"SELECT count(*) FROM catalog.{t.name}")[0][0] for t in dbload.TABLES}
    print(f"\npreview load: dataset_version {v} in {elapsed:.1f} s; rows {rows}")
    for t in dbload.TABLES:
        assert rows[t.name] == pq.ParquetFile(PREVIEW / f"{t.parquet}.parquet").metadata.num_rows
    sizes = q(dsn, "SELECT c.relname, pg_size_pretty(pg_table_size(c.oid)), pg_size_pretty(pg_indexes_size(c.oid))"
                   " FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
                   " WHERE n.nspname = 'catalog' AND c.relkind = 'r' ORDER BY pg_total_relation_size(c.oid) DESC")
    print("catalog sizes (table, indexes):", sizes)
