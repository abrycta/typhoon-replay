"""Load a data version's Parquet tables (typhoon.tables) into the Postgres catalogue and publish it.

    python -m typhoon.dbload --dsn "$DATABASE_URL" --tables DIR --ibtracs-version v04r01 [--description ...]

Everything happens in ONE transaction, so a failure at any step leaves the live catalogue and
catalog.dataset_version exactly as they were:

1. Take the `catalog-load` lease row (ops.job_lease, SELECT ... FOR UPDATE NOWAIT): a second loader fails
   fast instead of interleaving. Only transaction-scoped state is used (SET LOCAL, row locks), so this works
   through Neon's pooler in transaction mode.
2. Staging: for each catalogue table, CREATE TABLE catalog_next.x (LIKE catalog.x INCLUDING ALL EXCLUDING
   INDEXES), COPY the Parquet rows in (geography values are sent as WKT points / hex WKB, which the geography
   input function parses, so no raw staging table is needed), then add the primary key and recreate every
   index with its migration name and definition (building indexes after COPY is much faster than
   maintaining them row by row), copy the table/index comments and grants, and ANALYZE.
3. Validation: row counts > 0 and equal to the Parquet counts; every fix/landfall/PAGASA/exposure sid exists
   in storm; every exposure/landfall place_id exists in place; exposure.season matches storm.season;
   closest_approach_km <= 500. The contract CHECK constraints are enforced by COPY itself. Any problem
   raises ValidationError and the transaction rolls back (nothing is swapped).
4. Swap: lock all six catalog tables, DROP the old ones, ALTER TABLE catalog_next.x SET SCHEMA catalog
   (indexes and constraints move with them, keeping their migration names), drop catalog_next and INSERT
   the catalog.dataset_version row, then COMMIT. Readers see either the whole old catalogue with the old
   datasetVersion or the whole new one with the new datasetVersion, so ETags change atomically.

Rollback: the old tables are dropped by the swap (no second copy is kept in the database). To roll back,
re-run this loader on the previous data version's tables (v<N>/tables/ in the dataset store). That
publishes a NEW dataset_version (versions only increase, so every cached ETag is invalidated again).
"""
from __future__ import annotations

import argparse
import logging
import math
import os
import sys
import time
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import psycopg
import pyarrow as pa  # type: ignore[import-untyped]
import pyarrow.parquet as pq  # type: ignore[import-untyped]
import shapely  # type: ignore[import-untyped]
from psycopg import sql

log = logging.getLogger("typhoon.dbload")

BATCH_ROWS = 50_000
LEASE_JOB = "catalog-load"


@dataclass(frozen=True)
class Col:
    """One target column: `kind` says how Parquet values become COPY values."""

    name: str
    kind: str  # text | int | num | ts | bool | textarr | point | line | multipolygon
    src: tuple[str, ...] = ()  # Parquet column(s); defaults to (name,)
    default: Any = None  # used for nulls in NOT NULL DEFAULT columns
    optional: bool = False  # Parquet column may be absent (all NULL / default)

    @property
    def sources(self) -> tuple[str, ...]:
        return self.src or (self.name,)


@dataclass(frozen=True)
class Table:
    name: str  # catalog.<name>
    parquet: str  # <tables_dir>/<parquet>.parquet
    cols: tuple[Col, ...]


def _ints(*names: str) -> tuple[Col, ...]:
    return tuple(Col(n, "int") for n in names)


