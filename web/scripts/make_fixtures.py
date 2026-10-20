"""Build the small fixture dataset in web/fixtures/ from the data spike's output.

The fixture follows the layout the frontend expects from the published Hugging Face dataset (see
web/docs/DATA-LAYOUT.md), so the app, the e2e tests and the deployed site work before data v1 lands:

    latest.json                         {"version": 1, "path": "v1/"}
    v1/manifest.json                    dataset version, "data as of", sources and licences
    v1/index.json                       catalogue: one StormSummary-like row per storm
    v1/storms/<sid>/summary.json        StormDetail-like record + frames manifest + affected places
    v1/storms/<sid>/track.json          best-track fixes (observed only; the app interpolates hourly)
    v1/storms/<sid>/frames.tyf          quantised ERA5 frames (TYF1), only where the spike produced them
    v1/storms/<sid>/og.png              1200x630 share image (track over coastline)

Real data only: IBTrACS v04r01 best tracks, the PAGASA crosswalk, and Haiyan's ERA5 frames from the spike,
cropped to 72 hours around landfall to keep the repo small. Places are the 10 fixture places of the contract
seed (contracts/db/seed/20_places.sql), whose boundaries are stand-ins.

Usage (from web/): npm run fixtures -- --data /path/to/data/processed
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import struct
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from PIL import Image, ImageDraw

WEB = Path(__file__).resolve().parents[1]
REPO = WEB.parent
OUT = WEB / "fixtures"
VERSION = 1

# Notable PH/JP storms (IBTrACS SIDs). JMA numbers (台風第N号) are given only where well established;
# the pipeline owns the real crosswalk for these.
STORMS = {
    "2013306N07162": {"ja": "平成25年台風第30号"},  # Haiyan / Yolanda
    "2021346N05145": {"ja": "令和3年台風第22号"},  # Rai / Odette
    "2019278N16165": {"ja": "令和元年東日本台風（台風第19号）"},  # Hagibis
    "2018250N12170": {"ja": "平成30年台風第22号"},  # Mangkhut / Ompong
    "2020299N11144": {"ja": "令和2年台風第19号"},  # Goni / Rolly
    "2012331N03157": {"ja": "平成24年台風第24号"},  # Bopha / Pablo
    "2009268N14128": {"ja": "平成21年台風第16号"},  # Ketsana / Ondoy
    "2018239N11161": {"ja": "平成30年台風第21号"},  # Jebi
    "2019242N14180": {"ja": "令和元年房総半島台風（台風第15号）"},  # Faxai
    "2006329N06150": {"ja": "平成18年台風第21号"},  # Durian / Reming
    "2010285N13145": {"ja": "平成22年台風第13号"},  # Megi / Juan
    "2022264N17132": {"ja": "令和4年台風第16号"},  # Noru / Karding
    "2022254N24143": {"ja": "令和4年台風第14号"},  # Nanmadol
    "1959263N11160": {"ja": "伊勢湾台風（昭和34年台風第15号）"},  # Vera
    "1958263N13148": {"ja": "狩野川台風（昭和33年台風第22号）"},  # Ida
    "1990310N07152": {"ja": "平成2年台風第25号"},  # Mike / Ruping
}
HERO = "2013306N07162"
CROP = ("2013-11-06T00:00:00Z", 72)  # Haiyan frames: 72 hours from 6 Nov 00 UTC (landfall 7 Nov 20:40 UTC)

PLACES = [  # contracts/db/seed/20_places.sql (codes real, boundaries stand-ins)
    ("PH-0831600000", "PH", "city", "Tacloban City", None, "Eastern Visayas", None, "Leyte", 125.0039, 11.2433),
    ("PH-0802616000", "PH", "municipality", "Guiuan", None, "Eastern Visayas", None, "Eastern Samar", 125.7247, 11.0333),
    ("PH-0803738000", "PH", "city", "Ormoc City", None, "Eastern Visayas", None, "Leyte", 124.6075, 11.0064),
    ("PH-0502011000", "PH", "municipality", "Virac", None, "Bicol Region", None, "Catanduanes", 124.2306, 13.5800),
    ("PH-1380600000", "PH", "city", "City of Manila", None, "National Capital Region", None, None, 120.9842, 14.5995),
    ("JP-47201", "JP", "city", "Naha", "那覇市", "Okinawa", "沖縄県", None, 127.6809, 26.2124),
    ("JP-47207", "JP", "city", "Ishigaki", "石垣市", "Okinawa", "沖縄県", None, 124.1557, 24.3448),
    ("JP-46201", "JP", "city", "Kagoshima", "鹿児島市", "Kagoshima", "鹿児島県", None, 130.5571, 31.5966),
    ("JP-27100", "JP", "city", "Osaka", "大阪市", "Osaka", "大阪府", None, 135.5023, 34.6937),
    ("JP-13101", "JP", "special-ward", "Chiyoda", "千代田区", "Tokyo", "東京都", None, 139.7536, 35.6940),
]
RADIUS_KM = 200

SOURCES = [
    {"id": "ibtracs", "name": "IBTrACS v04r01 (NOAA NCEI)", "url": "https://www.ncei.noaa.gov/products/international-best-track-archive",
     "license": "Public domain (NOAA)", "attribution": "Knapp et al. (2010), IBTrACS v04r01, NOAA NCEI"},
    {"id": "era5", "name": "ERA5 hourly single levels (Copernicus C3S)", "url": "https://cds.climate.copernicus.eu/",
     "license": "CC BY 4.0", "attribution": "Contains modified Copernicus Climate Change Service information (ERA5)"},
    {"id": "pagasa-names", "name": "PAGASA local names via Wikipedia", "url": "https://en.wikipedia.org/wiki/List_of_retired_Philippine_typhoon_names",
     "license": "CC BY-SA 4.0", "attribution": "Wikipedia contributors"},
    {"id": "natural-earth", "name": "Natural Earth 50m coastline", "url": "https://www.naturalearthdata.com/",
     "license": "Public domain", "attribution": "Made with Natural Earth"},
]


def iso(t) -> str:
    return pd.Timestamp(t).tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ") if pd.Timestamp(t).tzinfo else pd.Timestamp(t).strftime("%Y-%m-%dT%H:%M:%SZ")


def lon180(lon: float) -> float:
    x = ((lon + 180) % 360) - 180
    return 180.0 if x == -180 else round(x, 4)


def num(v):
    return None if v is None or (isinstance(v, float) and math.isnan(v)) or pd.isna(v) else float(v)


def haversine_km(lon1, lat1, lon2, lat2):
    r = 6371.0088
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp, dl = p2 - p1, np.radians(lon2 - lon1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * r * np.arcsin(np.sqrt(a))


def title(name: str) -> str:
    return "Unnamed" if name in ("UNNAMED", "NOT_NAMED", "") else name.title()


def hourly(fx: pd.DataFrame) -> pd.DataFrame:
    """Linear hourly interpolation of position and intensity (only to compute place exposure here)."""
    t = pd.Series([int(x.timestamp()) for x in fx.iso_time])
    hours = np.arange(t.iloc[0], t.iloc[-1] + 1, 3600)
    lon = np.unwrap(np.radians(fx.lon.values % 360))
    out = {"t": hours, "lat": np.interp(hours, t, fx.lat), "lon": np.degrees(np.interp(hours, t, lon)) % 360}
    for c in ("usa_wind_kt", "tokyo_wind_kt", "usa_gust_kt"):
        v = fx[c].astype(float)
        ok = v.notna().values
        out[c] = np.interp(hours, t[ok], v[ok]) if ok.sum() >= 2 else np.full(len(hours), np.nan)
    return pd.DataFrame(out)


def exposure(h: pd.DataFrame) -> list[dict]:
    hits = []
    for pid, country, kind, name, name_ja, a1, a1ja, a2, plon, plat in PLACES:
        d = haversine_km(h.lon.values, h.lat.values, plon % 360, plat)
        within = d <= RADIUS_KM
        if not within.any():
            continue
        i = int(d.argmin())
        place = {"id": pid, "country": country, "kind": kind, "name": name, "admin1": a1, "centroid": [plon, plat]}
        if name_ja:
            place["nameJa"] = name_ja
        if a1ja:
            place["admin1Ja"] = a1ja
        if a2:
            place["admin2"] = a2
        hit = {"place": place, "closestApproachKm": round(float(d[i]), 1),
               "closestApproachAt": datetime.fromtimestamp(int(h.t[i]), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
               "hoursWithinRadius": int(within.sum())}
        w = np.nanmax(np.where(within, np.fmax(h.usa_wind_kt.values, h.tokyo_wind_kt.values), np.nan))
        if np.isfinite(w):
            hit["maxWindKtWithinRadius"] = round(float(w))
        g = np.nanmax(np.where(within, h.usa_gust_kt.values, np.nan)) if h.usa_gust_kt.notna().any() else np.nan
        if np.isfinite(g):
            hit["maxGustKtWithinRadius"] = round(float(g))
        hits.append(hit)
    return sorted(hits, key=lambda x: (x["closestApproachKm"], x["place"]["id"]))


def crop_tyf(src: Path, start_iso: str, n: int) -> tuple[bytes, dict]:
    b = src.read_bytes()
    hlen = struct.unpack("<I", b[4:8])[0]
    h = json.loads(b[8:8 + hlen])
    start = int(pd.Timestamp(start_iso).timestamp())
    i0 = h["time"].index(start)
    fsz = len(h["vars"]) * h["ny"] * h["nx"]
    data = b[8 + hlen + i0 * fsz: 8 + hlen + (i0 + n) * fsz]
    h.update(frames=n, time=h["time"][i0:i0 + n], nw_lat=h["nw_lat"][i0:i0 + n], nw_lon=h["nw_lon"][i0:i0 + n],
             note=f"fixture: frames {i0}..{i0 + n - 1} of {len(h['time'])} from the data spike")
    hb = json.dumps(h, separators=(",", ":"), ensure_ascii=False).encode()
    hb += b" " * ((-(8 + len(hb))) % 8)
    return b"TYF1" + len(hb).to_bytes(4, "little") + hb + data, h


def og_image(path: Path, coast: list, fixes: pd.DataFrame):
    W, H = 1200, 630
    lon = fixes.lon.values % 360
    lat = fixes.lat.values
    cx, cy = (lon.min() + lon.max()) / 2, (lat.min() + lat.max()) / 2
    span = max(lon.max() - lon.min(), (lat.max() - lat.min()) * W / H, 12) * 1.25
    sx = W / span
    X = lambda x: (x - cx) * sx + W / 2
    Y = lambda y: H / 2 - (y - cy) * sx
    im = Image.new("RGB", (W, H), "#f6f5f1")
    d = ImageDraw.Draw(im)
    for line in coast:
        d.line([(X(a), Y(b)) for a, b in line], fill="#a8a69e", width=2)
    pts = [(X(a), Y(b)) for a, b in zip(lon, lat)]
    d.line(pts, fill="#23467a", width=6, joint="curve")
    peak = int(np.nanargmax(fixes.usa_wind_kt.fillna(fixes.tokyo_wind_kt).fillna(0).values))
    px, py = pts[peak]
    d.ellipse([px - 14, py - 14, px + 14, py + 14], fill="#c0392b")
    d.rectangle([0, H - 16, W, H], fill="#23467a")
    im.save(path, optimize=True)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=REPO / "data/processed", help="spike output (data/processed)")
    a = ap.parse_args(argv)
    storms = pd.read_parquet(a.data / "ibtracs/storms.parquet").set_index("sid")
    fixes = pd.read_parquet(a.data / "ibtracs/fixes.parquet", filters=[("sid", "in", list(STORMS))])
    pagasa = {r["sid"]: r["pagasa_name"] for r in csv.DictReader(open(REPO / "pipeline/crosswalk/pagasa_names_sid.csv")) if r["sid"]}
    coast = json.loads((a.data / "frames/coast.json").read_text())
    report = json.loads((a.data / f"frames/{HERO}_report.json").read_text())

    root = OUT / f"v{VERSION}"
    index = []
    for sid, extra in STORMS.items():
        st = storms.loc[sid]
        fx = fixes[fixes.sid == sid].sort_values("iso_time").reset_index(drop=True)
        fx = fx[fx.track_type == "main"] if (fx.track_type == "main").any() else fx
        local = {k: v for k, v in {"ph": pagasa.get(sid), "ja": extra.get("ja")}.items() if v}
        landfalls = []
        for country, col, flag in (("PH", "first_ph_landfall_time", "seg_hits_ph"), ("JP", "first_jp_landfall_time", "seg_hits_jp")):
            if pd.notna(st[col]):
                r = fx.iloc[int((fx.iso_time - st[col]).abs().argmin())]
                landfalls.append({"country": country, "at": iso(st[col]), "position": [lon180(r.lon), round(float(r.lat), 4)]})
        intensity = []
        if pd.notna(st.max_usa_wind_kt):
            it = {"agency": "jtwc", "windAveragingMinutes": 1, "maxWindKt": float(st.max_usa_wind_kt)}
            if pd.notna(st.min_usa_pres_hpa):
                it["minPressureHpa"] = float(st.min_usa_pres_hpa)
            intensity.append(it)
        if pd.notna(st.max_tokyo_wind_kt) or pd.notna(st.min_tokyo_pres_hpa):
            it = {"agency": "jma", "windAveragingMinutes": 10}
            if pd.notna(st.max_tokyo_wind_kt):
                it["maxWindKt"] = float(st.max_tokyo_wind_kt)
            if pd.notna(st.min_tokyo_pres_hpa):
                it["minPressureHpa"] = float(st.min_tokyo_pres_hpa)
            intensity.append(it)
        peak_agency = "jtwc" if pd.notna(st.max_usa_wind_kt) else "jma"
        peak_kt = num(st.max_usa_wind_kt) if peak_agency == "jtwc" else num(st.max_tokyo_wind_kt)
        # The spike's segment test flags the antimeridian-crossing segment (179.6 -> 180.1 E) of Faxai 2019 as
        # crossing the Philippines; ignore segment hits far outside the country (reported to the pipeline).
        box = {"seg_hits_ph": (112, 132), "seg_hits_jp": (118, 150)}
        countries = [c for c, f, col_over, col_seg in (("PH", st.landfall_ph, "over_ph", "seg_hits_ph"),
                                                       ("JP", st.landfall_jp, "over_jp", "seg_hits_jp"))
                     if f and (fx[col_over].any() or (fx[col_seg].values & fx.lon.between(*box[col_seg]).values).any())]
        landfalls = [lf for lf in landfalls if lf["country"] in countries]
        summary_row = {
            "sid": sid, "name": title(st["name"]), "season": int(st.season), "basin": st.basin,
            "startedAt": iso(fx.iso_time.iloc[0]), "endedAt": iso(fx.iso_time.iloc[-1]), "landfallCountries": countries,
        }
        if local:
            summary_row["localNames"] = local
        if peak_kt is not None:
            summary_row.update(peakWindKt=peak_kt, peakWindAgency=peak_agency)
        mp = num(st.min_tokyo_pres_hpa) or num(st.min_usa_pres_hpa)
        if mp is not None:
            summary_row["minPressureHpa"] = mp

        sdir = root / "storms" / sid
        sdir.mkdir(parents=True, exist_ok=True)
        track = {"sid": sid, "name": summary_row["name"],
                 "agencies": {"jtwc": {"windAveragingMinutes": 1}, "jma": {"windAveragingMinutes": 10}},
                 "fixes": []}
        for r in fx.itertuples():
            f = {"t": iso(r.iso_time), "lon": lon180(r.lon), "lat": round(float(r.lat), 4)}
            for key, val in (("jtwcKt", r.usa_wind_kt), ("jtwcHpa", r.usa_pres_hpa), ("jmaKt", r.tokyo_wind_kt), ("jmaHpa", r.tokyo_pres_hpa)):
                if pd.notna(val):
                    f[key] = float(val)
            if r.over_ph or r.over_jp:
                f["overLand"] = True
            track["fixes"].append(f)
        (sdir / "track.json").write_text(json.dumps(track, separators=(",", ":"), ensure_ascii=False))
        og_image(sdir / "og.png", coast, fx)

        detail = {**summary_row, "atcfId": st.usa_atcf_id if isinstance(st.usa_atcf_id, str) else None,
                  "durationHours": float(st.duration_h), "fixCount": int(len(fx)),
                  "peak": {k: v for k, v in {"windKt": peak_kt, "agency": peak_agency, "pressureHpa": mp,
                                             "at": iso(st.peak_time.tz_localize("UTC")) if pd.notna(st.peak_time) else None,
                                             "position": [lon180(st.peak_lon), round(float(st.peak_lat), 4)]}.items() if v is not None},
                  "intensity": intensity, "landfalls": landfalls,
                  "sources": [{k: s[k] for k in ("id", "name", "url", "license")} for s in SOURCES[:1]],
                  "replayAvailable": False, "ogImage": "og.png",
                  "affectedRadiusKm": RADIUS_KM, "affectedPlaces": exposure(hourly(fx))}
        detail = {k: v for k, v in detail.items() if v is not None}
        detail.pop("peakWindKt", None), detail.pop("peakWindAgency", None), detail.pop("minPressureHpa", None)

        if sid == HERO:
            blob, h = crop_tyf(a.data / f"frames/{HERO}.tyf", *CROP)
            (sdir / "frames.tyf").write_bytes(blob)
            cc = report["cross_check"]
            detail.update(replayAvailable=True, frames={
                "format": "tyf", "path": "frames.tyf", "bytes": len(blob), "frames": h["frames"],
                "start": iso(pd.Timestamp(h["time"][0], unit="s", tz="UTC")),
                "end": iso(pd.Timestamp(h["time"][-1], unit="s", tz="UTC")),
                "vars": [v["name"] for v in h["vars"]], "resDeg": h["res_deg"], "nx": h["nx"], "ny": h["ny"],
                "sha256": hashlib.sha256(blob).hexdigest(),
            }, reanalysisCheck={
                "radiusDeg": cc["radius_deg"], "peakTime": iso(pd.Timestamp(cc["peak_time"]).tz_localize("UTC")),
                "atPeak": {"jtwcMs": cc["at_usa_peak"]["usa_1min_ms"], "jmaMs": cc["at_usa_peak"]["jma_10min_ms"],
                           "era5WindMs": cc["at_usa_peak"]["era5_wind_ms"], "era5GustMs": cc["at_usa_peak"]["era5_gust_ms"],
                           "ratioToJtwc": cc["at_usa_peak"]["ratio_era5_to_usa"], "ratioToJma": cc["at_usa_peak"]["ratio_era5_to_jma"],
                           "era5MslpMinHpa": cc["at_usa_peak"]["era5_mslp_min"], "jmaPressureHpa": cc["at_usa_peak"]["jma_pres"]},
                "typhoonHoursMedianRatioToJtwc": cc["typhoon_hours_median_ratio_to_usa"],
                "typhoonHoursMedianRatioToJma": cc["typhoon_hours_median_ratio_to_jma"],
            }, sources=[{k: s[k] for k in ("id", "name", "url", "license")} for s in SOURCES[:2]])
        (sdir / "summary.json").write_text(json.dumps(detail, indent=1, ensure_ascii=False))
        index.append({**summary_row, "replayAvailable": detail["replayAvailable"],
                      **({"frameCount": detail["frames"]["frames"]} if "frames" in detail else {})})

    index.sort(key=lambda s: (-s["season"], s["sid"]))
    (root / "index.json").write_text(json.dumps({"version": VERSION, "storms": index}, indent=1, ensure_ascii=False))
    manifest = {
        "datasetVersion": VERSION, "dataAsOf": "2026-10-20", "generatedAt": "2026-10-21T00:00:00Z", "fixture": True,
        "note": "Fixture: 16 storms with real IBTrACS tracks; ERA5 frames only for Haiyan (72 h around landfall).",
        "storms": len(index), "stormsWithFrames": sum(1 for s in index if s["replayAvailable"]),
        "sources": SOURCES,
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
    (OUT / "latest.json").write_text(json.dumps({"version": VERSION, "path": f"v{VERSION}/"}) + "\n")

    # Fallback basemap for the app (Natural Earth 50 m coastline, public domain), lon normalised to (-180, 180].
    lines = [[[lon180(x), y] for x, y in line] for line in coast]
    fc = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {},
          "geometry": {"type": "MultiLineString", "coordinates": lines}}]}
    (WEB / "public/basemap").mkdir(parents=True, exist_ok=True)
    (WEB / "public/basemap/coast.geojson").write_text(json.dumps(fc, separators=(",", ":")))
    og_image(WEB / "public/og-default.png", coast, fixes[fixes.sid == HERO].sort_values("iso_time"))
    print(f"wrote {len(index)} storms to {root}")


if __name__ == "__main__":
    main()
