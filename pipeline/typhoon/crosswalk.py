"""PAGASA local name <-> international name <-> IBTrACS SID crosswalk.

Sources, in order of authority:

1. ``pipeline/crosswalk/pagasa_names_seed.csv``: curated, the source of truth. A seed row always wins
   over a scraped row for the same PAGASA name + season or the same SID.
2. ``pipeline/crosswalk/pagasa_names_wikipedia.csv``: scraped from the English Wikipedia
   "YYYY Pacific typhoon season" pages (CC BY-SA 4.0; every row keeps its ``source_url``), reviewable
   additions.

Join: normalised international name + season against IBTrACS (names reused across seasons, so the
season is required; IBTrACS merge names "A:B" match either part; spur tracks excluded). PAGASA-only
systems with a JTWC number ("Tropical Depression 30W (Wilma)", seed jtwc_id) join on USA_ATCF_ID.
Validation: the storm entered the PAGASA Area of Responsibility, and the JTWC number agrees when known.

    uv run python -m typhoon.crosswalk                 # = build
    uv run python -m typhoon.crosswalk scrape [--from 1963 --to 2026 --refresh]
    uv run python -m typhoon.crosswalk build

Outputs (small, versioned): pagasa_names_wikipedia.csv (scrape), pagasa_names_sid.csv and
UNMATCHED.md (build). ``contracts/db/seed/build_seed.py`` reads pagasa_names_sid.csv rows with
status == "matched" (columns pagasa_name, intl_name, season, sid, source_url).
"""
from __future__ import annotations

import argparse
import datetime as dt
import re
import time
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from typhoon.wikipedia import SPLIT_RE, fold, pagasa_list_only, parse_season, season_url

ROOT = Path(__file__).resolve().parents[2]
CW = ROOT / "pipeline/crosswalk"
SEED_CSV = CW / "pagasa_names_seed.csv"
WIKI_CSV = CW / "pagasa_names_wikipedia.csv"
OUT_CSV = CW / "pagasa_names_sid.csv"
REPORT_MD = CW / "UNMATCHED.md"
IBTRACS_STORMS = ROOT / "data/processed/ibtracs/storms.parquet"

WIKI_SOURCE_ID = "wikipedia-season-pages"
FIRST_SEASON = 1963            # PAGASA (then the Philippine Weather Bureau) local names start in 1963
THROTTLE_S = 1.6               # between Wikipedia requests (HTTP 429 seen at ~1 request/s)

WIKI_COLUMNS = ["season", "pagasa_name", "intl_name", "category", "designation", "on_pagasa_list",
                "heading", "source_url"]
OUT_COLUMNS = ["pagasa_name", "intl_name", "season", "sid", "status", "usa_atcf_id", "landfall_ph_ibtracs",
               "source_url", "origin", "ibtracs_name", "match_by", "wikipedia_check", "heading", "note"]
TABLE_ONLY = "(PAGASA name table only)"


def norm(s: object) -> str:
    """Letters-only upper-case key (diacritics folded); '' for missing values."""
    return fold(s) if isinstance(s, str) else ""


# ----------------------------------------------------------------------------- scrape

def scrape(first: int = FIRST_SEASON, last: int | None = None, *, refresh: bool = False,
           out: Path = WIKI_CSV) -> pd.DataFrame:
    """Fetch (throttled, through typhoon.sources) and parse season pages; write the reviewable CSV."""
    from typhoon.sources import fetch_template, local_path

    last = last or dt.date.today().year
    rows: list[dict[str, object]] = []
    fetched = failed = 0
    last_request = 0.0
    for year in range(first, last + 1):
        path = local_path(WIKI_SOURCE_ID, year=year)
        if refresh or not path.exists():
            wait = THROTTLE_S - (time.monotonic() - last_request)
            if wait > 0:
                time.sleep(wait)
            for attempt in range(3):
                last_request = time.monotonic()
                try:
                    fetch_template(WIKI_SOURCE_ID, year=year, manifest=None, reporter=False)
                    fetched += 1
                    break
                except Exception as e:  # noqa: BLE001 - archivekit raises several kinds; retry then skip
                    print(f"{year}: fetch failed ({type(e).__name__}: {str(e)[:120]})")
                    time.sleep(10 * (attempt + 1))
            else:
                failed += 1
        if not path.exists():
            continue
        rows.extend(season_rows(path.read_text(encoding="utf-8"), year))
    df = pd.DataFrame(rows, columns=WIKI_COLUMNS)
    df.to_csv(out, index=False)
    n_head = int((df["category"] != TABLE_ONLY).sum())
    print(f"pages fetched {fetched}, failed {failed}; storm rows {n_head} "
          f"({int(df.loc[df.category != TABLE_ONLY, 'pagasa_name'].notna().sum())} with a PAGASA name, "
          f"{int((df.pagasa_name.notna() & df.intl_name.notna()).sum())} PAGASA-international pairs); "
          f"PAGASA-table-only names {int((df.category == TABLE_ONLY).sum())} -> {out.relative_to(ROOT)}")
    return df