STORM = Table("storm", "storms", (
    Col("sid", "text"), Col("season", "int"), Col("basin", "text"), Col("number", "int"),
    Col("name", "text"), Col("name_ibtracs", "text"), Col("name_ja", "text"), Col("atcf_id", "text"),
    Col("jma_number", "int"), Col("track_type", "text", default="main"),
    Col("started_at", "ts"), Col("ended_at", "ts"), Col("fix_count", "int"),
    Col("peak_wind_kt", "int"), Col("peak_wind_agency", "text"), Col("peak_at", "ts"),
    Col("peak_position", "point", ("peak_lon", "peak_lat")),
    *_ints("min_pressure_hpa", "jtwc_max_wind_kt", "jtwc_min_pressure_hpa", "jma_max_wind_kt",
           "jma_min_pressure_hpa", "wmo_max_wind_kt", "wmo_min_pressure_hpa"),
    Col("landfall_countries", "textarr", default=[]),
    Col("track", "line", ("track_wkb",)),
    Col("replay_available", "bool", default=False),
    Col("search_text", "text", default=""),
))
STORM_FIX = Table("storm_fix", "storm_fixes", (
    Col("sid", "text"), Col("observed_at", "ts"), Col("position", "point", ("lon", "lat")),
    Col("wind_kt", "int"), Col("wind_agency", "text"),
    *_ints("pressure_hpa", "gust_kt", "jtwc_wind_kt", "jtwc_pressure_hpa", "jma_wind_kt", "jma_pressure_hpa",
           "jma_grade", "sshs_category"),
    Col("nature", "text"), *_ints("dist_to_land_km", "speed_kt", "direction_deg"),
))
STORM_LANDFALL = Table("storm_landfall", "storm_landfalls", (
    Col("sid", "text"), Col("seq", "int"), Col("country", "text"), Col("at", "ts"),
    Col("position", "point", ("lon", "lat")), Col("place_id", "text", optional=True),
))
PAGASA_NAME = Table("pagasa_name", "pagasa_names", (
    Col("sid", "text"), Col("pagasa_name", "text"), Col("intl_name", "text"), Col("season", "int"),
    Col("source_url", "text", optional=True),
))
PLACE = Table("place", "places", (
    Col("place_id", "text"), Col("country", "text"), Col("kind", "text"), Col("name", "text"),
    Col("name_ja", "text", optional=True), Col("admin1", "text"), Col("admin1_ja", "text", optional=True),
    Col("admin2", "text", optional=True), Col("population", "int", optional=True), Col("area_km2", "num"),
    Col("centroid", "point", ("centroid_lon", "centroid_lat")),
    Col("geom", "multipolygon", ("geom_wkb",)), Col("geom_display", "multipolygon", ("geom_display_wkb",)),
    Col("search_text", "text", default=""),
))
_RADII = (50, 100, 200, 300, 500)
PLACE_STORM_EXPOSURE = Table("place_storm_exposure", "exposure", (
    Col("place_id", "text"), Col("sid", "text"), Col("season", "int"), Col("closest_approach_km", "num"),
    Col("closest_approach_at", "ts"),
    *_ints(*(f"max_wind_kt_r{r}" for r in _RADII), *(f"max_gust_kt_r{r}" for r in _RADII)),
    *(Col(f"hours_r{r}", "int", default=0) for r in _RADII),
))
TABLES: tuple[Table, ...] = (STORM, STORM_FIX, STORM_LANDFALL, PAGASA_NAME, PLACE, PLACE_STORM_EXPOSURE)

# (description, query returning (count, sample)); every count must be 0.
CHECKS: tuple[tuple[str, str], ...] = tuple(
    (desc, f"SELECT count(*), (array_agg(k ORDER BY k))[1:5] FROM ({q}) bad(k)") for desc, q in (
        ("storm_fix rows whose sid is not in storm",
         ("SELECT DISTINCT f.sid FROM catalog_next.storm_fix f"
         " WHERE NOT EXISTS (SELECT 1 FROM catalog_next.storm s WHERE s.sid = f.sid)")),
        ("storm_landfall rows whose sid is not in storm",
         ("SELECT DISTINCT l.sid FROM catalog_next.storm_landfall l"
         " WHERE NOT EXISTS (SELECT 1 FROM catalog_next.storm s WHERE s.sid = l.sid)")),
        ("storm_landfall rows whose place_id is not in place",
         ("SELECT DISTINCT l.place_id FROM catalog_next.storm_landfall l WHERE l.place_id IS NOT NULL"
         " AND NOT EXISTS (SELECT 1 FROM catalog_next.place p WHERE p.place_id = l.place_id)")),
        ("pagasa_name rows whose sid is not in storm",
         ("SELECT n.sid FROM catalog_next.pagasa_name n"
         " WHERE NOT EXISTS (SELECT 1 FROM catalog_next.storm s WHERE s.sid = n.sid)")),
        ("place_storm_exposure rows whose sid is not in storm",
         ("SELECT DISTINCT e.sid FROM catalog_next.place_storm_exposure e"
         " WHERE NOT EXISTS (SELECT 1 FROM catalog_next.storm s WHERE s.sid = e.sid)")),
        ("place_storm_exposure rows whose place_id is not in place",
         ("SELECT DISTINCT e.place_id FROM catalog_next.place_storm_exposure e"
         " WHERE NOT EXISTS (SELECT 1 FROM catalog_next.place p WHERE p.place_id = e.place_id)")),
        ("place_storm_exposure rows whose season differs from storm.season",
         ("SELECT DISTINCT e.sid FROM catalog_next.place_storm_exposure e"
         " JOIN catalog_next.storm s ON s.sid = e.sid WHERE s.season <> e.season")),
        ("place_storm_exposure rows with closest_approach_km > 500",
         "SELECT DISTINCT e.sid FROM catalog_next.place_storm_exposure e WHERE e.closest_approach_km > 500"),
    )
)


