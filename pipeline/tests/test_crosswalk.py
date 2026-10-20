"""Wikipedia season-page parser (offline fixtures), crosswalk join logic, and real-output data checks."""
import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # pipeline/ is not an installed package
from typhoon.crosswalk import OUT_CSV, WIKI_CSV, StormIndex, build_crosswalk, match_one
from typhoon.wikipedia import (
    clean_wikitext,
    fold,
    parse_heading,
    parse_pagasa_list,
    parse_season,
    season_url,
)

PAGE = """{{Infobox}}
== Seasonal forecasts ==
=== Tropical Storm Risk Consortium ===
Forecast prose.
== Systems ==
===Tropical Depression 03W===
===CMA Tropical Depression 1===
===Typhoon Olive===
===Typhoon Polly (Auring)===
===Tropical Storm Rose (Bebeng)===
===Tropical Depression Gening===
===Typhoon Gloria (Oniang)<span class="anchor" id="Typhoon Gloria (1963)"></span>===
=== Tropical Storm Kujira (Luis{{endash}}Maymay) ===
=== Tropical Depression 30W (Wilma)===
=== Typhoon Son-Tinh ===
=== Typhoon Krovanh (Niña) ===
=== Other systems ===
*PAGASA tracked a tropical cyclone, naming it ''Asiang''.
== Storm names ==
=== Philippines ===
{| class="wikitable" align=right
|-
| scope="col" width="20%" | Asiang || [[Typhoon Polly|Auring]] || Bebeng || Gening || Oniang
|-
| Luis || Maymay || Wilma || Niña || {{tcname unused|Olive}}
|}
Prose mentioning Rose.
== References ==
"""


def test_clean_wikitext():
    assert clean_wikitext("Typhoon Gloria (Oniang)<span class=\"anchor\" id=\"x\"></span>") == "Typhoon Gloria (Oniang)"
    assert clean_wikitext("Kujira (Luis{{endash}}Maymay)<ref>x</ref>") == "Kujira (Luis–Maymay)"
    assert clean_wikitext("[[Typhoon Joe|Nitang]]") == "Nitang"
    assert fold("Niña") == "NINA" and fold("Son-Tinh") == "SONTINH"


def test_pagasa_list():
    pl = parse_pagasa_list(PAGE)
    assert pl is not None
    assert set(pl.used) == {fold(n) for n in ["Asiang", "Auring", "Bebeng", "Gening", "Oniang", "Luis", "Maymay",
                                                "Wilma", "Niña"]}
    assert set(pl.unused) == {"OLIVE"}


def test_parse_season():
    rows = parse_season(PAGE, 1963)
    got = [(r.intl_name, r.pagasa_name, r.category, r.designation) for r in rows]
    assert got == [
        (None, None, "Tropical Depression", "03W"),
        (None, None, "CMA Tropical Depression", "1"),
        ("Olive", None, "Typhoon", None),
        ("Polly", "Auring", "Typhoon", None),
        ("Rose", "Bebeng", "Tropical Storm", None),
        (None, "Gening", "Tropical Depression", None),       # PAGASA-only: single name on the PAGASA table
        ("Gloria", "Oniang", "Typhoon", None),
        ("Kujira", "Luis", "Tropical Storm", None),          # two PAGASA names, one system
        ("Kujira", "Maymay", "Tropical Storm", None),
        (None, "Wilma", "Tropical Depression", "30W"),
        ("Son-Tinh", None, "Typhoon", None),
        ("Krovanh", "Niña", "Typhoon", None),
    ]
    assert "Risk Consortium" not in {r.heading for r in rows}
    assert season_url(1963) == "https://en.wikipedia.org/wiki/1963_Pacific_typhoon_season"


def test_parse_heading_variants():
    assert parse_heading("Severe Tropical Storm Faye-Gloria (Krising-Dadang)", 1971)[1].pagasa_name == "Dadang"
    assert parse_heading("Tropical Depression 32W/33W (Sendang)", 1995)[0].designation == "32W/33W"
    assert parse_heading("Tropical Depression 17W (Storm No. 5)", 2000)[0].pagasa_name is None
    assert parse_heading("JMA Tropical Storm Twenty-nine", 2000)[0].designation == "Twenty-nine"
    assert parse_heading("Late September depression", 2000) == []


# ----------------------------------------------------------------------------- join on synthetic frames

def _storms() -> pd.DataFrame:
    rows = [
        # sid, season, name, track_type, atcf, entered_par, landfall_ph, tokyo
        ("2013306N07162", 2013, "HAIYAN", "main", "WP312013", True, True, 125.0),
        ("2007274N28173", 2007, "HAIYAN", "main", "WP202007", False, False, 40.0),
        ("2013305N07141", 2013, "UNNAMED", "main", "WP302013", True, False, None),
        ("2013300N07141", 2013, "HAIYAN", "spur-merge", "WP312013", True, False, None),
        ("1968240N15151", 1968, "WENDY", "main", None, True, True, None),
        ("1968250N24120", 1968, "WENDY", "main", None, True, False, None),
        ("1964319N08141", 1964, "LOUISE:MARGE", "main", None, True, True, None),
        ("2020299N11144", 2020, "GONI", "main", "WP222020", True, True, 115.0),
    ]
    return pd.DataFrame(rows, columns=["sid", "season", "name", "track_type", "usa_atcf_id", "entered_par",
                                       "landfall_ph", "max_tokyo_wind_kt"])


