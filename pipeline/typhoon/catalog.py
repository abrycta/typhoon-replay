"""Storm catalogue: WP storms since 1940 that affected the Philippines or Japan.

Usage: uv run python -m typhoon.catalog      (after typhoon.ibtracs, typhoon.places, typhoon.jma, crosswalk)

Selection: IBTrACS WP, season >= 1940, not a spur track, and either entered the PAGASA Area of
Responsibility (any fix inside PAR) or made landfall in PH or JP. Landfall is detected on the hourly
track against the catalogue's own place polygons (~100 m), so small islands count and every landfall
carries the place it hit; the time is interpolated to where the hourly segment crosses the coast.

Writes data/processed/catalog/:
  storms.parquet     one row per storm (catalog.storm columns + index extras)
  fixes.parquet      observed best-track fixes (catalog.storm_fix)
  landfalls.parquet  PH/JP landfalls in time order (catalog.storm_landfall)
  hourly.parquet     hourly interpolated tracks (replay track, exposure, frames)
  pagasa.parquet     one PAGASA name per storm (catalog.pagasa_name) + alternates
"""
from __future__ import annotations

import json
import logging
from typing import Any

import numpy as np
import pandas as pd
import shapely

from . import places as places_mod
from .config import CROSSWALK_DIR, FIRST_SEASON, PROCESSED, ensure_dir
from .track import AGENCY_COLUMNS, PREFERRED, hourly, hourly_frame, is_observed, lon180

log = logging.getLogger("typhoon.catalog")
OUT = PROCESSED / "catalog"
MAX_LANDFALLS = 20
NATURE = {"DS": "disturbance", "TS": "tropical", "ET": "extratropical", "SS": "subtropical",
          "NR": "not-reported", "MX": "mixed"}


def display_name(name_ibtracs: str) -> str:
    if name_ibtracs in ("UNNAMED", "NOT_NAMED", "", "nan"):
        return "Unnamed"
    return "/".join(p.title() for p in name_ibtracs.split(":"))


