"""Prefix-sharded place search (typhoon.place_search): folding rules and slicing."""
from __future__ import annotations

from typing import Any

from typhoon import place_search as ps

COLS = ["id", "kind", "name", "nameJa", "admin1", "admin1Ja", "admin2", "lon", "lat", "shard", "storms100"]


def doc(rows: list[list[Any]], shards: list[str] | None = None) -> dict[str, Any]:
    return {"columns": COLS, "shards": shards or ["places/a/1.json", "places/b/2.json"], "rows": rows}


def row(pid: str, name: str, name_ja: str | None = None, admin1: str = "Leyte", admin1_ja: str | None = None,
        shard: int = 0) -> list[Any]:
    return [pid, "municipality", name, name_ja, admin1, admin1_ja, None, 125.0, 11.0, shard, 3]


def test_fold_removes_accents_case_and_punctuation() -> None:
    assert ps.fold("Parañaque") == "paranaque"
    assert ps.fold("  City of SAN JOSÉ-del Monte ") == "city of san jose del monte"
    assert ps.ja_fold("ナハ") == "なは"
    assert ps.ja_fold("ＡＢＣ") == "ABC"


def test_every_name_word_and_admin_word_gets_a_slice() -> None:
    m, slices = ps.build(doc([row("PH-1", "City of Tacloban"), row("PH-2", "Palo")]))
    assert {"c", "o", "t", "p", "l"} <= set(m["keys"])
    assert [r[0] for r in slices["t"]["rows"]] == ["PH-1"]
    assert [r[0] for r in slices["l"]["rows"]] == ["PH-1", "PH-2"]   # the province matches both


def test_slices_keep_their_own_shard_paths() -> None:
    _, slices = ps.build(doc([row("PH-1", "Alpha", shard=1), row("PH-2", "Beta", shard=0)]))
    a = slices["a"]
    assert a["shards"] == ["places/b/2.json"] and a["rows"][0][COLS.index("shard")] == 0
    assert a["columns"] == COLS


def test_large_letters_split_by_two_letters(monkeypatch) -> None:
    monkeypatch.setattr(ps, "SPLIT_BYTES", 200)
    rows = [row(f"PH-{i}", n, admin1="Zed") for i, n in enumerate(["Manila", "Makati", "Mogpog", "Marikina", "M"])]
    m, slices = ps.build(doc(rows))
    assert "m" in m["split"] and "m" not in slices
    assert {r[2] for r in slices["ma"]["rows"]} == {"Manila", "Makati", "Marikina"}
    assert [r[2] for r in slices["mo"]["rows"]] == ["Mogpog"]
    assert ps.query_key("mak", m) == "ma"
    assert ps.query_key("m a", m) is None   # one-letter word on a split letter: the full index


def test_japanese_names_bucket_by_every_character() -> None:
    m, slices = ps.build(doc([row("JP-1", "Naha", "那覇市", "Okinawa", "沖縄県")]))
    for ch in "那覇沖縄":
        assert [r[0] for r in slices[ps.ja_bucket(ch)]["rows"]] == ["JP-1"]
    assert {ps.ja_bucket(c) for c in "市県"}.isdisjoint(set(m["keys"]) - {ps.ja_bucket(c) for c in "那覇沖縄"})
    assert ps.query_key("覇", m) == ps.ja_bucket("覇")


def test_query_keys_fold_like_the_index() -> None:
    m, _ = ps.build(doc([row("PH-1", "Parañaque", admin1="Metro Manila"), row("JP-1", "Naha", "ナハ", "Okinawa")]))
    assert ps.query_key("  PARA", m) == "p"
    assert ps.query_key("Ñaha", m) == "n"        # accents fold to the plain letter (Naha)
    assert ps.query_key("xyz", m) is None        # no slice: nothing starts with x
    assert ps.query_key("なは", m) == ps.ja_bucket("な")
    assert ps.query_key("ナハ", m) == ps.ja_bucket("な")   # katakana searches the hiragana bucket
    assert ps.query_key("", m) is None
