"""Places: Philippine cities/municipalities (ADM3) and Japanese municipalities, with codes and geometry.

Usage: uv run python -m typhoon.places        -> data/processed/places/places.parquet (+ report.json)

Philippines (1,6xx units)
  * boundaries: geoBoundaries gbOpen PHL ADM3, pinned commit (`geoboundaries-phl-adm3`);
  * codes and admin names: OCHA COD-AB tabular data (`hdx-cod-ab-phl-tabular`; the shapes are matched to
    COD rows by centre-in-polygon and name), whose p-codes use the old 9-digit PSGC structure; mapped to
    the 10-digit PSGC through the PSGC list (`psgc-cities-municipalities`), by old code, else by name
    within the province.
Japan (1,7xx units)
  * boundaries, JIS X 0402 codes, Japanese names: MLIT N03 2025-01-01 (`mlit-n03-jpn`); wards of the 20
    designated cities are dissolved into their city (the contract's places are municipalities), Tokyo's
    23 special wards stay separate;
  * romanised names: the geoBoundaries JPN ADM2 shape with the largest overlap (OSM-derived names).

Geometry per place: `geom` simplified to about 100 m (distance and containment queries) and
`geom_display` with at most 1,500 vertices and 4-decimal coordinates (served by the API, drawn by the app).
"""
from __future__ import annotations

import difflib
import json
import logging
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyogrio
import shapely
from pyproj import Geod
from shapely import MultiPolygon, Polygon

from . import sources
from .config import PROCESSED, ensure_dir

log = logging.getLogger("typhoon.places")
OUT = PROCESSED / "places"
GEOD = Geod(ellps="WGS84")
SIMPLIFY_DEG = 0.001          # ~100 m
DISPLAY_MAX_VERTICES = 1500

# ----------------------------------------------------------------------------- Japan reference tables

PREFECTURES: dict[str, tuple[str, str]] = {  # JIS prefecture code -> (English, Japanese)
    "01": ("Hokkaido", "北海道"), "02": ("Aomori", "青森県"), "03": ("Iwate", "岩手県"), "04": ("Miyagi", "宮城県"),
    "05": ("Akita", "秋田県"), "06": ("Yamagata", "山形県"), "07": ("Fukushima", "福島県"), "08": ("Ibaraki", "茨城県"),
    "09": ("Tochigi", "栃木県"), "10": ("Gunma", "群馬県"), "11": ("Saitama", "埼玉県"), "12": ("Chiba", "千葉県"),
    "13": ("Tokyo", "東京都"), "14": ("Kanagawa", "神奈川県"), "15": ("Niigata", "新潟県"), "16": ("Toyama", "富山県"),
    "17": ("Ishikawa", "石川県"), "18": ("Fukui", "福井県"), "19": ("Yamanashi", "山梨県"), "20": ("Nagano", "長野県"),
    "21": ("Gifu", "岐阜県"), "22": ("Shizuoka", "静岡県"), "23": ("Aichi", "愛知県"), "24": ("Mie", "三重県"),
    "25": ("Shiga", "滋賀県"), "26": ("Kyoto", "京都府"), "27": ("Osaka", "大阪府"), "28": ("Hyogo", "兵庫県"),
    "29": ("Nara", "奈良県"), "30": ("Wakayama", "和歌山県"), "31": ("Tottori", "鳥取県"), "32": ("Shimane", "島根県"),
    "33": ("Okayama", "岡山県"), "34": ("Hiroshima", "広島県"), "35": ("Yamaguchi", "山口県"),
    "36": ("Tokushima", "徳島県"), "37": ("Kagawa", "香川県"), "38": ("Ehime", "愛媛県"), "39": ("Kochi", "高知県"),
    "40": ("Fukuoka", "福岡県"), "41": ("Saga", "佐賀県"), "42": ("Nagasaki", "長崎県"), "43": ("Kumamoto", "熊本県"),
    "44": ("Oita", "大分県"), "45": ("Miyazaki", "宮崎県"), "46": ("Kagoshima", "鹿児島県"), "47": ("Okinawa", "沖縄県"),
}
# The 20 designated cities (政令指定都市): N03 lists their wards; the place is the whole city.
DESIGNATED_CITIES: dict[tuple[str, str], tuple[str, str]] = {  # (prefecture, city kanji) -> (JIS code, English)
    ("北海道", "札幌市"): ("01100", "Sapporo"), ("宮城県", "仙台市"): ("04100", "Sendai"),
    ("埼玉県", "さいたま市"): ("11100", "Saitama"), ("千葉県", "千葉市"): ("12100", "Chiba"),
    ("神奈川県", "横浜市"): ("14100", "Yokohama"), ("神奈川県", "川崎市"): ("14130", "Kawasaki"),
    ("神奈川県", "相模原市"): ("14150", "Sagamihara"), ("新潟県", "新潟市"): ("15100", "Niigata"),
    ("静岡県", "静岡市"): ("22100", "Shizuoka"), ("静岡県", "浜松市"): ("22130", "Hamamatsu"),
    ("愛知県", "名古屋市"): ("23100", "Nagoya"), ("京都府", "京都市"): ("26100", "Kyoto"),
    ("大阪府", "大阪市"): ("27100", "Osaka"), ("大阪府", "堺市"): ("27140", "Sakai"),
    ("兵庫県", "神戸市"): ("28100", "Kobe"), ("岡山県", "岡山市"): ("33100", "Okayama"),
    ("広島県", "広島市"): ("34100", "Hiroshima"), ("福岡県", "北九州市"): ("40100", "Kitakyushu"),
    ("福岡県", "福岡市"): ("40130", "Fukuoka"), ("熊本県", "熊本市"): ("43100", "Kumamoto"),
}


