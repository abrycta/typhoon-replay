"""Parse English Wikipedia "YYYY Pacific typhoon season" wikitext into storm-name rows.

Pure functions only (no network): ``typhoon.crosswalk scrape`` fetches the pages through
``typhoon.sources.fetch_template`` and calls :func:`parse_season`.

Storm sections are the level-3+ headings inside the level-2 "Systems" (or "Storms"/"Other systems")
section, e.g.::

    ===Typhoon Polly (Auring)===                  intl Polly, PAGASA Auring
    ===Tropical Depression Gening===              PAGASA-only depression (name on the season's PAGASA list)
    ===Tropical Depression 30W (Wilma)===         JTWC designation 30W, PAGASA Wilma
    ===Typhoon Gloria (Oniang)<span ...></span>===
    === Tropical Storm Kujira (Luis{{endash}}Maymay) ===   two PAGASA names for one system
    ===CMA Tropical Depression 1===               no names

A heading without parentheses carries one name, which is either international or PAGASA; it is
classified with the season's PAGASA name table (the "Philippines" section). Wikipedia text is
CC BY-SA 4.0: derived rows must keep :func:`season_url` for attribution.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

CATEGORY_RE = re.compile(
    r"^(?P<agency>(?:CMA|JMA|PAGASA)\s+)?"
    r"(?P<cat>(?:Super|Violent|Very\s+Strong|Severe|Strong)?\s*"
    r"(?:Typhoon|Tropical\s+Storm|Tropical\s+Depression|Subtropical\s+Storm|Subtropical\s+Depression))"
    r"(?:\s+(?P<rest>.*))?$",
    re.IGNORECASE,
)
HEADING_RE = re.compile(r"^\s*(?P<lv>={2,6})(?P<text>.+?)(?P=lv)\s*(?:<!--.*)?$")
DESIGNATION_RE = re.compile(r"^\d{1,2}[WC](?:/\d{1,2}[WC])*$", re.IGNORECASE)
NUMBER_WORDS = {
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty",
}
NAME_RE = re.compile(r"^[^\W\d_][^\W\d_'’-]*(?:[-'’][^\W\d_]+)*$")   # one word, letters (incl. ñ), inner hyphen
SPLIT_RE = re.compile(r"\s*(?:–|—|-|/|\band\b|,)\s*")
SECTION_RE = re.compile(r"\b(systems|storms)\b", re.IGNORECASE)


@dataclass(frozen=True)
class WikiStorm:
    """One storm heading x one PAGASA name (a heading with two PAGASA names yields two rows)."""

    season: int
    heading: str                 # cleaned heading text
    category: str                # e.g. "Typhoon", "Tropical Depression", "CMA Tropical Depression"
    intl_name: str | None        # international (JMA/RSMC) name, None for PAGASA-only / designation-only
    pagasa_name: str | None
    designation: str | None      # JTWC number ("30W", "32W/33W") or agency number ("1", "Eight")
    on_pagasa_list: bool | None  # pagasa_name appears in the season's PAGASA table (None: no table found)


def season_url(year: int) -> str:
    return f"https://en.wikipedia.org/wiki/{year}_Pacific_typhoon_season"


def fold(s: str) -> str:
    """Case/diacritic-insensitive key: 'Niña' -> 'NINA', 'Son-Tinh' -> 'SONTINH'."""
    d = unicodedata.normalize("NFKD", s)
    return re.sub(r"[^A-Z]", "", "".join(c for c in d if not unicodedata.combining(c)).upper())


def clean_wikitext(s: str) -> str:
    """Strip markup from a heading or table cell: comments, refs, spans, anchors, links, dash templates."""
    s = re.sub(r"<!--.*?-->", "", s, flags=re.DOTALL)
    s = re.sub(r"<ref[^>]*/>", "", s)
    s = re.sub(r"<ref[^>]*>.*?</ref>", "", s, flags=re.DOTALL)
    s = re.sub(r"<span[^>]*>.*?</span>", "", s, flags=re.DOTALL)
    s = re.sub(r"</?[a-zA-Z][^>]*>", "", s)
    s = re.sub(r"\{\{\s*(?:endash|ndash|en dash)\s*\}\}", "–", s, flags=re.IGNORECASE)
    s = re.sub(r"\{\{\s*(?:anchors?|vanchor|efn|sfn|refn)\s*\|[^{}]*\}\}", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\{\{\s*tcname\s+\w+\s*\|([^{}|]*)\}\}", r"\1", s, flags=re.IGNORECASE)
    s = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]*)\]\]", r"\1", s)
    s = re.sub(r"'{2,}", "", s)
    s = s.replace("&nbsp;", " ").replace("&ndash;", "–")
    return re.sub(r"\s+", " ", s).strip()


@dataclass(frozen=True)
class PagasaList:
    """A season's PAGASA name table: folded key -> name as written."""

    used: dict[str, str]
    unused: dict[str, str]

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and (fold(name) in self.used or fold(name) in self.unused)


def _sections(text: str) -> list[tuple[int, str, int, int]]:
    """(level, cleaned title, body start, body end) for every heading; body runs to the next heading."""
    lines = text.splitlines(keepends=True)
    heads: list[tuple[int, str, int]] = []
    pos = 0
    for ln in lines:
        m = HEADING_RE.match(ln.rstrip("\n"))
        if m:
            heads.append((len(m.group("lv")), clean_wikitext(m.group("text")), pos, ))
        pos += len(ln)
    out = []
    for i, (lv, title, start) in enumerate(heads):
        body_start = text.index("\n", start) + 1 if "\n" in text[start:] else len(text)
        end = heads[i + 1][2] if i + 1 < len(heads) else len(text)
        out.append((lv, title, body_start, end))
    return out


