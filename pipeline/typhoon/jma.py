"""JMA (RSMC Tokyo) typhoon numbers for IBTrACS storms.

Parses the RSMC Tokyo best track (``bst_all.txt`` inside ``data/raw/jma/bst_all.zip``, fetched through
``typhoon.sources.ensure("jma-rsmc-besttrack")``) and joins each JMA storm to an IBTrACS SID by its
fixes: same synoptic times, positions within ``MAX_DIST_DEG``. Name agreement only breaks ties.

JMA numbers exist only for storms that reached tropical-storm strength (from 1951). The international
number ``YYNN`` gives the Japanese designation 台風第{NN}号 of year 19YY/20YY; a storm forming in late
December can carry the following year's number, so ``season`` here is the JMA numbering year, which
can differ from the IBTrACS season (``ibtracs_season``).

Format (JMA "Format of RSMC Best Track Data"):
    header  cols 1-5 '66666', 7-10 international number ID (YYNN), 13-15 number of data lines,
            17-20 tropical cyclone number ID, 22-25 international number ID (replicate),
            27 flag of last data line, 29 time difference, 31-50 storm name, 65-72 revision date
    data    cols 1-8 YYMMDDHH (UTC), 10-12 indicator '002', 14 grade, 16-18 latitude (0.1 deg N),
            20-23 longitude (0.1 deg E), 25-28 central pressure (hPa), 34-36 max sustained wind (kt)

    uv run python -m typhoon.jma         # writes data/processed/jma/jma_numbers.parquet, prints coverage
"""
from __future__ import annotations

import argparse
import io
import re
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
IBTRACS_DIR = ROOT / "data/processed/ibtracs"
OUT = ROOT / "data/processed/jma/jma_numbers.parquet"
SOURCE_ID = "jma-rsmc-besttrack"

MAX_DIST_DEG = 1.0          # a JMA fix "agrees" with an IBTrACS fix within this distance (degrees of arc)
MIN_CLOSE_FIXES = 2         # at least this many agreeing fixes for any match
GOOD_FRACTION = 0.8         # share of common fixes that agree for a "good" match
NAME_MAX_MEDIAN_DEG = 5.0   # same-name pairs qualify with this median separation (time-lagged old tracks)

OUT_COLUMNS = ["sid", "jma_number", "jma_intl_id", "jma_name", "season", "match_quality",
               "jma_designation_ja", "ibtracs_season", "ibtracs_name", "n_jma_fixes", "n_common",
               "n_close", "frac_close", "median_dist_deg"]


@dataclass(frozen=True)
class JmaFix:
    time: datetime
    grade: int
    lat: float
    lon: float
    pres_hpa: int | None
    wind_kt: int | None


@dataclass
class JmaStorm:
    intl_id: str                     # YYNN
    name: str | None
    fixes: list[JmaFix] = field(default_factory=list)

    @property
    def year(self) -> int:
        return _year(int(self.intl_id[:2]))

    @property
    def number(self) -> int:
        return int(self.intl_id[2:])

    @property
    def designation_ja(self) -> str:
        return f"台風第{self.number}号"


def _year(yy: int) -> int:
    return 1900 + yy if yy >= 51 else 2000 + yy


def _int_or_none(s: str) -> int | None:
    s = s.strip()
    return int(s) if s.isdigit() else None


def parse_bst(lines: Iterable[str]) -> list[JmaStorm]:
    """Parse bst_all.txt lines into storms (header '66666' + data lines)."""
    storms: list[JmaStorm] = []
    cur: JmaStorm | None = None
    for raw in lines:
        line = raw.rstrip("\r\n")
        if not line.strip():
            continue
        if line.startswith("66666"):
            intl = line[6:10].strip()
            if not re.fullmatch(r"\d{4}", intl):
                raise ValueError(f"bad JMA header (international number): {line!r}")
            name = line[30:50].strip() or None
            cur = JmaStorm(intl_id=intl, name=name)
            storms.append(cur)
            continue
        if cur is None:
            raise ValueError(f"JMA data line before any header: {line!r}")
        stamp = line[0:8]
        t = datetime(_year(int(stamp[0:2])), int(stamp[2:4]), int(stamp[4:6]), int(stamp[6:8]), tzinfo=UTC)
        cur.fixes.append(JmaFix(
            time=t,
            grade=int(line[13]),
            lat=int(line[15:18]) / 10.0,
            lon=int(line[19:23]) / 10.0,
            pres_hpa=_int_or_none(line[24:28]),
            wind_kt=_int_or_none(line[33:36]) if len(line) >= 36 else None,
        ))
    return storms