class Land:
    """PH/JP place polygons as the land mask; answers 'which place is this point/segment on'."""

    def __init__(self, places: pd.DataFrame):
        self.ids = places.place_id.to_numpy()
        self.country = places.country.to_numpy()
        self.geoms = shapely.from_wkb(places.geom_wkb.to_numpy())
        self.tree = shapely.STRtree(self.geoms)

    def on_land(self, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
        """Index of the place containing each point, or -1."""
        pts = shapely.points(lon180(np.asarray(lon)), lat)
        i_pt, i_g = self.tree.query(pts, predicate="intersects")
        out = np.full(len(pts), -1)
        out[i_pt] = i_g
        return out

    def entries(self, lon: np.ndarray, lat: np.ndarray, t: np.ndarray) -> list[dict[str, Any]]:
        """Sea-to-land crossings along an hourly track (including islands crossed within an hour)."""
        x = lon180(np.asarray(lon, float))
        land = self.on_land(lon, lat)
        segs = shapely.linestrings(np.stack([np.stack([x[:-1], x[1:]], 1), np.stack([lat[:-1], lat[1:]], 1)], 2))
        far = np.abs(x[1:] - x[:-1]) > 180  # dateline jump: never near PH/JP
        i_seg, i_g = self.tree.query(segs, predicate="intersects")
        hits: dict[int, list[int]] = {}
        for s, g in zip(i_seg, i_g, strict=True):
            if not far[s]:
                hits.setdefault(int(s), []).append(int(g))
        out = []
        for s in sorted(hits):
            if land[s] >= 0:          # segment starts on land: still over land (or lake/bay), not an entry
                continue
            start = shapely.points(x[s], lat[s])
            best: tuple[float, int, shapely.Point] | None = None
            for g in hits[s]:
                inter = shapely.intersection(segs[s], self.geoms[g])
                if inter.is_empty:
                    continue
                d = float(shapely.distance(start, inter))
                if best is None or d < best[0]:
                    p = shapely.get_coordinates(inter)
                    k = int(np.argmin(np.hypot(p[:, 0] - x[s], p[:, 1] - lat[s])))
                    best = (d, g, shapely.points(p[k, 0], p[k, 1]))
            if best is None:
                continue
            seg_len = float(shapely.length(segs[s])) or 1.0
            frac = min(max(best[0] / seg_len, 0.0), 1.0)
            at = t[s] + (t[s + 1] - t[s]) * frac
            out.append({"at": pd.Timestamp(at).tz_localize("UTC").floor("min"), "country": str(self.country[best[1]]),
                        "lon": round(float(best[2].x), 4), "lat": round(float(best[2].y), 4),
                        "place_id": str(self.ids[best[1]])})
        return out


def load_pagasa() -> pd.DataFrame:
    cw = pd.read_csv(CROSSWALK_DIR / "pagasa_names_sid.csv", dtype=str)
    cw = cw[cw.status == "matched"].copy()
    cw["season"] = cw.season.astype(int)
    cw["rank"] = (cw.origin != "seed").astype(int)
    cw = cw.sort_values(["sid", "rank"], kind="stable")
    alts = cw.groupby("sid").pagasa_name.apply(lambda s: list(dict.fromkeys(s)))
    first = cw.drop_duplicates("sid").set_index("sid")
    first["alternates"] = alts.map(lambda a: a[1:])
    return first.reset_index()[["sid", "pagasa_name", "intl_name", "season", "source_url", "origin", "alternates"]]


def load_jma() -> pd.DataFrame:
    try:
        from .jma import jma_numbers

        j = jma_numbers()
        return j[~j.match_quality.str.contains("weak|spur")][["sid", "jma_number", "jma_intl_id", "season"]] \
            .rename(columns={"season": "jma_season"})
    except Exception as e:  # pragma: no cover - degrade to no Japanese designation
        log.warning("JMA numbers unavailable: %s", e)
        return pd.DataFrame(columns=["sid", "jma_number", "jma_intl_id", "jma_season"])


def _i(v: Any) -> int | None:
    return None if v is None or pd.isna(v) else int(round(float(v)))


def build() -> dict[str, pd.DataFrame]:
    ensure_dir(OUT)
    fx = pd.read_parquet(PROCESSED / "ibtracs/fixes.parquet")
    st = pd.read_parquet(PROCESSED / "ibtracs/storms.parquet")
    places = places_mod.load()
    land = Land(places)
    cand = st[(st.season >= FIRST_SEASON) & ~st.track_type.str.contains("spur", na=False)
              & (st.entered_study_box | st.entered_par)]
    fx = fx[fx.sid.isin(cand.sid)]
    pag = load_pagasa().set_index("sid")
    jma = load_jma().set_index("sid")
    storms, fixes, landfalls, hourlies = [], [], [], []
    for sid, f in fx.groupby("sid", sort=True):
        s = st.loc[st.sid == sid].iloc[0]
        tr = hourly(f)
        lf = land.entries(tr.lon, tr.lat, tr.time)
        countries = list(dict.fromkeys(e["country"] for e in lf))
        if not (bool(s.entered_par) or countries):
            continue
        obs = f[is_observed(f.iflag)]
        if obs.empty:
            obs = f
        hf = hourly_frame(tr)
        hourlies.append(hf)
        # peaks per agency (all rows, as published)
        per = {a: (f[w].max(), f[p].min()) for a, (w, p, _) in AGENCY_COLUMNS.items()}
        peak_agency = next((a for a in PREFERRED if not pd.isna(per[a][0])), None)
        peak = {}
        if peak_agency:
            wcol = AGENCY_COLUMNS[peak_agency][0]
            r = f.loc[f[wcol].idxmax()]
            peak = {"peak_at": r.iso_time, "peak_lon": round(float(lon180(r.lon)), 4), "peak_lat": round(float(r.lat), 4)}
        min_p = per[peak_agency][1] if peak_agency and not pd.isna(per[peak_agency][1]) else \
            next((per[a][1] for a in PREFERRED if not pd.isna(per[a][1])), None)
        name_raw = str(s["name"])
        pg = pag.loc[sid] if sid in pag.index else None
        jm = jma.loc[sid] if sid in jma.index else None
        jma_no = _i(jm.jma_number) if jm is not None else None
        name_ja = f"台風第{jma_no}号" if jma_no else None
        name = display_name(name_raw)
        x = lon180(tr.lon)
        bbox = [round(float(x.min()), 3), round(float(tr.lat.min()), 3), round(float(x.max()), 3),
                round(float(tr.lat.max()), 3)]
        search = " | ".join(dict.fromkeys(v.lower() for v in [
            name, name_raw, *(([pg.pagasa_name] + list(pg.alternates)) if pg is not None else []), name_ja] if v))
        storms.append({
            "sid": sid, "season": int(s.season), "basin": str(s.basin), "number": _i(f.number.iloc[0]),
            "name": name, "name_ibtracs": name_raw, "name_pagasa": pg.pagasa_name if pg is not None else None,
            "name_pagasa_alternates": list(pg.alternates) if pg is not None else [],
            "name_ja": name_ja, "jma_number": jma_no,
            "jma_season": _i(jm.jma_season) if jm is not None else None,
            "atcf_id": s.usa_atcf_id if isinstance(s.usa_atcf_id, str) else None,
            "track_type": str(s.track_type), "started_at": obs.iso_time.min(), "ended_at": obs.iso_time.max(),
            "fix_count": int(len(obs)), "duration_h": round((obs.iso_time.max() - obs.iso_time.min()).total_seconds() / 3600, 1),
            "hours": int(len(tr)),
            "peak_wind_kt": _i(per[peak_agency][0]) if peak_agency else None, "peak_wind_agency": peak_agency,
            "peak_at": peak.get("peak_at"), "peak_lon": peak.get("peak_lon"), "peak_lat": peak.get("peak_lat"),
            "min_pressure_hpa": _i(min_p),
            "jtwc_max_wind_kt": _i(per["jtwc"][0]), "jtwc_min_pressure_hpa": _i(per["jtwc"][1]),
            "jma_max_wind_kt": _i(per["jma"][0]), "jma_min_pressure_hpa": _i(per["jma"][1]),
            "wmo_max_wind_kt": _i(per["wmo"][0]), "wmo_min_pressure_hpa": _i(per["wmo"][1]),
            "max_sshs": _i(s.max_usa_sshs), "max_jma_grade": _i(s.max_tokyo_grade),
            "entered_par": bool(s.entered_par), "landfall_countries": countries, "landfall_count": len(lf),
            "bbox": bbox, "search_text": search,
        })
        for k, e in enumerate(lf[:MAX_LANDFALLS], 1):
            landfalls.append({"sid": sid, "seq": k, **e})
        for r in obs.itertuples():
            ag = next((a for a in PREFERRED if not pd.isna(getattr(r, AGENCY_COLUMNS[a][0]))), None)
            pres = next((getattr(r, AGENCY_COLUMNS[a][1]) for a in PREFERRED
                         if not pd.isna(getattr(r, AGENCY_COLUMNS[a][1]))), None)
            grade, sshs = _i(r.tokyo_grade), _i(r.usa_sshs)
            fixes.append({
                "sid": sid, "observed_at": r.iso_time, "lon": round(float(lon180(r.lon)), 4), "lat": round(float(r.lat), 4),
                "wind_kt": _i(getattr(r, AGENCY_COLUMNS[ag][0])) if ag else None, "wind_agency": ag,
                "pressure_hpa": _i(pres), "gust_kt": _i(r.usa_gust_kt),
                "jtwc_wind_kt": _i(r.usa_wind_kt), "jtwc_pressure_hpa": _i(r.usa_pres_hpa),
                "jma_wind_kt": _i(r.tokyo_wind_kt), "jma_pressure_hpa": _i(r.tokyo_pres_hpa),
                "jma_grade": grade if grade is not None and 2 <= grade <= 9 else None,
                "sshs_category": sshs if sshs is not None and -5 <= sshs <= 5 else None,
                "nature": NATURE.get(str(r.nature)), "dist_to_land_km": _i(r.dist2land_km),
                "speed_kt": _i(r.storm_speed_kt), "direction_deg": _i(r.storm_dir_deg),
            })
    out = {
        "storms": pd.DataFrame(storms),
        "fixes": pd.DataFrame(fixes),
        "landfalls": pd.DataFrame(landfalls, columns=["sid", "seq", "at", "country", "lon", "lat", "place_id"]),
        "hourly": pd.concat(hourlies, ignore_index=True),
        "pagasa": pag.reset_index()[lambda d: d.sid.isin({s["sid"] for s in storms})],
    }
    for k, df in out.items():
        df.to_parquet(OUT / f"{k}.parquet", index=False, compression="zstd")
    summary = {"storms": len(storms), "by_country": out["storms"].landfall_countries.explode().value_counts().to_dict(),
               "entered_par": int(out["storms"].entered_par.sum()), "fixes": len(fixes),
               "hourly_points": int(len(out["hourly"])), "landfalls": len(landfalls),
               "with_pagasa_name": int(out["storms"].name_pagasa.notna().sum()),
               "with_jma_number": int(out["storms"].jma_number.notna().sum())}
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2))
    log.info("catalogue: %s", summary)
    return out


def load(name: str) -> pd.DataFrame:
    return pd.read_parquet(OUT / f"{name}.parquet")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    build()
    print((OUT / "summary.json").read_text())


if __name__ == "__main__":
    main()