def season_rows(text: str, year: int) -> list[dict[str, object]]:
    """CSV rows of one season page: every storm heading, plus used PAGASA names that no heading carries."""
    storms = parse_season(text, year)
    url = season_url(year)
    rows: list[dict[str, object]] = [
        {"season": year, "pagasa_name": s.pagasa_name, "intl_name": s.intl_name, "category": s.category,
         "designation": s.designation, "on_pagasa_list": s.on_pagasa_list, "heading": s.heading,
         "source_url": url} for s in storms]
    rows += [{"season": year, "pagasa_name": n, "intl_name": None, "category": TABLE_ONLY, "designation": None,
              "on_pagasa_list": True, "heading": None, "source_url": url}
             for n in pagasa_list_only(text, year, storms)]
    return rows


# ----------------------------------------------------------------------------- join

@dataclass
class Match:
    sid: str | None
    status: str
    match_by: str | None = None
    note: str = ""


class StormIndex:
    """IBTrACS non-spur storms indexed by season and name keys (merge names 'A:B' give A, B and AB)."""

    def __init__(self, storms: pd.DataFrame, jma: pd.DataFrame | None = None) -> None:
        """``jma`` (optional; typhoon.jma output: sid, jma_name) adds JMA's spelling of each storm's name,
        which rescues storms whose IBTrACS name differs (JMA BRENDA = IBTrACS BRENDAN 1985)."""
        st = storms[~storms["track_type"].astype(str).str.contains("spur")].copy()
        st["season"] = st["season"].astype(int)
        self.st = st.set_index("sid", drop=False)
        self.jma_sids: set[str] = set() if jma is None else set(jma["sid"].dropna())
        self.by_key: dict[tuple[int, str], set[str]] = {}
        names = list(zip(st["sid"], st["season"], st["name"], strict=True))
        if jma is not None and len(jma):
            season_of = dict(zip(st["sid"], st["season"], strict=True))
            names += [(sid, season_of[sid], str(n).replace("/", ":")) for sid, n in
                      zip(jma["sid"], jma["jma_name"], strict=True) if sid in season_of and isinstance(n, str)]
        for sid, season, name in names:
            if not isinstance(name, str) or name in ("UNNAMED", "NOT_NAMED"):
                continue
            keys = {norm(name.replace(":", ""))} | {norm(p) for p in name.split(":")}
            for k in keys - {""}:
                self.by_key.setdefault((season, k), set()).add(sid)
        self.by_atcf: dict[str, set[str]] = {}
        for sid, atcf in zip(st["sid"], st["usa_atcf_id"], strict=True):
            if isinstance(atcf, str) and atcf:
                self.by_atcf.setdefault(atcf.upper(), set()).add(sid)

    def by_name(self, intl: str, season: int) -> tuple[set[str], str]:
        full = norm(intl)
        parts = [norm(p) for p in SPLIT_RE.split(intl) if norm(p)]
        for how, seasons in (("name+season", [season]), ("name+adjacent_season", [season - 1, season + 1])):
            hits = set().union(*(self.by_key.get((s, full), set()) for s in seasons))
            if not hits and len(parts) > 1:
                hits = set().union(*(self.by_key.get((s, p), set()) for s in seasons for p in parts))
                how += "(part)"
            if hits:
                return hits, how
        return set(), ""

    def by_jtwc(self, designation: str, season: int) -> set[str]:
        out: set[str] = set()
        for num in re.findall(r"(\d{1,2})W", designation.upper()):
            out |= self.by_atcf.get(f"WP{int(num):02d}{season}", set())
        return out

    def row(self, sid: str) -> pd.Series:
        row = self.st.loc[sid]
        assert isinstance(row, pd.Series), f"duplicate SID {sid}"
        return row


def _season(v: object) -> int:
    """A season value from a CSV/DataFrame cell (int, numpy int or digit string)."""
    return int(str(v))


