"""Open Graph images (1200 x 630 PNG) per storm: best track over the coastline, name and peak.

Rendered in the pipeline (web/docs/ARCHITECTURE-RESEARCH.md: OG images ship with the data, not the app).
"""
from __future__ import annotations

import io
import json
import math
from functools import lru_cache
from typing import Any

import numpy as np
import shapely
from PIL import Image, ImageDraw, ImageFont
from shapely.geometry import shape

from . import sources

W, H = 1200, 630
BG = (14, 20, 31)
LAND = (52, 64, 82)
TEXT = (236, 240, 245)
MUTED = (150, 162, 178)
# Saffir-Simpson-like colours by sustained wind (kt), for the track
STEPS = [(34, (120, 170, 220)), (64, (110, 200, 150)), (83, (240, 210, 90)), (96, (245, 160, 70)),
         (113, (235, 100, 70)), (137, (200, 60, 130)), (999, (150, 70, 200))]


def colour(kt: float) -> tuple[int, int, int]:
    if not np.isfinite(kt):
        return MUTED
    for lim, c in STEPS:
        if kt < lim:
            return c
    return STEPS[-1][1]


@lru_cache(maxsize=1)
def coast() -> list[np.ndarray]:
    gj = json.loads(sources.ensure("naturalearth-50m-coastline").read_text())
    lines = []
    for f in gj["features"]:
        g = shape(f["geometry"])
        for part in getattr(g, "geoms", [g]):
            c = np.asarray(part.coords)
            c[:, 0] = c[:, 0] % 360
            # split where the line wraps across 0/360
            cut = np.flatnonzero(np.abs(np.diff(c[:, 0])) > 180) + 1
            lines.extend(np.split(c, cut))
    return lines


@lru_cache(maxsize=1)
def land_polys() -> list[np.ndarray]:
    gj = json.loads(sources.ensure("naturalearth-50m-countries").read_text())
    polys = []
    for f in gj["features"]:
        g = shape(f["geometry"])
        for p in getattr(g, "geoms", [g]):
            c = np.asarray(shapely.get_coordinates(p.exterior))
            c[:, 0] = c[:, 0] % 360
            if np.ptp(c[:, 0]) < 180:
                polys.append(c)
    return polys


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for name in ("DejaVuSans-Bold.ttf", "Arial Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def render(storm: dict[str, Any], lon: np.ndarray, lat: np.ndarray, wind: np.ndarray) -> bytes:
    lon = np.asarray(lon) % 360
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    # map panel on the right: 630 x 630, track bbox padded, equirectangular with cos(lat) aspect
    mx0, mw = 520, 680
    lo0, lo1, la0, la1 = lon.min(), lon.max(), lat.min(), lat.max()
    cx, cy = (lo0 + lo1) / 2, (la0 + la1) / 2
    k = math.cos(math.radians(cy))
    span = max((lo1 - lo0) * k / mw, (la1 - la0) / H) * 1.25 + 1e-6
    span = max(span, 12 / H)

    def px(x: np.ndarray, y: np.ndarray) -> list[tuple[float, float]]:
        return list(zip(mx0 + mw / 2 + (x - cx) * k / span, H / 2 - (y - cy) / span, strict=True))

    for c in land_polys():
        if c[:, 0].max() < cx - 60 or c[:, 0].min() > cx + 60:
            continue
        pts = px(c[:, 0], c[:, 1])
        if len(pts) > 2:
            d.polygon(pts, fill=LAND)
    pts = px(lon, lat)
    for i in range(len(pts) - 1):
        d.line([pts[i], pts[i + 1]], fill=colour(float(wind[i])), width=6)
    d.rectangle([0, 0, mx0, H], fill=BG)
    name = storm["name"]
    sub = storm.get("name_pagasa")
    d.text((48, 60), "TYPHOON REPLAY", font=font(26), fill=MUTED)
    d.text((48, 120), name, font=font(84 if len(name) < 10 else 60), fill=TEXT)
    y = 230
    if isinstance(sub, str) and sub:
        d.text((48, y), f"PAGASA: {sub}", font=font(36), fill=TEXT)
        y += 56
    d.text((48, y), str(storm["season"]), font=font(40), fill=MUTED)
    y += 80
    pk = storm.get("peak_wind_kt")
    if pk is not None and np.isfinite(float(pk)):
        ag = {"jtwc": "JTWC 1-min", "jma": "JMA 10-min", "wmo": "WMO"}.get(str(storm.get("peak_wind_agency")), "")
        d.text((48, y), f"Peak {int(pk)} kt", font=font(44), fill=TEXT)
        d.text((48, y + 56), ag, font=font(26), fill=MUTED)
        y += 110
    lf = storm.get("landfall_countries")
    if lf is not None and len(lf):
        d.text((48, y), "Landfall: " + ", ".join({"PH": "Philippines", "JP": "Japan"}[c] for c in lf),
               font=font(28), fill=TEXT)
    d.text((48, H - 48), "Best track: IBTrACS (NOAA NCEI) · Natural Earth", font=font(18), fill=MUTED)
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
