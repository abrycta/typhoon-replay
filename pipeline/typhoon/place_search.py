"""Prefix-sharded place search index for "typhoons that hit my town".

The web app needs at least two typed characters before it searches, so it only ever needs the places whose
name could match those first characters. The pipeline splits the compact search rows (``places/search.json``)
into small slices under ``v<N>/places/search/``:

- Latin text (romanised names, provinces, prefectures): every word of the folded name and its province
  (lower case, accents removed, punctuation as spaces) puts the place in the slice of the word's first letter;
  a letter whose slice is larger than ``SPLIT_BYTES`` is split by the first two letters instead
  ("m" -> "ma", "mo", ...).
- Japanese names: every character of the name (NFKC, katakana as hiragana) puts the place in bucket
  ``ja-<code point mod JA_BUCKETS>``, so a query matches anywhere in a Japanese name, as the full search does.

Each slice has the same columns as ``search.json`` (rows plus their own ``shards`` path list), and
``search/manifest.json`` lists the slice keys. The web app (web/src/data/places.ts) keeps the same folding
rules; ``search.json`` stays as the fallback.
"""
from __future__ import annotations

import json
import sys
import unicodedata
from pathlib import Path
from typing import Any

MANIFEST_SCHEMA = "typhoon-replay/places-search-shards@1"
SPLIT_BYTES = 24_000   # raw; a one-letter slice above this is split by two letters (about 5 kB gzipped)
JA_BUCKETS = 32


def fold(s: str) -> str:
    """Lower case, accents removed, anything but letters and digits as single spaces ("Parañaque" -> "paranaque")."""
    t = "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c)).lower()
    return " ".join("".join(c if c.isalnum() else " " for c in t).split())


def ja_fold(s: str) -> str:
    """NFKC (full-width ASCII, half-width kana) and katakana as hiragana, as in the web app's jaKey."""
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in unicodedata.normalize("NFKC", s))


def is_latin(c: str) -> bool:
    return c.isascii() and c.isalnum()


def ja_bucket(c: str) -> str:
    return f"ja-{ord(c) % JA_BUCKETS:02d}"


def latin_words(row: dict[str, Any]) -> set[str]:
    """Words of the name and of its province (PH admin2) or prefecture (JP admin1, which has no admin2). PH regions
    (admin1, "Western Visayas") are left out: they would copy hundreds of places into the "re"/"vi" slices, and a
    region query that finds nothing in its slice is answered from the full index."""
    words: set[str] = set()
    province = row.get("admin2") if isinstance(row.get("admin2"), str) else row.get("admin1")
    for v in (row.get("name"), province):
        if isinstance(v, str):
            words.update(w for w in fold(v).split() if is_latin(w[0]))
    return words


def ja_chars(row: dict[str, Any]) -> set[str]:
    """Characters of the Japanese names, without the trailing 市/区/町/村 or 都/道/府/県 that nearly every name
    has (a query never starts with it, and its bucket would hold every city)."""
    out: set[str] = set()
    for col, suffix in (("nameJa", "市区町村"), ("admin1Ja", "都道府県")):
        v = row.get(col)
        if isinstance(v, str):
            t = ja_fold(v).strip()
            if len(t) > 1 and t[-1] in suffix:
                t = t[:-1]
            out.update(c for c in t if not c.isspace() and not is_latin(c))
    return out


def query_key(q: str, manifest: dict[str, Any]) -> str | None:
    """The slice a query reads (None: use the full index). Mirrors queryShardKey in web/src/data/places.ts."""
    keys, split = set(manifest["keys"]), set(manifest["split"])
    j = ja_fold(q).strip()
    if not j:
        return None
    lead = fold(j[0])
    if not (lead and is_latin(lead[0])):
        k = ja_bucket(j[0])
        return k if k in keys else None
    first = fold(q).split()[0]
    k = first[:2] if first[0] in split else first[0]
    return k if len(k) == (2 if first[0] in split else 1) and k in keys else None


def _doc(rows: list[list[Any]], columns: list[str], shard_paths: list[str]) -> dict[str, Any]:
    si = columns.index("shard")
    used = sorted({r[si] for r in rows if isinstance(r[si], int)})
    remap = {old: new for new, old in enumerate(used)}
    out_rows = [[*r[:si], remap.get(r[si]), *r[si + 1:]] for r in rows]
    return {"schema": "typhoon-replay/places-search@1", "columns": columns,
            "shards": [shard_paths[i] for i in used], "rows": out_rows}


def _size(doc: dict[str, Any]) -> int:
    return len(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))


def build(search: dict[str, Any]) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    """Split a ``search.json`` document into (manifest, {key: slice document})."""
    columns: list[str] = list(search["columns"])
    shard_paths: list[str] = list(search.get("shards") or [])
    rows: list[list[Any]] = search["rows"]
    by_word: dict[str, list[int]] = {}
    by_ja: dict[str, list[int]] = {}
    for i, r in enumerate(rows):
        row = dict(zip(columns, r, strict=False))
        for w in latin_words(row):
            by_word.setdefault(w, []).append(i)
        for c in ja_chars(row):
            by_ja.setdefault(ja_bucket(c), []).append(i)

    def pick(ids: set[int]) -> list[list[Any]]:
        return [rows[i] for i in sorted(ids)]

    slices: dict[str, dict[str, Any]] = {}
    letters: dict[str, set[int]] = {}
    for w, wids in by_word.items():
        letters.setdefault(w[0], set()).update(wids)
    split: list[str] = []
    for letter, lids in sorted(letters.items()):
        doc = _doc(pick(lids), columns, shard_paths)
        if _size(doc) <= SPLIT_BYTES:
            slices[letter] = doc
            continue
        split.append(letter)
        two: dict[str, set[int]] = {}
        for w, wids in by_word.items():
            if w[0] == letter and len(w) > 1:  # a one-letter word cannot start a two-letter query
                two.setdefault(w[:2], set()).update(wids)
        for k, kids in sorted(two.items()):
            slices[k] = _doc(pick(kids), columns, shard_paths)
    for k, jids in sorted(by_ja.items()):
        slices[k] = _doc(pick(set(jids)), columns, shard_paths)
    manifest = {
        "schema": MANIFEST_SCHEMA,
        "note": "Slices of search.json by the first letter(s) of each name word (folded: lower case, no accents) "
                "and, for Japanese names, by each character (NFKC, katakana as hiragana) into "
                f"ja-<code point mod {JA_BUCKETS}>. File: search/<key>.json. Letters in `split` use two-letter keys.",
        "jaBuckets": JA_BUCKETS, "split": split, "keys": sorted(slices), "places": len(rows),
    }
    return manifest, slices


def write(places_dir: Path) -> dict[str, Any]:
    """Write search/<key>.json and search/manifest.json beside an existing places/search.json."""
    manifest, slices = build(json.loads((places_dir / "search.json").read_bytes()))
    sdir = places_dir / "search"
    sdir.mkdir(parents=True, exist_ok=True)
    for key, doc in slices.items():
        (sdir / f"{key}.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (sdir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return manifest


if __name__ == "__main__":   # python -m typhoon.place_search <places dir>  (the web fixtures use this)
    m = write(Path(sys.argv[1]))
    print(f"{len(m['keys'])} slices for {m['places']} places")