def read_bst(path: Path) -> list[JmaStorm]:
    """Read the zip (or a plain bst_all.txt)."""
    if path.suffix == ".zip":
        with zipfile.ZipFile(path) as z:
            text = z.read("bst_all.txt").decode("ascii")
        return parse_bst(io.StringIO(text))
    return parse_bst(path.read_text(encoding="ascii").splitlines())


def storms_frame(storms: list[JmaStorm]) -> pd.DataFrame:
    return pd.DataFrame([{"jma_intl_id": s.intl_id, "jma_number": s.number, "season": s.year,
                          "jma_name": s.name, "jma_designation_ja": s.designation_ja,
                          "n_jma_fixes": len(s.fixes)} for s in storms])


def fixes_frame(storms: list[JmaStorm]) -> pd.DataFrame:
    rows = [(s.intl_id, f.time, f.lat, f.lon) for s in storms for f in s.fixes]
    df = pd.DataFrame(rows, columns=["jma_intl_id", "iso_time", "lat", "lon"])
    df["iso_time"] = pd.to_datetime(df["iso_time"], utc=True).astype("datetime64[us, UTC]")
    return df


def _norm(s: object) -> str:
    return re.sub(r"[^A-Z]", "", s.upper()) if isinstance(s, str) else ""


def _name_agrees(jma_name: object, ib_name: object) -> bool:
    j = _norm(jma_name)
    if not j or not isinstance(ib_name, str):
        return False
    return any(_norm(part) == j for part in ib_name.split(":"))


def match(jma_storms: pd.DataFrame, jma_fixes: pd.DataFrame, ib_storms: pd.DataFrame,
          ib_fixes: pd.DataFrame) -> pd.DataFrame:
    """Join JMA storms to IBTrACS SIDs by co-located fixes; one row per JMA storm (sid None if unmatched).

    ib_storms needs sid, season, name, track_type; ib_fixes needs sid, iso_time, lat, lon (0-360).

    A candidate pair shares synoptic times. It qualifies with >= MIN_CLOSE_FIXES fixes within
    MAX_DIST_DEG, or, when the names agree, with a median separation <= NAME_MAX_MEDIAN_DEG (old
    tracks: IBTrACS sometimes lags JMA by 6 h or uses another agency's positions). Assignment is greedy
    and one-to-one: name-agreeing pairs first, then main/provisional tracks before spur tracks (a spur
    SID is used only when it is the JMA storm's own track, e.g. IVY 1952), then by agreeing fixes.
    """
    ib = ib_storms[["sid", "season", "name", "track_type"]].copy()
    ib["is_spur"] = ib["track_type"].astype(str).str.contains("spur")
    ibf = ib_fixes[ib_fixes["sid"].isin(ib["sid"])][["sid", "iso_time", "lat", "lon"]]
    pairs = jma_fixes.merge(ibf, on="iso_time", suffixes=("_j", "_i"))
    dlat = pairs["lat_j"] - pairs["lat_i"]
    dlon = ((pairs["lon_j"] - pairs["lon_i"] + 180.0) % 360.0) - 180.0
    pairs["dist"] = np.hypot(dlat, dlon * np.cos(np.radians((pairs["lat_j"] + pairs["lat_i"]) / 2.0)))
    pairs["close"] = pairs["dist"] <= MAX_DIST_DEG
    agg = (pairs.groupby(["jma_intl_id", "sid"], sort=False)
           .agg(n_common=("dist", "size"), n_close=("close", "sum"), median_dist_deg=("dist", "median"))
           .reset_index())
    agg["frac_close"] = agg["n_close"] / agg["n_common"]
    agg = agg.merge(jma_storms[["jma_intl_id", "jma_name"]], on="jma_intl_id").merge(
        ib.rename(columns={"season": "ibtracs_season", "name": "ibtracs_name"}), on="sid")
    agg["name_ok"] = [_name_agrees(j, i) for j, i in zip(agg["jma_name"], agg["ibtracs_name"], strict=True)]
    agg = agg[(agg["n_close"] >= MIN_CLOSE_FIXES)
              | (agg["name_ok"] & (agg["n_common"] >= MIN_CLOSE_FIXES)
                 & (agg["median_dist_deg"] <= NAME_MAX_MEDIAN_DEG))]
    agg = agg.sort_values(["name_ok", "is_spur", "n_close", "frac_close", "median_dist_deg"],
                          ascending=[False, True, False, False, True])
    chosen: dict[str, pd.Series] = {}
    used: set[str] = set()
    for _, r in agg.iterrows():
        if r["jma_intl_id"] in chosen or r["sid"] in used:
            continue
        chosen[r["jma_intl_id"]] = r
        used.add(r["sid"])
    out = []
    for _, s in jma_storms.iterrows():
        hit = chosen.get(s["jma_intl_id"])
        row = s.to_dict()
        if hit is None:
            row.update(sid=None, match_quality="unmatched", ibtracs_season=None, ibtracs_name=None,
                       n_common=0, n_close=0, frac_close=np.nan, median_dist_deg=np.nan)
        else:
            row.update(sid=hit["sid"], match_quality=_quality(hit), ibtracs_season=int(hit["ibtracs_season"]),
                       ibtracs_name=hit["ibtracs_name"], n_common=int(hit["n_common"]), n_close=int(hit["n_close"]),
                       frac_close=float(hit["frac_close"]), median_dist_deg=float(hit["median_dist_deg"]))
        out.append(row)
    df = pd.DataFrame(out)
    df["ibtracs_season"] = df["ibtracs_season"].astype("Int16")
    for c in ("jma_number", "season", "n_jma_fixes", "n_common", "n_close"):
        df[c] = df[c].astype("int64")
    return df[OUT_COLUMNS]