def match_one(idx: StormIndex, intl: object, season: int, jtwc: object = None) -> Match:
    """Join one PAGASA row to a SID. ``jtwc`` is a JTWC number like '31W' (seed jtwc_id or heading)."""
    jt = [f"{int(n):02d}" for n in re.findall(r"(\d{1,2})W", jtwc.upper())] if isinstance(jtwc, str) else []
    if isinstance(intl, str) and norm(intl):
        cands, how = idx.by_name(intl, season)
        if not cands:
            return Match(None, "not_found", note=f"no IBTrACS storm named {intl} in {season - 1}-{season + 1}")
        if len(cands) > 1:
            # a name used twice in a season, or a duplicate track from another agency (e.g. WENDY 1968 has a
            # second SID starting at 24N 120E with no JMA data): prefer PAR, the JTWC number, then JMA data
            for keep in (lambda s: bool(idx.row(s)["entered_par"]),
                         lambda s: bool(jt) and str(idx.row(s)["usa_atcf_id"] or "")[2:4] in jt,
                         lambda s: s in idx.jma_sids,
                         lambda s: pd.notna(idx.row(s)["max_tokyo_wind_kt"])):
                narrowed = {s for s in cands if keep(s)}
                if narrowed:
                    cands = narrowed
                if len(cands) == 1:
                    break
            if len(cands) > 1:
                return Match(None, "ambiguous", how, note="candidates " + ", ".join(sorted(cands)))
    elif jt:
        cands = idx.by_jtwc(jtwc if isinstance(jtwc, str) else "", season)
        how = "jtwc_number"
        if not cands:
            return Match(None, "not_found", note=f"no IBTrACS storm with USA_ATCF_ID WP{'/'.join(jt)}{season}")
        if len(cands) > 1:
            return Match(None, "ambiguous", how, note="candidates " + ", ".join(sorted(cands)))
        named = str(idx.row(next(iter(cands)))["name"])
        if named not in ("UNNAMED", "NOT_NAMED"):
            # a nameless PAGASA system whose JTWC number points at a named storm: old JTWC numbering in
            # IBTrACS often differs from the numbers quoted on Wikipedia, so do not trust it
            return Match(None, "ambiguous", how, note=f"JTWC number points at named storm {named} "
                         f"({next(iter(cands))}); numbering mismatch?")
    else:
        return Match(None, "no_intl_name", note="PAGASA-only system without international name or JTWC number")
    sid = next(iter(cands))
    r = idx.row(sid)
    atcf = str(r["usa_atcf_id"]) if isinstance(r["usa_atcf_id"], str) else ""
    if not bool(r["entered_par"]):
        return Match(sid, "matched_not_in_par", how, "IBTrACS track never enters the PAR")
    if jt and atcf[2:4] not in jt:
        return Match(sid, "matched_jtwc_mismatch", how, f"JTWC {'/'.join(jt)}W vs USA_ATCF_ID {atcf or 'none'}")
    return Match(sid, "matched", how)


def _out_row(idx: StormIndex, base: dict[str, object], m: Match) -> dict[str, object]:
    r = idx.row(m.sid) if m.sid else None
    return {**base, "sid": m.sid, "status": m.status, "match_by": m.match_by, "note": m.note,
            "usa_atcf_id": None if r is None or not isinstance(r["usa_atcf_id"], str) else r["usa_atcf_id"],
            "landfall_ph_ibtracs": None if r is None else bool(r["landfall_ph"]),
            "ibtracs_name": None if r is None else r["name"]}


