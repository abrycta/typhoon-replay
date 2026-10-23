"""RSMC Tokyo best-track parser (offline fixture), SID matching on synthetic frames, real-output checks."""
import sys
from datetime import UTC, datetime
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # pipeline/ is not an installed package
from typhoon.jma import OUT, fixes_frame, match, parse_bst, storms_frame

BST = """\
66666 1330  004 0036 1330 0 6               HAIYAN              20131218
13110700 002 5 108 1286  895     170 00000 0000 30090 0090
13110706 002 5 111 1267  900     165 00000 0000 30090 0090
13110712 002 5 114 1246  910     150 00000 0000 30090 0090
13110718 002 5 118 1227  920     140 00000 0000 30090 0090
66666 5915  003      5915 1 0                 VERA              19910716
59092600 002 5 300 1360  930     100
59092606 002 5 320 1366  935     100
59092612 002 5 340 1370  945      90
"""


def test_parse_bst():
    storms = parse_bst(BST.splitlines())
    assert [s.intl_id for s in storms] == ["1330", "5915"]
    h, v = storms
    assert (h.year, h.number, h.name, h.designation_ja) == (2013, 30, "HAIYAN", "台風第30号")
    assert (v.year, v.number) == (1959, 15)
    f = h.fixes[0]
    assert f.time == datetime(2013, 11, 7, 0, tzinfo=UTC)
    assert (f.grade, f.lat, f.lon, f.pres_hpa, f.wind_kt) == (5, 10.8, 128.6, 895, 170)
    assert v.fixes[2].wind_kt == 90


def _ib(rows):
    return pd.DataFrame(rows, columns=["sid", "iso_time", "lat", "lon"]).assign(
        iso_time=lambda d: pd.to_datetime(d.iso_time, utc=True))


def test_match_synthetic():
    storms = parse_bst(BST.splitlines())
    js, jf = storms_frame(storms), fixes_frame(storms)
    times = sorted(set(jf.iso_time))
    hx = jf[jf.jma_intl_id == "1330"]
    vx = jf[jf.jma_intl_id == "5915"]
    ib_fixes = pd.concat([
        _ib([("2013306N07162", t, la + 0.2, lo - 0.2) for t, la, lo in zip(hx.iso_time, hx.lat, hx.lon)]),
        _ib([("2013306N05150", t, la + 4.0, lo) for t, la, lo in zip(hx.iso_time, hx.lat, hx.lon)]),  # far away
        _ib([("1959263N11160", t, la, lo) for t, la, lo in zip(vx.iso_time, vx.lat, vx.lon)]),
    ])
    ib_storms = pd.DataFrame({"sid": ["2013306N07162", "2013306N05150", "1959263N11160"],
                              "season": [2013, 2013, 1959], "name": ["HAIYAN", "PODUL", "VERA"],
                              "track_type": ["main", "main", "main"]})
    out = match(js, jf, ib_storms, ib_fixes).set_index("jma_intl_id")
    assert out.loc["1330", "sid"] == "2013306N07162" and out.loc["1330", "match_quality"] == "good"
    assert out.loc["5915", "sid"] == "1959263N11160"
    assert out.loc["1330", "jma_number"] == 30 and out.loc["5915", "season"] == 1959
    assert len(times) == 7


@pytest.fixture(scope="module")
def jn() -> pd.DataFrame:
    if not OUT.exists():
        pytest.skip("run `python -m typhoon.jma` first")
    return pd.read_parquet(OUT)


@pytest.mark.parametrize("sid_prefix,name,season,number", [
    ("2013306N07162", "HAIYAN", 2013, 30), ("2019", "HAGIBIS", 2019, 19), ("2018", "JEBI", 2018, 21),
    ("2019", "FAXAI", 2019, 15), ("1959", "VERA", 1959, 15),
])
def test_known_numbers(jn, sid_prefix, name, season, number):
    r = jn[(jn.jma_name == name) & (jn.season == season)]
    assert len(r) == 1
    r = r.iloc[0]
    assert r.jma_number == number and r.sid.startswith(sid_prefix)
    assert r.jma_intl_id == f"{season % 100:02d}{number:02d}"
    assert r.match_quality.startswith("good")


def test_coverage_and_uniqueness(jn):
    assert {"sid", "jma_number", "jma_intl_id", "jma_name", "season", "match_quality"} <= set(jn.columns)
    assert not jn.sid.duplicated().any() and not jn.jma_intl_id.duplicated().any()
    assert len(jn) >= 1900                                    # of ~1,960 JMA storms since 1951
    assert (jn.match_quality.str.startswith("good")).mean() > 0.9
    assert jn.jma_number.between(1, 40).all()


def test_year_after_2050():
    """Two-digit years expand from the header revision date, not a fixed 1951/2051 pivot (audit L4)."""
    old = parse_bst(["66666 5101  001      5101 1 0                  OLD              19910716",
                     "51123118 002 2 100 1300 1000      35"])[0]
    new = parse_bst(["66666 5101  002      5101 1 0                  NEW              20510301",
                     "50123118 002 2 100 1300 1000      35",
                     "51010100 002 2 101 1301 1000      35"])[0]
    assert old.year == 1951 and old.fixes[0].time.year == 1951
    assert new.year == 2051 and [f.time.year for f in new.fixes] == [2050, 2051]