class ValidationError(RuntimeError):
    """The staged catalogue failed validation; nothing was swapped."""

    def __init__(self, problems: Sequence[str]):
        self.problems = list(problems)
        super().__init__("catalogue validation failed:\n  " + "\n  ".join(self.problems))


class LoadBusyError(RuntimeError):
    """Another catalogue load holds the catalog-load lease."""


# --- value conversion -------------------------------------------------------------------------------------


def _lon180(lon: np.ndarray) -> np.ndarray:
    """Round to 4 dp, then normalise to (-180, 180] (CONTRACT-GUIDE §3)."""
    out = (np.round(lon, 4) + 180.0) % 360.0 - 180.0
    out[out == -180.0] = 180.0
    return np.round(out, 4)


def _norm_coords(xy: np.ndarray) -> np.ndarray:
    return np.column_stack([_lon180(xy[:, 0]), np.round(xy[:, 1], 4)])


def _num(v: Any) -> Any:
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else v


def _int(v: Any, col: str) -> int | None:
    v = _num(v)
    if v is None:
        return None
    if isinstance(v, float):
        if not v.is_integer():
            raise ValueError(f"{col}: non-integer value {v!r}")
        return int(v)
    return int(v)


def _ts(v: Any) -> datetime | None:
    if v is None:
        return None
    if not isinstance(v, datetime):
        raise TypeError(f"expected a timestamp, got {v!r}")
    return v.replace(tzinfo=UTC) if v.tzinfo is None else v


def _wkb_hex(values: list[Any], multi: bool) -> list[str | None]:
    """Parquet WKB -> 2D hex WKB for the geography input function (SRID defaults to 4326)."""
    out: list[str | None] = [None] * len(values)
    idx = [i for i, v in enumerate(values) if v is not None]
    if not idx:
        return out
    geoms = shapely.from_wkb(np.array([values[i] for i in idx], dtype=object))
    if multi:
        poly = shapely.get_type_id(geoms) == 3
        if poly.any():
            geoms[poly] = [shapely.MultiPolygon([g]) for g in geoms[poly]]
    else:
        geoms = shapely.transform(geoms, _norm_coords)
    hexes = shapely.to_wkb(geoms, hex=True, output_dimension=2)
    for i, h in zip(idx, hexes, strict=True):
        out[i] = str(h)
    return out


def _column(batch: pa.RecordBatch, col: Col) -> list[Any]:
    n = batch.num_rows
    present = [s in batch.schema.names for s in col.sources]
    if not all(present):
        return [col.default] * n
    raw = [batch.column(s).to_pylist() for s in col.sources]
    k = col.kind
    if k == "point":
        lon = np.array([np.nan if v is None else v for v in raw[0]], dtype=float)
        lat = np.array([np.nan if v is None else v for v in raw[1]], dtype=float)
        lon, lat = _lon180(lon), np.round(lat, 4)
        return [None if math.isnan(x) or math.isnan(y) else f"POINT({x!r} {y!r})"
                for x, y in zip(lon.tolist(), lat.tolist(), strict=True)]
    vals = raw[0]
    if k in ("line", "multipolygon"):
        return _wkb_hex(vals, multi=k == "multipolygon")
    if k == "int":
        out: list[Any] = [_int(v, col.name) for v in vals]
    elif k == "num":
        out = [_num(v) for v in vals]
    elif k == "ts":
        out = [_ts(v) for v in vals]
    elif k == "textarr":
        out = [None if v is None else [str(x) for x in v] for v in vals]
    elif k == "text":
        out = [None if v is None else str(v) for v in vals]
    elif k == "bool":
        out = [None if v is None else bool(v) for v in vals]
    else:
        raise ValueError(f"unknown column kind {k!r}")
    if col.default is not None:
        out = [col.default if v is None else v for v in out]
    return out


def _rows(path: Path, table: Table) -> Iterator[tuple[Any, ...]]:
    pf = pq.ParquetFile(path)
    names = set(pf.schema_arrow.names)
    missing = [s for c in table.cols if not c.optional for s in c.sources if s not in names]
    if missing:
        raise ValueError(f"{path.name}: missing columns {missing}")
    wanted = sorted({s for c in table.cols for s in c.sources if s in names})
    for batch in pf.iter_batches(batch_size=BATCH_ROWS, columns=wanted):
        yield from zip(*(_column(batch, c) for c in table.cols), strict=True)