def build_crosswalk(seed: pd.DataFrame, wiki: pd.DataFrame, storms: pd.DataFrame,
                    jma: pd.DataFrame | None = None) -> pd.DataFrame:
    """Seed rows (always kept) + Wikipedia PAGASA rows (additions), joined to SIDs. Pure; see module doc."""
    idx = StormIndex(storms, jma)
    out: list[dict[str, object]] = []
    wiki = wiki[wiki["pagasa_name"].notna()].copy()
    wiki["season"] = wiki["season"].astype(int)
    wiki["key"] = wiki["pagasa_name"].map(norm)
    wiki_by_key: dict[tuple[str, int], pd.DataFrame] = {
        (str(k[0]), _season(k[1])): g for k, g in wiki.groupby(["key", "season"])}

    seed_keys: set[tuple[str, int]] = set()
    seed_sids: dict[str, str] = {}
    for r in seed.itertuples(index=False):
        season = _season(r.season)
        intl = r.intl_name if isinstance(r.intl_name, str) and r.intl_name.strip() else None
        m = match_one(idx, intl, season, r.jtwc_id)
        k = (norm(r.pagasa_name), season)
        seed_keys.add(k)
        if m.sid and m.status == "matched":
            seed_sids[m.sid] = str(r.pagasa_name)
        w = wiki_by_key.get(k)
        if w is None:
            check = "absent"
        else:
            wi = {norm(x) for x in w["intl_name"].dropna()}
            check = "agrees" if (norm(intl) in wi or (not intl and not wi)) else \
                "differs: " + "; ".join(sorted(str(x) for x in w["intl_name"].dropna()) or ["(PAGASA-only)"])
        out.append(_out_row(idx, {"pagasa_name": r.pagasa_name, "intl_name": intl, "season": season,
                                  "source_url": r.source_url, "origin": "seed", "wikipedia_check": check,
                                  "heading": None}, m))

    seen: set[tuple[str, int, str]] = set()
    for k, g in wiki_by_key.items():
        if k in seed_keys:
            continue           # the curated seed row wins (its wikipedia_check records agreement)
        g = g.drop_duplicates(["key", "intl_name", "designation"])
        matches = []
        for r in g.itertuples(index=False):
            jtwc = r.designation if isinstance(r.designation, str) and re.search(r"\d+W", r.designation) else None
            matches.append(match_one(idx, r.intl_name, _season(r.season), jtwc))
        keep = list(range(len(g)))
        if len(g) > 1:
            sids = {m.sid for m in matches}
            named = [i for i, r in enumerate(g.itertuples(index=False)) if isinstance(r.intl_name, str)]
            if (len(sids) == 1 and None not in sids) or (
                    len(named) == 1 and matches[named[0]].status.startswith("matched")):
                # the same system under two headings (e.g. "Tropical Depression 10W (Huaning)" and
                # "Severe Tropical Storm Bolaven (Huaning)" 2000): keep the row with an international name
                keep = named[:1] or [0]
                others = "; ".join(str(r.heading) for i, r in enumerate(g.itertuples(index=False)) if i not in keep)
                matches[keep[0]].note = f"PAGASA name also under heading(s): {others}"
            else:
                for i, m in enumerate(matches):
                    matches[i] = Match(m.sid, "ambiguous", m.match_by,
                                       f"PAGASA name appears in {len(g)} headings this season; " + m.note)
        for i, r in enumerate(g.itertuples(index=False)):
            if i not in keep:
                continue
            m = matches[i]
            key3 = (str(r.key), _season(r.season), str(r.intl_name))
            if key3 in seen:
                continue
            seen.add(key3)
            heading = r.heading if isinstance(r.heading, str) else None
            if r.category == TABLE_ONLY:
                m.note = "used PAGASA name with no storm heading (mentioned under Other systems / names table only)"
            if m.sid and m.sid in seed_sids and m.status.startswith("matched"):
                m = Match(m.sid, "conflict_with_seed", m.match_by,
                          f"seed maps this SID to {seed_sids[m.sid]}; " + m.note)
            if r.on_pagasa_list is False or str(r.on_pagasa_list) == "False":
                m.note = (m.note + "; " if m.note else "") + "name not in the page's PAGASA name table"
            out.append(_out_row(idx, {"pagasa_name": r.pagasa_name,
                                      "intl_name": r.intl_name if isinstance(r.intl_name, str) else None,
                                      "season": _season(r.season), "source_url": r.source_url, "origin": "wikipedia",
                                      "wikipedia_check": None, "heading": heading}, m))
    df = pd.DataFrame(out, columns=OUT_COLUMNS)
    df["note"] = df["note"].fillna("").str.strip("; ")
    # Two PAGASA names joined to one SID (merged systems, e.g. Luis/Maymay 2026): keep both, flag them.
    dup = df["status"].eq("matched") & df.duplicated("sid", keep=False) & df["sid"].notna()
    prev = df.loc[dup, "note"]
    df.loc[dup, "note"] = prev.where(prev == "", prev + "; ") + "SID shared with another PAGASA name"
    df["season"] = df["season"].astype(int)
    return df.sort_values(["season", "origin", "pagasa_name"], ascending=[True, False, True]).reset_index(drop=True)


# ----------------------------------------------------------------------------- report

def _md_table(df: pd.DataFrame, cols: list[str]) -> list[str]:
    def cell(v: object) -> str:
        return "" if v is None or (isinstance(v, float) and pd.isna(v)) else str(v).replace("|", "\\|")
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    lines += ["| " + " | ".join(cell(v) for v in row) + " |" for row in df[cols].itertuples(index=False)]
    return lines


