"""Data-quality gates over data/processed (places, catalogue, exposure, frames). Skipped when absent.

CI runs them after `python -m typhoon prepare` and before a data version can be published.
"""
from __future__ import annotations

import itertools
import json

import pandas as pd
import pytest
import shapely

from typhoon.config import PROCESSED, RADII_KM

pytestmark = pytest.mark.data


def need(rel: str) -> pd.DataFrame:
    p = PROCESSED / rel
    if not p.exists():
        pytest.skip(f"{p} not built")
    return pd.read_parquet(p)


@pytest.fixture(scope="module")
def places() -> pd.DataFrame:
    return need("places/places.parquet")


@pytest.fixture(scope="module")
def storms() -> pd.DataFrame:
    return need("catalog/storms.parquet").set_index("sid")


def test_places(places: pd.DataFrame) -> None:
    n = places.country.value_counts()
    assert 1600 <= n["PH"] <= 1700 and 1700 <= n["JP"] <= 1800
    assert places.place_id.is_unique
    assert places.place_id.str.fullmatch(r"PH-\d{10}|JP-\d{5}").all()
    assert places.kind.isin(["city", "municipality", "special-ward", "ward", "town", "village"]).all()
    assert (places.area_km2 > 0).all() and places.admin1.notna().all()
    assert (places[places.country == "JP"].name_ja.notna()).all()
    disp = shapely.from_wkb(places.geom_display_wkb.to_numpy())
    assert int(shapely.get_num_coordinates(disp).max()) <= 1500
    geom = shapely.from_wkb(places.geom_wkb.to_numpy())
    pts = shapely.points(places.centroid_lon, places.centroid_lat)
    assert shapely.contains(geom, pts).mean() > 0.99
    known = places.set_index("place_id")
    assert known.loc["PH-0831600000", "name"] == "Tacloban City"
    assert known.loc["JP-27100", "name_ja"] == "大阪市" and known.loc["JP-13101", "kind"] == "special-ward"


def test_catalogue(storms: pd.DataFrame) -> None:
    assert 1800 <= len(storms) <= 2600
    assert (storms.season >= 1940).all() and not storms.track_type.str.contains("spur").any()
    assert (storms.entered_par | storms.landfall_countries.map(len).gt(0)).all()
    assert storms.peak_wind_agency.dropna().isin(["jtwc", "jma", "wmo"]).all()
    h = storms.loc["2013306N07162"]
    assert (h["name"], h.name_pagasa, h.name_ja, h.peak_wind_kt) == ("Haiyan", "Yolanda", "台風第30号", 170)
    assert list(storms.loc["2019278N16165", "landfall_countries"]) == ["JP"]
    assert storms.loc["2021346N05145", "name_pagasa"] == "Odette"


def test_landfalls() -> None:
    lf = need("catalog/landfalls.parquet")
    pl = need("places/places.parquet").set_index("place_id")
    assert lf.place_id.isin(pl.index).all() and lf.country.isin(["PH", "JP"]).all()
    rai = lf[lf.sid == "2021346N05145"].sort_values("seq").iloc[0]
    assert pl.loc[rai.place_id, "admin2"] == "Surigao del Norte"         # Siargao
    assert abs(rai["at"] - pd.Timestamp("2021-12-16T05:30Z")) < pd.Timedelta("1h")
    hag = lf[lf.sid == "2019278N16165"].iloc[0]
    assert abs(hag["at"] - pd.Timestamp("2019-10-12T09:00Z")) < pd.Timedelta("1h")


def test_exposure() -> None:
    ex = need("exposure/exposure.parquet")
    assert ex.closest_approach_km.between(0, 500).all()
    assert not ex.duplicated(["place_id", "sid"]).any()
    for a, b in itertools.pairwise(RADII_KM):
        assert (ex[f"hours_r{a}"] <= ex[f"hours_r{b}"]).all()
    tac = ex[(ex.place_id == "PH-0831600000") & (ex.sid == "2013306N07162")].iloc[0]
    assert tac.closest_approach_km < 30 and tac.max_wind_kt_r50 >= 150


def test_frames_honesty() -> None:
    p = PROCESSED / "frames/2013306N07162/frames.json"
    if not p.exists():
        pytest.skip("Haiyan frames not built")
    m = json.loads(p.read_text())
    h = m["era5VsBestTrack"]
    assert 0.25 < h["jtwc"]["ratioAtPeak"] < 0.4 and 0.35 < h["jma"]["ratioAtPeak"] < 0.5   # SPIKE.md: 0.31, 0.42
    assert all(q["nodata"] == 0 and q["clipped"] == 0 for q in m["quantisation"].values())


def test_faxai_is_a_japan_landfall_only(storms: pd.DataFrame) -> None:
    f = storms.loc["2019242N14180"]
    assert list(f.landfall_countries) == ["JP"] and not f.entered_par