def parse_pagasa_list(text: str) -> PagasaList | None:
    """Names in the season's "Philippines" name table (main + auxiliary), split into used/unused.

    Reads table cells and bullet items of the section (and its sub-sections such as "Used names" /
    "Unused names"); ``{{tcname unused|X}}``, "X (unused)" and an "Unused" sub-section mark unused names.
    """
    text = strip_comments(text)
    secs = _sections(text)
    for i, (lv, title, b0, _b1) in enumerate(secs):
        if lv < 3 or title.strip().lower() not in {"philippines", "philippine names", "philippine"}:
            continue
        end = next((s[2] for s in secs[i + 1:] if s[0] <= lv), len(text))
        used: dict[str, str] = {}
        unused: dict[str, str] = {}
        sub_unused = False
        in_table = 0
        for raw in text[b0:end].splitlines():
            line = raw.strip()
            hm = HEADING_RE.match(line)
            if hm:
                sub_unused = "unused" in hm.group("text").lower()
                continue
            if line.startswith("{|"):
                in_table += 1
                continue
            if line.startswith("|}"):
                in_table = max(0, in_table - 1)
                continue
            is_bullet = line.startswith("*")
            if not (is_bullet or (in_table and line.startswith("|"))) or line.startswith(("|-", "|+")):
                continue
            for cell in line.lstrip("|*").split("||"):
                is_unused = sub_unused or bool(re.search(r"\{\{\s*tcname\s+unused", cell, re.IGNORECASE))
                name = clean_wikitext(cell)
                if "|" in name:   # attribute prefix: scope="col" width="20%" | Atang
                    name = name.rsplit("|", 1)[1].strip()
                if re.search(r"\(\s*unused\s*\)", name, re.IGNORECASE):
                    is_unused = True
                name = re.sub(r"\s*\((?:\d{4}|unused)\)\s*$", "", name, flags=re.IGNORECASE).strip()
                if name and NAME_RE.match(name):
                    (unused if is_unused else used)[fold(name)] = name
        if used or unused:
            return PagasaList(used, {k: v for k, v in unused.items() if k not in used})
    return None


def strip_comments(text: str) -> str:
    return re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)


def _split_names(s: str) -> list[str] | None:
    parts = [p for p in SPLIT_RE.split(s.strip()) if p]
    return parts if parts and all(NAME_RE.match(p) for p in parts) else None


def parse_heading(text: str, season: int, pagasa: PagasaList | None = None) -> list[WikiStorm]:
    """Parse one cleaned storm heading; [] if it is not a storm heading."""
    heading = clean_wikitext(text)
    m = CATEGORY_RE.match(heading)
    if not m:
        return []
    agency = (m.group("agency") or "").strip()
    category = re.sub(r"\s+", " ", f"{agency} {m.group('cat')}").strip()
    rest = (m.group("rest") or "").strip()
    paren: list[str] = []
    pm = re.match(r"^(?P<main>.*?)\s*\((?P<p>[^()]*)\)\s*$", rest)
    if pm:
        names = _split_names(pm.group("p"))
        paren = names or []
        rest = pm.group("main").strip()
    intl: str | None = None
    designation: str | None = None
    if not rest:
        pass
    elif DESIGNATION_RE.match(rest) or rest.isdigit() or rest.lower() in NUMBER_WORDS or (
            "-" in rest and all(w.lower() in NUMBER_WORDS for w in rest.split("-"))):
        designation = rest.upper() if DESIGNATION_RE.match(rest) else rest
    elif NAME_RE.match(rest) or (_split_names(rest) is not None):
        intl = rest
    else:
        return []  # e.g. "Tropical Storm Risk Consortium" or prose headings
    if agency and intl is None and not paren:
        return [WikiStorm(season, heading, category, None, None, designation, None)]
    if intl is not None and not paren and pagasa is not None and fold(intl) in pagasa.used:
        # single name that is on the season's PAGASA list: a PAGASA-only system
        return [WikiStorm(season, heading, category, None, intl, designation, True)]
    if not paren:
        return [WikiStorm(season, heading, category, intl, None, designation, None)]
    return [WikiStorm(season, heading, category, intl, p, designation,
                      None if pagasa is None else p in pagasa) for p in paren]


def parse_season(text: str, season: int) -> list[WikiStorm]:
    """All storm rows of one season page (headings under the Systems section), in page order."""
    text = strip_comments(text)
    pagasa = parse_pagasa_list(text)
    rows: list[WikiStorm] = []
    in_systems = False
    for lv, title, _b0, _b1 in _sections(text):
        if lv == 2:
            in_systems = bool(SECTION_RE.search(title)) and "names" not in title.lower()
            continue
        if in_systems:
            rows.extend(parse_heading(title, season, pagasa))
    return rows


def pagasa_list_only(text: str, season: int, rows: list[WikiStorm]) -> list[str]:
    """Used PAGASA names of the season (as written) that no storm heading carries, sorted."""
    pagasa = parse_pagasa_list(text)
    if pagasa is None:
        return []
    seen = {fold(r.pagasa_name) for r in rows if r.pagasa_name}
    return sorted(v for k, v in pagasa.used.items() if k not in seen)