def report(df: pd.DataFrame) -> str:
    counts = pd.crosstab(df["status"], df["origin"], margins=True, margins_name="total")
    lines = [
        "# PAGASA crosswalk: unmatched and flagged names",
        "",
        ("Generated by `uv run python -m typhoon.crosswalk build` from `pagasa_names_seed.csv` (curated, wins on "
         "conflict) and `pagasa_names_wikipedia.csv` (scraped from the English Wikipedia \"YYYY Pacific typhoon "
         "season\" pages, CC BY-SA 4.0). Only `status == matched` rows of `pagasa_names_sid.csv` are used "
         "downstream."),
        "",
        "## Counts by status",
        "",
        *_md_table(counts.reset_index(), ["status", *counts.columns]),
        "",
        f"Matched SIDs: {df.loc[df.status == 'matched', 'sid'].nunique()} distinct.",
        "",
    ]
    seed = df[df.origin == "seed"]
    diff = seed[seed["wikipedia_check"].astype(str).str.startswith("differs")]
    n_agree = int((seed.wikipedia_check == "agrees").sum())
    n_absent = int((seed.wikipedia_check == "absent").sum())
    lines += ["## Seed vs Wikipedia", "",
              f"Seed rows: {len(seed)}; Wikipedia agrees: {n_agree}, differs: {len(diff)}, absent: {n_absent}.", ""]
    if len(diff):
        lines += _md_table(diff, ["season", "pagasa_name", "intl_name", "wikipedia_check"]) + [""]
    shared = df[df["note"].str.contains("SID shared", na=False)]
    if len(shared):
        lines += ["## Matched rows sharing a SID (two PAGASA names, one system)", "",
                  *_md_table(shared.sort_values(["sid", "pagasa_name"]),
                             ["season", "pagasa_name", "intl_name", "sid", "origin"]), ""]
    cols = ["season", "pagasa_name", "intl_name", "origin", "sid", "heading", "note"]
    order = ["conflict_with_seed", "ambiguous", "matched_jtwc_mismatch", "matched_not_in_par", "not_found",
             "no_intl_name"]
    for status in order + sorted(set(df.status) - set(order) - {"matched"}):
        part = df[df.status == status]
        if len(part):
            lines += [f"## {status} ({len(part)})", "", *_md_table(part, cols), ""]
    return "\n".join(lines).rstrip() + "\n"


# ----------------------------------------------------------------------------- CLI

def build(*, write: bool = True) -> pd.DataFrame:
    seed = pd.read_csv(SEED_CSV, dtype=str)
    wiki = pd.read_csv(WIKI_CSV, dtype=str) if WIKI_CSV.exists() else pd.DataFrame(columns=WIKI_COLUMNS)
    storms = pd.read_parquet(IBTRACS_STORMS)
    jma_path = ROOT / "data/processed/jma/jma_numbers.parquet"
    jma = pd.read_parquet(jma_path, columns=["sid", "jma_name"]) if jma_path.exists() else None
    df = build_crosswalk(seed, wiki, storms, jma)
    if write:
        df.to_csv(OUT_CSV, index=False)
        REPORT_MD.write_text(report(df), encoding="utf-8")
    print(pd.crosstab(df["status"], df["origin"], margins=True).to_string())
    print(f"wrote {OUT_CSV.relative_to(ROOT)} ({len(df)} rows) and {REPORT_MD.relative_to(ROOT)}")
    return df


def main(argv: Iterable[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m typhoon.crosswalk", description="PAGASA name crosswalk")
    sub = ap.add_subparsers(dest="cmd")
    sp = sub.add_parser("scrape", help="fetch + parse Wikipedia season pages -> pagasa_names_wikipedia.csv")
    sp.add_argument("--from", dest="first", type=int, default=FIRST_SEASON)
    sp.add_argument("--to", dest="last", type=int, default=dt.date.today().year)
    sp.add_argument("--refresh", action="store_true", help="re-fetch pages already on disk")
    sub.add_parser("build", help="join seed + scraped rows to IBTrACS -> pagasa_names_sid.csv + UNMATCHED.md")
    a = ap.parse_args(list(argv) if argv is not None else None)
    if a.cmd == "scrape":
        scrape(a.first, a.last, refresh=a.refresh)
    else:
        build()


if __name__ == "__main__":
    main()