# --- staging, validation, swap ----------------------------------------------------------------------------


def _q(*parts: str) -> sql.Identifier:
    return sql.Identifier(*parts)


def _stage(cur: psycopg.Cursor[Any], table: Table, path: Path) -> int:
    t = table.name
    cur.execute(sql.SQL("CREATE TABLE {} (LIKE {} INCLUDING ALL EXCLUDING INDEXES)").format(
        _q("catalog_next", t), _q("catalog", t)))
    cols = sql.SQL(", ").join(_q(c.name) for c in table.cols)
    n = 0
    with cur.copy(sql.SQL("COPY {} ({}) FROM STDIN").format(_q("catalog_next", t), cols)) as cp:
        for row in _rows(path, table):
            cp.write_row(row)
            n += 1
    _clone_schema_objects(cur, t)
    cur.execute(sql.SQL("ANALYZE {}").format(_q("catalog_next", t)))
    return n


def _clone_schema_objects(cur: psycopg.Cursor[Any], t: str) -> None:
    """Primary key / unique constraints, indexes (same names and definitions), comments, owner and grants."""
    dst = _q("catalog_next", t)
    rel = f"catalog.{t}"
    cur.execute("SELECT conname, contype, pg_get_constraintdef(oid), obj_description(oid, 'pg_constraint')"
                " FROM pg_constraint WHERE conrelid = %s::regclass AND contype IN ('p', 'u', 'x', 'f')"
                " ORDER BY conname", (rel,))
    for name, contype, definition, comment in cur.fetchall():
        if contype == "f":
            raise RuntimeError(f"{rel} has a foreign key ({name}); catalogue tables must not (see migration)")
        cur.execute(sql.SQL("ALTER TABLE {} ADD CONSTRAINT {} " + definition.replace("{", "{{").replace("}", "}}"))
                    .format(dst, _q(name)))
        if comment is not None:
            cur.execute(sql.SQL("COMMENT ON CONSTRAINT {} ON {} IS {}").format(_q(name), dst, sql.Literal(comment)))
    cur.execute("SELECT c.relname, pg_get_indexdef(i.indexrelid), obj_description(i.indexrelid, 'pg_class')"
                " FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = %s::regclass"
                " AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid"
                "                 AND k.conrelid = i.indrelid AND k.contype IN ('p', 'u', 'x'))"
                " ORDER BY c.relname", (rel,))
    for name, definition, comment in cur.fetchall():
        on = f" ON {rel} USING "
        if definition.count(on) != 1:
            raise RuntimeError(f"cannot retarget index definition: {definition}")
        cur.execute(definition.replace(on, f" ON catalog_next.{t} USING "))
        if comment is not None:
            cur.execute(sql.SQL("COMMENT ON INDEX {} IS {}").format(_q("catalog_next", name), sql.Literal(comment)))
    cur.execute("SELECT obj_description(%s::regclass, 'pg_class'), pg_get_userbyid(relowner), current_user"
                " FROM pg_class WHERE oid = %s::regclass", (rel, rel))
    row = cur.fetchone()
    assert row is not None
    comment, owner, me = row
    if comment is not None:
        cur.execute(sql.SQL("COMMENT ON TABLE {} IS {}").format(dst, sql.Literal(comment)))
    if owner != me:
        cur.execute(sql.SQL("ALTER TABLE {} OWNER TO {}").format(dst, _q(owner)))
    cur.execute("SELECT CASE WHEN a.grantee = 0 THEN NULL ELSE pg_get_userbyid(a.grantee) END, a.privilege_type,"
                " a.is_grantable FROM pg_class c, aclexplode(c.relacl) a"
                " WHERE c.oid = %s::regclass AND a.grantee <> c.relowner", (rel,))
    for grantee, privilege, grantable in cur.fetchall():
        cur.execute(sql.SQL("GRANT {} ON {} TO {}{}").format(
            sql.SQL(privilege), dst, sql.SQL("PUBLIC") if grantee is None else _q(grantee),
            sql.SQL(" WITH GRANT OPTION" if grantable else "")))


def _validate(cur: psycopg.Cursor[Any], expected: dict[str, int]) -> None:
    problems = []
    for t, n in expected.items():
        cur.execute(sql.SQL("SELECT count(*) FROM {}").format(_q("catalog_next", t)))
        row = cur.fetchone()
        got = row[0] if row else -1
        if n <= 0 or got != n:
            problems.append(f"{t}: {got} rows loaded, {n} rows in Parquet (must be equal and > 0)")
    for desc, query in CHECKS:
        cur.execute(query)
        row = cur.fetchone()
        if row and row[0]:
            problems.append(f"{row[0]} {desc} (e.g. {', '.join(map(str, row[1]))})")
    if problems:
        raise ValidationError(problems)


