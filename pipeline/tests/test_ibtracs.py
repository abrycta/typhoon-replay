"""Data-quality tests for the IBTrACS WP Parquet (run `uv run python -m typhoon.ibtracs` first)."""
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

D = Path(__file__).resolve().parents[2] / "data/processed/ibtracs"
pytestmark = [pytest.mark.data,
              pytest.mark.skipif(not (D / "fixes.parquet").exists(), reason="run python -m typhoon ibtracs first")]


@pytest.fixture(scope="module")
def fx():
    return pd.read_parquet(D / "fixes.parquet")


@pytest.fixture(scope="module")
def st():
    return pd.read_parquet(D / "storms.parquet")


def test_row_counts(fx, st):
    # WP v04r01 as of 2026-10: ~249k fixes, ~4.25k storms. The archive only grows (about 3k fixes and 40 storms
    # a year), so the upper bounds grow with the calendar instead of failing one day (R12).
    years = max(0, date.today().year - 2026)
    assert 240_000 <= len(fx) <= 300_000 + 10_000 * years
    assert 4_200 <= len(st) <= 4_600 + 100 * years
    assert st.sid.nunique() == len(st)
    assert set(fx.sid) == set(st.sid)
    assert (st.season >= 1940).sum() >= 3_000


def test_sid_time_unique(fx):
    assert not fx.duplicated(["sid", "iso_time"]).any()


def test_sid_format(fx):
    assert fx.sid.str.fullmatch(r"\d{7}[NS]\d{5}").all()


def test_lat_lon_ranges(fx):
    # Northern-hemisphere only; extratropical tails reach ~70N and stray into the NI/EP basins (56-267E).
    assert fx.lat.between(0, 75).all()
    assert fx.lon.between(40, 290).all()  # 0..360 convention (dateline crossers stay continuous)
    core = fx.lat.between(0, 50) & fx.lon.between(95, 185)
    assert core.mean() > 0.97
    assert fx.lat.notna().all() and fx.lon.notna().all()


def test_monotonic_time_per_storm(fx):
    assert fx.groupby("sid").iso_time.apply(lambda t: t.is_monotonic_increasing).all()
    gap = fx.groupby("sid").iso_time.diff().dt.total_seconds().dropna() / 3600
    assert (gap > 0).all()
    assert (gap <= 3).mean() > 0.99  # IBTrACS is 3-hourly (with extra landfall fixes)


def test_wind_units_knots(fx):
    # Knots: plausible range 0..200 kt. If this were m/s or km/h the maxima would be ~90 or ~370.
    for c in ["usa_wind_kt", "tokyo_wind_kt", "wmo_wind_kt"]:
        s = fx[c].dropna()
        assert s.between(0, 200).all(), c
    assert 150 <= fx.usa_wind_kt.max() <= 200
    # JMA reports 10-min winds, which are lower than JTWC 1-min winds for the same fix.
    both = fx.dropna(subset=["usa_wind_kt", "tokyo_wind_kt"])
    both = both[both.tokyo_wind_kt >= 64]
    assert (both.tokyo_wind_kt / both.usa_wind_kt).median() < 1.0


def test_pressure_units_hpa(fx):
    for c in ["usa_pres_hpa", "tokyo_pres_hpa"]:
        s = fx[c].dropna()
        assert s.between(860, 1030).all(), c


def test_haiyan(st):
    h = st.set_index("sid").loc["2013306N07162"]
    assert h["name"] == "HAIYAN" and h.season == 2013
    assert h.max_usa_wind_kt == 170 and h.min_tokyo_pres_hpa == 895
    assert h.landfall_ph and not h.landfall_jp and h.entered_par


def test_known_landfalls(st):
    s = st.set_index(["name", "season"]).sort_index()
    assert s.loc[("HAGIBIS", 2019)].landfall_jp.any()
    assert s.loc[("JEBI", 2018)].landfall_jp.any()
    assert s.loc[("RAI", 2021)].landfall_ph.any()
    assert s.loc[("GONI", 2020)].landfall_ph.any()


def test_durations(st):
    assert (st.duration_h >= 0).all()
    assert st.duration_h.max() < 24 * 60


def test_antimeridian_segments_are_not_landfalls(st):
    # Faxai 2019 starts at 179.6E and crosses to 180.1E; a -180..180 segment would span the globe and
    # "cross" the Philippines (found by the web app's fixture build).
    f = st.set_index("sid").loc["2019242N14180"]
    assert f["name"] == "FAXAI" and f.landfall_jp and not f.landfall_ph and not f.entered_par
    assert 700 <= st[st.season >= 1940].landfall_ph.sum() <= 740   # 760 before the fix