def _quality(r: pd.Series) -> str:
    """good (>= GOOD_FRACTION of common fixes within MAX_DIST_DEG) / partial (>= 0.3) / weak; suffixes:
    _name_differs (both carry names and they disagree), _spur (target is an IBTrACS spur track)."""
    f = float(r["frac_close"])
    q = "good" if f >= GOOD_FRACTION else "partial" if f >= 0.3 else "weak"
    ib_named = _norm(r["ibtracs_name"]) not in ("", "UNNAMED", "NOTNAMED")
    if not r["name_ok"] and _norm(r["jma_name"]) and ib_named:
        q += "_name_differs"
    if bool(r["is_spur"]):
        q += "_spur"
    return q


def build(out: Path = OUT, bst: Path | None = None, *, verbose: bool = True) -> pd.DataFrame:
    """Parse bst_all, match to IBTrACS, write the Parquet of matched storms; return all rows (incl. unmatched)."""
    if bst is None:
        from typhoon.sources import ensure
        bst = ensure(SOURCE_ID)
    storms = read_bst(bst)
    st = pd.read_parquet(IBTRACS_DIR / "storms.parquet", columns=["sid", "season", "name", "basin", "track_type"])
    fx = pd.read_parquet(IBTRACS_DIR / "fixes.parquet", columns=["sid", "iso_time", "lat", "lon"])
    allrows = match(storms_frame(storms), fixes_frame(storms), st, fx)
    matched = allrows[allrows["sid"].notna()].reset_index(drop=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    matched.to_parquet(out, index=False)
    if verbose:
        report(allrows, st)
        print(f"wrote {out.relative_to(ROOT)} ({len(matched)} rows)")
    return allrows


def report(allrows: pd.DataFrame, ib_storms: pd.DataFrame) -> None:
    n = len(allrows)
    m = int(allrows["sid"].notna().sum())
    print(f"JMA storms: {n}; matched to an IBTrACS SID: {m} ({m / n:.1%})")
    print(allrows["match_quality"].value_counts().to_string())
    wp = ib_storms[(ib_storms["basin"] == "WP") & (ib_storms["season"] >= 1951)
                   & ~ib_storms["track_type"].astype(str).str.contains("spur")
                   & (ib_storms["name"].astype(str) != "UNNAMED") & (ib_storms["name"].astype(str) != "NOT_NAMED")]
    got = set(allrows["sid"].dropna())
    print(f"named IBTrACS WP storms since 1951 (non-spur): {len(wp)}; with a JMA number: "
          f"{len(got & set(wp['sid']))} ({len(got & set(wp['sid'])) / max(len(wp), 1):.1%})")
    um = allrows[allrows["sid"].isna()]
    if len(um):
        print("unmatched JMA storms:", ", ".join(f"{r.jma_intl_id} {r.jma_name}" for r in um.itertuples()))


def jma_numbers(*, rebuild: bool = False) -> pd.DataFrame:
    """sid -> JMA number table (data/processed/jma/jma_numbers.parquet), built on first use."""
    if rebuild or not OUT.exists():
        build(verbose=False)
    return pd.read_parquet(OUT)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m typhoon.jma", description=__doc__.split("\n\n")[0])
    ap.parse_args(argv)
    build()


if __name__ == "__main__":
    main()