def _swap(cur: psycopg.Cursor[Any]) -> None:
    cur.execute("SET LOCAL lock_timeout = '60s'")
    live = sql.SQL(", ").join(_q("catalog", t.name) for t in TABLES)
    cur.execute(sql.SQL("LOCK TABLE {} IN ACCESS EXCLUSIVE MODE").format(live))
    for t in TABLES:
        cur.execute(sql.SQL("DROP TABLE {}").format(_q("catalog", t.name)))
        cur.execute(sql.SQL("ALTER TABLE {} SET SCHEMA catalog").format(_q("catalog_next", t.name)))
    cur.execute("DROP SCHEMA catalog_next")


def load(dsn: str, tables_dir: Path, *, ibtracs_version: str, source_commit: str | None,
         description: str | None) -> int:
    """Stage, validate and swap in the catalogue from `tables_dir`; returns the new dataset_version.

    Raises ValidationError (nothing swapped, previous catalogue and dataset_version untouched) or
    LoadBusyError (another load holds the catalog-load lease).
    """
    paths = {t.name: Path(tables_dir) / f"{t.parquet}.parquet" for t in TABLES}
    if missing := [str(p) for p in paths.values() if not p.exists()]:
        raise FileNotFoundError(f"missing tables: {missing}")
    expected = {t: pq.ParquetFile(p).metadata.num_rows for t, p in paths.items()}
    holder = f"typhoon.dbload@{os.uname().nodename}:{os.getpid()}"
    t0 = time.monotonic()
    # prepare_threshold=None: no server-side prepared statements (transaction-mode pooler)
    with psycopg.connect(dsn, autocommit=True, prepare_threshold=None) as conn, conn.cursor() as cur, conn.transaction():
        cur.execute("SET LOCAL statement_timeout = 0")
        cur.execute("SET LOCAL TimeZone = 'UTC'")
        cur.execute("SET LOCAL search_path = public")  # schema-qualified catalog names in pg_get_indexdef
        try:
            cur.execute("SELECT lease_until > now() FROM ops.job_lease WHERE job = %s FOR UPDATE NOWAIT",
                        (LEASE_JOB,))
        except psycopg.errors.LockNotAvailable as e:
            raise LoadBusyError("another catalogue load is running") from e
        lease = cur.fetchone()
        if lease is None:
            raise RuntimeError(f"ops.job_lease has no {LEASE_JOB!r} row (migrations not applied?)")
        if lease[0]:
            raise LoadBusyError(f"the {LEASE_JOB} lease is held until a later time")
        cur.execute("DROP SCHEMA IF EXISTS catalog_next CASCADE")
        cur.execute("CREATE SCHEMA catalog_next")
        for t in TABLES:
            ts = time.monotonic()
            n = _stage(cur, t, paths[t.name])
            log.info("staged %-22s %9d rows in %6.1f s", t.name, n, time.monotonic() - ts)
        ts = time.monotonic()
        _validate(cur, expected)
        log.info("validated in %.1f s", time.monotonic() - ts)
        _swap(cur)
        cur.execute("INSERT INTO catalog.dataset_version (ibtracs_version, source_commit, description)"
                    " VALUES (%s, %s, %s) RETURNING version", (ibtracs_version, source_commit, description))
        row = cur.fetchone()
        assert row is not None
        version = int(row[0])
        cur.execute("UPDATE ops.job_lease SET holder = %s, last_ok_at = now() WHERE job = %s",
                    (holder, LEASE_JOB))
    log.info("published dataset_version %d in %.1f s", version, time.monotonic() - t0)
    return version


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m typhoon.dbload", description=__doc__.split("\n")[0])
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"), help="default: $DATABASE_URL")
    ap.add_argument("--tables", type=Path, required=True, help="directory of typhoon.tables Parquet files")
    ap.add_argument("--ibtracs-version", required=True, help="e.g. v04r01")
    ap.add_argument("--source-commit", help="pipeline commit that built the tables")
    ap.add_argument("--description")
    a = ap.parse_args(argv)
    if not a.dsn:
        ap.error("--dsn or DATABASE_URL is required")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    try:
        version = load(a.dsn, a.tables, ibtracs_version=a.ibtracs_version, source_commit=a.source_commit,
                       description=a.description)
    except (ValidationError, LoadBusyError) as e:
        print(e, file=sys.stderr)
        return 1
    print(version)
    return 0


if __name__ == "__main__":
    sys.exit(main())