def test_match_one():
    idx = StormIndex(_storms(), pd.DataFrame({"sid": ["1968240N15151"], "jma_name": ["WENDY"]}))
    assert match_one(idx, "Haiyan", 2013, "31W").sid == "2013306N07162"          # spur excluded, season used
    assert match_one(idx, "Haiyan", 2013, "30W").status == "matched_jtwc_mismatch"
    assert match_one(idx, "Haiyan", 2007).status == "matched_not_in_par"
    assert match_one(idx, None, 2013, "30W").sid == "2013305N07141"                # PAGASA-only via JTWC number
    assert match_one(idx, None, 2013).status == "no_intl_name"
    assert match_one(idx, "Wendy", 1968).sid == "1968240N15151"                   # duplicate track: JMA wins
    assert match_one(idx, "Marge", 1964).sid == "1964319N08141"                   # IBTrACS merge name
    assert match_one(idx, "Nobody", 2013).status == "not_found"


def test_build_seed_wins():
    seed = pd.DataFrame([{"pagasa_name": "Yolanda", "intl_name": "Haiyan", "season": "2013", "jtwc_id": "31W",
                          "source_url": "u1"}])
    wiki = pd.DataFrame([
        {"season": 2013, "pagasa_name": "Yolanda", "intl_name": "Haiyan", "category": "Typhoon", "designation": None,
         "on_pagasa_list": True, "heading": "Typhoon Haiyan (Yolanda)", "source_url": season_url(2013)},
        {"season": 2013, "pagasa_name": "Ulan", "intl_name": "Haiyan", "category": "Typhoon", "designation": None,
         "on_pagasa_list": True, "heading": "Typhoon Haiyan (Ulan)", "source_url": season_url(2013)},
        {"season": 2013, "pagasa_name": "Wilma", "intl_name": None, "category": "Tropical Depression",
         "designation": "30W", "on_pagasa_list": True, "heading": "Tropical Depression 30W (Wilma)",
         "source_url": season_url(2013)},
        {"season": 2020, "pagasa_name": "Rolly", "intl_name": "Goni", "category": "Typhoon", "designation": None,
         "on_pagasa_list": True, "heading": "Typhoon Goni (Rolly)", "source_url": season_url(2020)},
    ])
    df = build_crosswalk(seed, wiki, _storms()).set_index("pagasa_name")
    assert df.loc["Yolanda", "origin"] == "seed" and df.loc["Yolanda", "wikipedia_check"] == "agrees"
    assert df.loc["Ulan", "status"] == "conflict_with_seed"
    assert df.loc["Wilma", "status"] == "matched" and df.loc["Wilma", "match_by"] == "jtwc_number"
    assert df.loc["Rolly", "sid"] == "2020299N11144" and df.loc["Rolly", "origin"] == "wikipedia"
    assert len(df) == 4


# ----------------------------------------------------------------------------- real outputs

@pytest.fixture(scope="module")
def xw() -> pd.DataFrame:
    if not OUT_CSV.exists():
        pytest.skip("run `python -m typhoon.crosswalk build` first")
    return pd.read_csv(OUT_CSV, dtype={"sid": str})


@pytest.mark.parametrize("pagasa,intl,season,sid", [
    ("Yolanda", "Haiyan", 2013, "2013306N07162"),
    ("Ondoy", "Ketsana", 2009, None), ("Odette", "Rai", 2021, None), ("Rolly", "Goni", 2020, None),
    ("Ompong", "Mangkhut", 2018, None), ("Pablo", "Bopha", 2012, None), ("Juan", "Megi", 2010, None),
    ("Sendong", "Washi", 2011, None), ("Egay", "Doksuri", 2023, None),
])
def test_known_pairs(xw, pagasa, intl, season, sid):
    r = xw[(xw.pagasa_name == pagasa) & (xw.season == season)]
    assert len(r) == 1
    r = r.iloc[0]
    assert r.status == "matched" and r.intl_name == intl
    assert r.sid.startswith(str(season))
    if sid:
        assert r.sid == sid


def test_output_contract(xw):
    for c in ["pagasa_name", "intl_name", "season", "sid", "status", "source_url", "origin"]:
        assert c in xw.columns
    m = xw[xw.status == "matched"]
    assert m.sid.notna().all() and m.source_url.str.startswith("https://en.wikipedia.org/wiki/").all()
    assert set(xw.origin) <= {"seed", "wikipedia"}
    assert len(m) >= 900                      # 1963-2026 scrape: ~1,000 matched PAGASA names
    assert not xw.duplicated(["pagasa_name", "season", "intl_name"]).any()
    # names recycle on a 4-year list, but never twice within one season among matched rows
    assert not m.duplicated(["pagasa_name", "season"]).any()


def test_seed_rows_all_present(xw):
    seed = pd.read_csv(Path(OUT_CSV).with_name("pagasa_names_seed.csv"))
    s = xw[xw.origin == "seed"]
    assert len(s) == len(seed)
    assert (s.status == "matched").sum() >= 60


def test_wikipedia_csv():
    if not WIKI_CSV.exists():
        pytest.skip("run `python -m typhoon.crosswalk scrape` first")
    w = pd.read_csv(WIKI_CSV)
    assert w.season.min() == 1963 and w.season.nunique() >= 60
    assert w.source_url.str.fullmatch(r"https://en\.wikipedia\.org/wiki/\d{4}_Pacific_typhoon_season").all()
    assert ((w.pagasa_name.notna()) & (w.intl_name.notna())).sum() >= 900
