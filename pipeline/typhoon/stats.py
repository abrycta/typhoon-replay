"""Light derived statistics for the app's charts, tiles, badges and leaderboards (a few hundred kB per version).

Everything here is computed from the catalogue, hourly tracks and exposure already built; nothing is
downloaded. Written by typhoon.dataset as:

  v<N>/stats/seasons.json       per season: counts by intensity class, PH/JP landfalls, ACE, the strongest storm
  v<N>/stats/climatology.json   storms forming per month x decade (heatmap) and landfalls per month by country
  v<N>/stats/admin.json         per PH province / JP prefecture: landfalls, storms within 100 km, strongest, latest
  v<N>/stats/records.json       top-10 lists: strongest, lowest pressure, longest-lived, most ACE, fastest
                                intensification, most landfalls, farthest travelled
  summary.json `stats`          per storm: ACE, max 24 h intensification, distance, forward speed, hours in PAR and
                                over land, intensity classes (Saffir-Simpson, JMA, PAGASA)
  places/<shard>.json `summary` per place: storms within 50/100 km, strongest, most recent, storms per decade

Definitions
  ACE (accumulated cyclone energy) = 1e-4 * sum of JTWC 1-min wind^2 (kt^2) at 00/06/12/18 UTC fixes with wind >= 35 kt.
  Intensification = largest rise of the JTWC (else JMA) sustained wind over any 24 h of the hourly track;
  "rapid intensification" when >= 30 kt / 24 h (the NHC/JTWC convention).
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd
import shapely

from .config import EARTH_R_KM
from .ibtracs import PAR
from .track import lon180

SSHS = [(137, "cat5"), (113, "cat4"), (96, "cat3"), (83, "cat2"), (64, "cat1"), (34, "ts"), (0, "td")]
JMA_CLASS = [(105, "violent-typhoon"), (85, "very-strong-typhoon"), (64, "typhoon"), (48, "severe-tropical-storm"),
             (34, "tropical-storm"), (0, "tropical-depression")]
# PAGASA (since 2022, 10-minute winds): super typhoon >= 185 km/h (100 kt), typhoon >= 118 km/h (64 kt)
PAGASA_CLASS = [(100, "super-typhoon"), (64, "typhoon"), (48, "severe-tropical-storm"), (34, "tropical-storm"),
                (0, "tropical-depression")]
RI_KT_24H = 30


def classify(kt: float | None, table: list[tuple[int, str]]) -> str | None:
    if kt is None or not np.isfinite(kt):
        return None
    return next(label for lim, label in table if kt >= lim)


def _f(v: Any) -> float | None:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def ace(fixes: pd.DataFrame) -> float:
    t = pd.to_datetime(fixes.observed_at, utc=True)
    w = fixes.jtwc_wind_kt.astype(float)
    m = (t.dt.hour % 6 == 0) & (t.dt.minute == 0) & (w >= 35)
    return round(float((w[m] ** 2).sum()) / 1e4, 2)


def max_intensification(hourly: pd.DataFrame) -> tuple[float | None, str | None]:
    """Largest 24 h rise of the JTWC (else JMA) wind on the hourly track, and when the 24 h window ended."""
    for col in ("jtwc_wind_kt", "jma_wind_kt"):
        w = hourly[col].to_numpy(float)
        if np.isfinite(w).sum() > 24:
            d = w[24:] - w[:-24]
            if np.isfinite(d).any():
                i = int(np.nanargmax(d))
                return round(float(d[i]), 1), pd.Timestamp(hourly.time.iloc[i + 24]).strftime("%Y-%m-%dT%H:%M:%SZ")
    return None, None


def distance_km(lat: np.ndarray, lon: np.ndarray) -> float:
    if len(lat) < 2:
        return 0.0
    p1, p2 = np.radians(lat[:-1]), np.radians(lat[1:])
    dl = np.radians(np.diff(lon))
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return float(2 * EARTH_R_KM * np.arcsin(np.sqrt(np.clip(a, 0, 1))).sum())


def storm_stats(storms: pd.DataFrame, fixes: pd.DataFrame, hourly: pd.DataFrame, land_tree: Any) -> dict[str, dict[str, Any]]:
    fx_by = dict(tuple(fixes.groupby("sid")))
    out: dict[str, dict[str, Any]] = {}
    for sid, h in hourly.sort_values(["sid", "time"]).groupby("sid"):
        lat, lon = h.lat.to_numpy(float), h.lon.to_numpy(float)
        x = lon180(lon)
        in_par = shapely.contains_xy(PAR, x, lat)
        over_land = np.zeros(len(h), bool)
        if land_tree is not None:
            i_pt, _ = land_tree.query(shapely.points(x, lat), predicate="intersects")
            over_land[np.unique(i_pt)] = True
        dist = distance_km(lat, lon)
        hours = max(len(h) - 1, 1)
        ri, ri_at = max_intensification(h)
        s = storms.loc[sid]
        jtwc, jma = _f(s.jtwc_max_wind_kt), _f(s.jma_max_wind_kt)
        out[sid] = {k: v for k, v in {
            "ace": ace(fx_by[sid]) if sid in fx_by else None,
            "maxIntensification24hKt": ri, "maxIntensificationEndedAt": ri_at,
            "rapidIntensification": (ri is not None and ri >= RI_KT_24H) or None,
            "distanceKm": round(dist), "meanForwardSpeedKmh": round(dist / hours, 1),
            "hoursInPar": int(in_par.sum()), "hoursOverLand": int(over_land.sum()),
            "saffirSimpson": classify(jtwc, SSHS), "jmaClass": classify(jma, JMA_CLASS),
            "pagasaClass": classify(jma, PAGASA_CLASS) if bool(s.entered_par) else None,
        }.items() if v is not None}
    return out


def seasons(storms: pd.DataFrame, st_stats: dict[str, dict[str, Any]], landfalls: pd.DataFrame) -> list[dict[str, Any]]:
    lf = landfalls.drop_duplicates(["sid", "country"])
    rows = []
    for season, g in storms.groupby("season"):
        peak = g.peak_wind_kt.astype(float)
        strongest = g.loc[peak.idxmax()] if peak.notna().any() else None
        ids = set(g.index)
        rows.append({k: v for k, v in {
            "season": int(season), "storms": len(g),
            "named": int((~g.name.str.startswith("Unnamed")).sum()),
            "pagasaNamed": int(g.name_pagasa.notna().sum()),
            "typhoons": int((peak >= 64).sum()), "superTyphoons": int((g.jtwc_max_wind_kt.astype(float) >= 130).sum()),
            "landfallsPH": int(((lf.sid.isin(ids)) & (lf.country == "PH")).sum()),
            "landfallsJP": int(((lf.sid.isin(ids)) & (lf.country == "JP")).sum()),
            "ace": round(sum(st_stats.get(s, {}).get("ace", 0) for s in ids), 1),
            "strongest": None if strongest is None else
            {"sid": strongest.name, "name": strongest["name"], "peakWindKt": int(strongest.peak_wind_kt),
             "agency": strongest.peak_wind_agency},
        }.items() if v is not None})
    return rows


def climatology(storms: pd.DataFrame, landfalls: pd.DataFrame) -> dict[str, Any]:
    t = pd.to_datetime(storms.started_at, utc=True)
    decade = (storms.season // 10 * 10).astype(int)
    mat = pd.crosstab(decade, t.dt.month).reindex(columns=range(1, 13), fill_value=0)
    lt = pd.to_datetime(landfalls.drop_duplicates(["sid", "country"])["at"], utc=True)
    lm = pd.crosstab(landfalls.drop_duplicates(["sid", "country"]).country, lt.dt.month).reindex(
        columns=range(1, 13), fill_value=0)
    return {
        "note": "Storms by month of first best-track fix and decade; landfalls (storms, not crossings) by month.",
        "months": list(range(1, 13)),
        "formationByDecade": {"decades": [int(d) for d in mat.index], "counts": mat.to_numpy().tolist()},
        "landfallsByMonth": {c: lm.loc[c].tolist() for c in lm.index},
    }


def admin(places: pd.DataFrame, exposure: pd.DataFrame, landfalls: pd.DataFrame, storms: pd.DataFrame) -> list[dict[str, Any]]:
    shard = places.set_index("place_id").shard
    pl1 = places.drop_duplicates("shard").set_index("shard")
    ex = exposure[exposure.closest_approach_km <= 100].assign(shard=lambda d: d.place_id.map(shard))
    lf = landfalls.assign(shard=lambda d: d.place_id.map(shard))
    out = []
    for sh, g in ex.groupby("shard"):
        per_storm = g.groupby("sid").max_wind_kt_r100.max()
        strongest = per_storm.astype(float).idxmax() if per_storm.notna().any() else None
        latest = storms.loc[list(per_storm.index)].started_at.idxmax()
        out.append({k: v for k, v in {
            "shard": sh, "country": pl1.loc[sh, "country"], "admin1": pl1.loc[sh, "admin1"],
            "admin2": pl1.loc[sh, "admin2"] if isinstance(pl1.loc[sh, "admin2"], str) else None,
            "places": int((places.shard == sh).sum()),
            "stormsWithin100Km": len(per_storm),
            "landfalls": int(lf[lf.shard == sh].drop_duplicates("sid").shape[0]),
            "strongest": None if strongest is None else {
                "sid": strongest, "name": storms.loc[strongest, "name"], "season": int(storms.loc[strongest, "season"]),
                "maxWindKt": int(per_storm[strongest])},
            "latest": {"sid": latest, "name": storms.loc[latest, "name"], "season": int(storms.loc[latest, "season"])},
        }.items() if v is not None})
    return out


def records(storms: pd.DataFrame, st_stats: dict[str, dict[str, Any]], n: int = 10) -> dict[str, list[dict[str, Any]]]:
    s = storms.copy()
    for k in ("ace", "maxIntensification24hKt", "distanceKm"):
        s[k] = [st_stats.get(i, {}).get(k) for i in s.index]
    s["landfall_count"] = s.landfall_count.astype(int)

    def top(col: str, asc: bool = False, unit: str = "") -> list[dict[str, Any]]:
        v = s[col].astype(float).dropna().sort_values(ascending=asc).head(n)
        return [{"sid": i, "name": s.loc[i, "name"], "season": int(s.loc[i, "season"]),
                 "value": int(x) if float(x).is_integer() else round(float(x), 1), "unit": unit} for i, x in v.items()]

    return {
        "strongestJtwc": top("jtwc_max_wind_kt", unit="kt (JTWC 1-min)"),
        "strongestJma": top("jma_max_wind_kt", unit="kt (JMA 10-min)"),
        "lowestPressure": top("min_pressure_hpa", asc=True, unit="hPa"),
        "longestLived": top("duration_h", unit="h"),
        "mostAce": top("ace", unit="ACE"),
        "fastestIntensification": top("maxIntensification24hKt", unit="kt / 24 h"),
        "mostLandfalls": top("landfall_count", unit="landfalls"),
        "farthestTravelled": top("distanceKm", unit="km"),
    }


def place_summaries(exposure: pd.DataFrame, storms: pd.DataFrame) -> dict[str, dict[str, Any]]:
    e = exposure[exposure.closest_approach_km <= 100].copy()
    e["decade"] = (e.season // 10 * 10).astype(int)
    decades = list(range(1940, int(storms.season.max()) // 10 * 10 + 10, 10))
    started = storms.started_at
    out = {}
    for pid, g in e.groupby("place_id"):
        w = g.max_wind_kt_r100.astype(float)
        strongest = g.loc[w.idxmax()] if w.notna().any() else None
        latest = g.loc[g.sid.map(started).idxmax()]
        counts = g.groupby("decade").size()
        out[pid] = {k: v for k, v in {
            "stormsWithin100Km": len(g), "stormsWithin50Km": int((g.closest_approach_km <= 50).sum()),
            "strongest": None if strongest is None else {"sid": strongest.sid, "maxWindKt": int(strongest.max_wind_kt_r100),
                                                          "km": float(strongest.closest_approach_km)},
            "latest": {"sid": latest.sid, "at": pd.Timestamp(latest.closest_approach_at).strftime("%Y-%m-%dT%H:%M:%SZ"),
                       "km": float(latest.closest_approach_km)},
            "perDecade": {"decades": decades, "counts": [int(counts.get(d, 0)) for d in decades]},
        }.items() if v is not None}
    return out