# Municipalities N03 lists that have no geoBoundaries (OSM) counterpart: the six villages of the
# Northern Territories, administered by Russia.
NO_OSM_NAME = {"01695": "Shikotan", "01696": "Tomari", "01697": "Ruyobetsu", "01698": "Rubetsu",
               "01699": "Shana", "01700": "Shibetoro"}


# ----------------------------------------------------------------------------- helpers

def norm_name(s: str | None) -> str:
    """Comparable form of a place name: ascii, lower case, no 'city of' / '(capital)' / punctuation."""
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\(.*?\)", " ", s)
    s = re.sub(r"\b(city of|city|municipality of|island garden city of|science city of)\b", " ", s)
    return re.sub(r"[^a-z0-9]", "", s)


def slug(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def as_multipolygon(g: shapely.Geometry) -> MultiPolygon:
    g = shapely.make_valid(g)
    polys: list[Polygon] = []
    for part in getattr(g, "geoms", [g]):
        if isinstance(part, Polygon) and not part.is_empty:
            polys.append(part)
        elif isinstance(part, MultiPolygon):
            polys.extend(p for p in part.geoms if not p.is_empty)
        elif hasattr(part, "geoms"):  # GeometryCollection from make_valid
            polys.extend(p for p in part.geoms if isinstance(p, Polygon) and not p.is_empty)
    return MultiPolygon(polys)


def vertex_count(g: shapely.Geometry) -> int:
    return int(shapely.get_num_coordinates(g))


def simplify_geom(g: shapely.Geometry) -> MultiPolygon:
    """~100 m simplification for distance/containment (6 decimals)."""
    s = shapely.simplify(g, SIMPLIFY_DEG, preserve_topology=True)
    s = shapely.set_precision(s, 1e-6)
    out = as_multipolygon(s)
    return out if not out.is_empty else as_multipolygon(g)


def display_geom(g: shapely.Geometry, max_vertices: int = DISPLAY_MAX_VERTICES) -> MultiPolygon:
    """At most `max_vertices` vertices, 4-decimal coordinates; drops the smallest islets if needed."""
    tol = 0.0005
    cur = as_multipolygon(shapely.set_precision(shapely.simplify(g, tol, preserve_topology=True), 1e-4))
    while vertex_count(cur) > max_vertices and tol < 0.05:
        tol *= 1.6
        cur = as_multipolygon(shapely.set_precision(shapely.simplify(g, tol, preserve_topology=True), 1e-4))
    if vertex_count(cur) > max_vertices:  # many islets: keep the largest parts that fit
        parts = sorted(cur.geoms, key=lambda p: p.area, reverse=True)
        keep: list[Polygon] = []
        n = 0
        for p in parts:
            k = vertex_count(p)
            if n + k > max_vertices:
                continue
            keep.append(p)
            n += k
        cur = MultiPolygon(keep)
    if cur.is_empty:  # tiny place: fall back to its envelope
        cur = as_multipolygon(shapely.set_precision(shapely.envelope(g), 1e-4))
    return cur


def geodesic_area_km2(g: shapely.Geometry) -> float:
    area, _ = GEOD.geometry_area_perimeter(g)
    return abs(area) / 1e6


def inside_point(g: shapely.Geometry) -> shapely.Point:
    c = shapely.centroid(g)
    return c if shapely.contains(g, c) else shapely.point_on_surface(g)


def read_vector(path: str) -> tuple[pd.DataFrame, np.ndarray]:
    meta, _, geom, fields = pyogrio.raw.read(path)
    df = pd.DataFrame({name: col for name, col in zip(meta["fields"], fields, strict=True)})
    return df, shapely.from_wkb(geom)


# ----------------------------------------------------------------------------- Philippines

PSGC_REGION = {"19": "15"}   # COD-AB uses BARMM's new region code; the 9-digit PSGC kept ARMM's 15
# geoBoundaries splits the City of Manila into its 14 districts; COD-AB and PSGC list the city once.
MANILA_DISTRICTS = {"binondo", "ermita", "intramuros", "malate", "paco", "pandacan", "portarea", "quiapo",
                    "sampaloc", "sanmiguel", "sannicolas", "santaana", "santacruz", "tondoiii", "tondo"}
MANILA_PCODE = "PH1303901"
REGION_FIX = {"Bangsamoro Autonomous Region In Muslim Mindanao": "Bangsamoro Autonomous Region in Muslim Mindanao"}


def clean_region(s: str) -> str:
    m = re.match(r"^(Region [IVX\-AB]+) \((.+)\)$", s.strip())
    if m:
        return m.group(2)
    out = re.sub(r"\s*\(.*\)\s*$", "", s.strip()).replace(" Region", "") if s.startswith("Mimaropa") \
        else re.sub(r"\s*\(.*\)\s*$", "", s.strip())
    return REGION_FIX.get(out, out)


def clean_ph_name(s: str) -> str:
    return re.sub(r"\s*\((Capital|capital)\)\s*", "", s).strip()


@dataclass
class Match:
    pcode: str
    how: str


def match_ph(gb_names: list[str], gb_geoms: np.ndarray, cod: pd.DataFrame) -> list[Match | None]:
    """Assign each geoBoundaries shape a COD ADM3 row: centre-in-polygon + name, then name + nearest."""
    pts = shapely.points(cod.center_lon.to_numpy(), cod.center_lat.to_numpy())
    tree = shapely.STRtree(gb_geoms)
    cod_idx, shp_idx = tree.query(pts, predicate="intersects")  # (input point index, tree shape index)
    by_shape: dict[int, list[int]] = {}
    for c, s in zip(cod_idx, shp_idx, strict=True):
        by_shape.setdefault(int(s), []).append(int(c))
    cod_norm = cod.adm3_name.map(norm_name).to_numpy()
    out: list[Match | None] = [None] * len(gb_names)
    used: set[int] = set()
    # pass 1: a COD centre inside the shape with the same name
    for i, name in enumerate(gb_names):
        n = norm_name(name)
        cands = [c for c in by_shape.get(i, []) if cod_norm[c] == n]
        if len(cands) >= 1:
            out[i] = Match(str(cod.adm3_pcode.iloc[cands[0]]), "centre+name")
            used.add(cands[0])
    # pass 2: same name, nearest centre within 30 km
    cent = shapely.centroid(gb_geoms)
    for i, name in enumerate(gb_names):
        if out[i] is not None:
            continue
        n = norm_name(name)
        cands = [c for c in np.flatnonzero(cod_norm == n) if c not in used]
        if cands:
            d = [shapely.distance(cent[i], pts[c]) for c in cands]
            j = int(np.argmin(d))
            if d[j] < 0.3:
                out[i] = Match(str(cod.adm3_pcode.iloc[cands[j]]), "name+nearest")
                used.add(cands[j])
    # pass 3: the only unused COD centre inside the shape (renamed units)
    for i in range(len(gb_names)):
        if out[i] is not None:
            continue
        cands = [c for c in by_shape.get(i, []) if c not in used]
        if len(cands) == 1:
            out[i] = Match(str(cod.adm3_pcode.iloc[cands[0]]), "centre-only")
            used.add(cands[0])
    return out


def psgc10_lookup(psgc: list[dict[str, Any]], cod: pd.DataFrame) -> dict[str, tuple[str, bool, str]]:
    """COD ADM3 p-code -> (10-digit PSGC, is_city, PSGC name)."""
    by_old = {p["code"]: p for p in psgc}
    by_prov_name: dict[tuple[str, str], dict[str, Any]] = {}
    by_region_name: dict[tuple[str, str], dict[str, Any] | None] = {}
    for p in psgc:
        prov = str(p["provinceCode"] or p["districtCode"] or "")[:4]
        by_prov_name[(prov, norm_name(p["name"]))] = p
        key = (str(p["regionCode"])[:2], norm_name(p["name"]))
        by_region_name[key] = None if key in by_region_name else p  # ambiguous within region -> no match
    by_10 = {p["psgc10DigitCode"]: p for p in psgc}
    names: dict[str, list[dict[str, Any]]] = {}
    for p in psgc:
        names.setdefault(norm_name(p["name"]), []).append(p)
    out: dict[str, tuple[str, bool, str]] = {}
    for r in cod.itertuples():
        d = str(r.adm3_pcode)[2:]                    # e.g. 0803747 = RR PPP MM
        n = norm_name(str(r.adm3_name))
        region = PSGC_REGION.get(d[:2], d[:2])       # BARMM: COD 19, old PSGC 15
        old = region + d[3:5] + d[5:7] + "000"       # old 9-digit RR PP MM BBB
        cands = [by_old.get(old), by_10.get(d + "000"), by_prov_name.get((region + d[3:5], n)),
                 by_region_name.get((region, n))]
        p = next((c for c in cands if c is not None and norm_name(c["name"]) == n), None)
        if p is None and len(names.get(n, [])) == 1:  # unique name nationwide
            p = names[n][0]
        if p is None:  # spelling variants (Baliuag/Baliwag, Corpuz/Corpus) within the province
            prov = [q for q in psgc if str(q["provinceCode"] or "")[:4] == region + d[3:5]]
            close = difflib.get_close_matches(n, [norm_name(q["name"]) for q in prov], n=1, cutoff=0.8)
            if close:
                p = next(q for q in prov if norm_name(q["name"]) == close[0])
        if p is not None:
            out[str(r.adm3_pcode)] = (str(p["psgc10DigitCode"]), bool(p["isCity"]), str(p["name"]))
    return out


def build_ph(manifest: sources.RunManifest | None = None) -> tuple[pd.DataFrame, dict[str, Any]]:
    gb_path = sources.ensure("geoboundaries-phl-adm3", manifest)
    cod_path = sources.ensure("hdx-cod-ab-phl-tabular", manifest)
    psgc_path = sources.ensure("psgc-cities-municipalities", manifest)
    gb, geoms = read_vector(str(gb_path))
    cod = pd.read_excel(cod_path, sheet_name="phl_admin3")
    psgc = json.loads(Path(psgc_path).read_text())
    matches = match_ph(list(gb.shapeName), geoms, cod)
    for i, name in enumerate(gb.shapeName):
        c = shapely.centroid(geoms[i])
        if norm_name(str(name)) in MANILA_DISTRICTS and abs(c.x - 120.98) < 0.08 and abs(c.y - 14.60) < 0.08:
            matches[i] = Match(MANILA_PCODE, "manila-district")
    p10 = psgc10_lookup(psgc, cod)
    cod_by = cod.set_index("adm3_pcode")
    rows, unmatched, merged = [], [], []
    seen: dict[str, int] = {}
    for i, m in enumerate(matches):
        name = str(gb.shapeName.iloc[i])
        if m is None or m.pcode not in p10:
            unmatched.append({"shapeName": name, "shapeID": str(gb.shapeID.iloc[i]),
                              "reason": "no COD row" if m is None else f"no PSGC for {m.pcode}"})
            continue
        code10, is_city, psgc_name = p10[m.pcode]
        c = cod_by.loc[m.pcode]
        pid = f"PH-{code10}"
        if pid in seen:  # two shapes for one unit: merge geometry
            rows[seen[pid]]["_geoms"].append(geoms[i])
            merged.append({"shapeName": name, "into": pid, "how": m.how})
            continue
        region = clean_region(str(c.adm1_name))
        prov = str(c.adm2_name)
        ncr = str(c.adm1_pcode) == "PH13"
        seen[pid] = len(rows)
        rows.append({
            "place_id": pid, "country": "PH", "kind": "city" if is_city else "municipality",
            "name": clean_ph_name(str(c.adm3_name)), "name_ja": None, "admin1": region, "admin1_ja": None,
            "admin2": None if ncr else prov, "shard": "ph-metro-manila" if ncr else "ph-" + slug(prov),
            "source_ref": str(gb.shapeID.iloc[i]), "match": m.how, "psgc_name": psgc_name,
            "_geoms": [geoms[i]],
        })
    report = {"geoboundaries_shapes": len(gb), "cod_rows": len(cod), "places": len(rows),
              "unmatched": unmatched, "merged_shapes": merged,
              "cod_without_shape": sorted(set(map(str, cod.adm3_pcode)) - {m.pcode for m in matches if m}),
              "match_kinds": pd.Series([r["match"] for r in rows]).value_counts().to_dict()}
    return pd.DataFrame(rows), report


# ----------------------------------------------------------------------------- Japan

def build_jp(manifest: sources.RunManifest | None = None) -> tuple[pd.DataFrame, dict[str, Any]]:
    n03 = sources.ensure("mlit-n03-jpn", manifest)
    gbj = sources.ensure("geoboundaries-jpn-adm2", manifest)
    df, geoms = read_vector(f"/vsizip/{n03}/N03-20250101.geojson")
    df["geom"] = geoms
    # drop 所属未定地 (unaffiliated areas, codes NN000) and rows without a code
    df = df[df.N03_007.notna() & (df.N03_007.astype(str).str.len() == 5)
            & ~df.N03_007.astype(str).str.endswith("000")].copy()
    units: dict[str, dict[str, Any]] = {}
    for r in df.itertuples():
        pref, city, ward, code = str(r.N03_001), str(r.N03_004 or ""), r.N03_005, str(r.N03_007)
        dc = DESIGNATED_CITIES.get((pref, city))
        if dc and ward:
            code, kind, name_ja = dc[0], "city", city
        elif pref == "東京都" and city.endswith("区"):
            kind, name_ja = "special-ward", city
        else:
            name_ja = city
            kind = {"市": "city", "町": "town", "村": "village"}.get(city[-1:], "municipality")
        u = units.setdefault(code, {"code": code, "pref": pref, "name_ja": name_ja, "kind": kind, "parts": []})
        u["parts"].append(r.geom)
    gdf, ggeoms = read_vector(str(gbj))
    gtree = shapely.STRtree(ggeoms)
    rows, weak = [], []
    for code, u in sorted(units.items()):
        g = shapely.union_all(u["parts"])
        en_pref, ja_pref = PREFECTURES[code[:2]]
        dc_name = next((v[1] for k, v in DESIGNATED_CITIES.items() if v[0] == code), None) \
            or NO_OSM_NAME.get(code)
        name, frac = dc_name, 1.0
        if name is None:
            idx = gtree.query(g, predicate="intersects")
            best, best_a = None, 0.0
            area = shapely.area(g) or 1e-12
            for j in idx:
                a = float(shapely.area(shapely.intersection(g, ggeoms[j])))
                if a > best_a:
                    best, best_a = int(j), a
            name = str(gdf.shapeName.iloc[best]) if best is not None else u["name_ja"]
            frac = best_a / area
            if frac < 0.5:
                weak.append({"code": code, "name_ja": u["name_ja"], "name": name, "overlap": round(frac, 3)})
        rows.append({
            "place_id": f"JP-{code}", "country": "JP", "kind": u["kind"], "name": name, "name_ja": u["name_ja"],
            "admin1": en_pref, "admin1_ja": ja_pref, "admin2": None, "shard": f"jp-{code[:2]}-{slug(en_pref)}",
            "source_ref": f"N03-20250101:{code}", "match": "n03+geoboundaries-overlap", "psgc_name": None,
            "_geoms": [g],
        })
    report = {"n03_features": int(len(df)), "places": len(rows), "weak_name_overlap": weak}
    return pd.DataFrame(rows), report


# ----------------------------------------------------------------------------- assemble

def finish(df: pd.DataFrame) -> pd.DataFrame:
    geoms, disp, area, cx, cy, bbox = [], [], [], [], [], []
    for parts in df["_geoms"]:
        g = as_multipolygon(shapely.union_all(parts) if len(parts) > 1 else parts[0])
        s = simplify_geom(g)
        d = display_geom(g)
        p = inside_point(s)
        geoms.append(shapely.to_wkb(s))
        disp.append(shapely.to_wkb(d))
        area.append(round(geodesic_area_km2(g), 2))
        cx.append(round(p.x, 5))
        cy.append(round(p.y, 5))
        bbox.append([round(v, 4) for v in shapely.bounds(s).tolist()])
    out = df.drop(columns=["_geoms"]).copy()
    out["area_km2"] = area
    out["centroid_lon"] = cx
    out["centroid_lat"] = cy
    out["bbox"] = bbox
    out["geom_wkb"] = geoms
    out["geom_display_wkb"] = disp
    out["search_text"] = [
        " | ".join(x.lower() for x in (r.name, r.name_ja, r.admin1, r.admin1_ja, r.admin2) if isinstance(x, str) and x)
        for r in out.itertuples()]
    return out.sort_values("place_id").reset_index(drop=True)


def build(manifest: sources.RunManifest | None = None) -> pd.DataFrame:
    ensure_dir(OUT)
    ph, rep_ph = build_ph(manifest)
    jp, rep_jp = build_jp(manifest)
    places = finish(pd.concat([ph, jp], ignore_index=True))
    assert places.place_id.is_unique, "duplicate place ids"
    places.to_parquet(OUT / "places.parquet", index=False, compression="zstd")
    report = {"ph": rep_ph, "jp": rep_jp, "count": places.country.value_counts().to_dict(),
              "display_max_vertices": int(max(vertex_count(shapely.from_wkb(w)) for w in places.geom_display_wkb))}
    (OUT / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str))
    log.info("places: %s", report["count"])
    return places


def load() -> pd.DataFrame:
    p = OUT / "places.parquet"
    return pd.read_parquet(p) if p.exists() else build()


def land_union(places: pd.DataFrame, country: str) -> shapely.Geometry:
    """Union of a country's place geometries (~100 m): the land mask for landfall detection."""
    g = shapely.from_wkb(places.loc[places.country == country, "geom_wkb"].to_numpy())
    return shapely.union_all(g)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    p = build()
    print(p.groupby("country").size().to_string())
    print(json.dumps({k: v for k, v in json.loads((OUT / "report.json").read_text()).items() if k != "jp"},
                     indent=1, ensure_ascii=False)[:3000])


if __name__ == "__main__":
    main()
