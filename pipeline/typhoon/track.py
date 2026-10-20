"""Hourly storm tracks interpolated from IBTrACS, with provenance flags.

IBTrACS rows are 3-hourly (6-hourly agency fixes plus IBTrACS's own interpolation, flagged `P` in IFLAG)
with extra landfall fixes. The replay and the exposure tables need one point per hour, so positions and
each agency's intensity are interpolated linearly in time here, once, and every hour says whether it sits
on an observed (`O`) best-track fix or between two of them.

Longitudes stay 0..360 (continuous across the dateline) internally; writers convert to (-180, 180].
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

AGENCY_COLUMNS = {  # agency -> (wind column, pressure column, wind averaging minutes)
    "jtwc": ("usa_wind_kt", "usa_pres_hpa", 1),
    "jma": ("tokyo_wind_kt", "tokyo_pres_hpa", 10),
    "wmo": ("wmo_wind_kt", "wmo_pres_hpa", 10),
}
PREFERRED = ("jtwc", "jma", "wmo")   # the contract's peak_wind_agency order


def lon180(lon: Any) -> Any:
    """Longitudes 0..360 -> (-180, 180]; arrays stay arrays, scalars stay scalars."""
    if isinstance(lon, (np.ndarray, pd.Series)):
        a = np.asarray(lon, dtype=float)
        return np.where(a > 180, a - 360, a)
    return lon - 360 if lon > 180 else lon


def is_observed(iflag: pd.Series) -> pd.Series:
    """An original (not interpolated) best-track fix from at least one agency."""
    return iflag.fillna("").str.contains("O")


@dataclass
class HourlyTrack:
    sid: str
    time: np.ndarray            # datetime64[s] UTC, hourly
    lat: np.ndarray
    lon: np.ndarray             # 0..360
    wind: dict[str, np.ndarray]  # agency -> kt (nan when not reported)
    pres: dict[str, np.ndarray]
    gust_kt: np.ndarray          # JTWC gust (sparse)
    observed: np.ndarray         # bool: an observed fix at exactly this hour
    prev_fix: np.ndarray         # datetime64[s] of the observed fix at or before this hour (NaT if none)
    next_fix: np.ndarray

    def __len__(self) -> int:
        return len(self.time)

    def preferred_wind(self) -> tuple[np.ndarray, np.ndarray]:
        """Per hour: wind (kt) from the first agency in PREFERRED that has a value, and that agency."""
        w = np.full(len(self), np.nan)
        ag = np.full(len(self), "", dtype=object)
        for a in reversed(PREFERRED):
            v = self.wind[a]
            m = ~np.isnan(v)
            w[m] = v[m]
            ag[m] = a
        return w, ag

    def preferred_pressure(self) -> np.ndarray:
        p = np.full(len(self), np.nan)
        for a in reversed(PREFERRED):
            v = self.pres[a]
            p[~np.isnan(v)] = v[~np.isnan(v)]
        return p


def _interp(t_out: np.ndarray, t_in: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Linear interpolation inside the span of non-missing values only (no extrapolation)."""
    m = ~np.isnan(v)
    out = np.full(len(t_out), np.nan)
    if m.sum() == 0:
        return out
    if m.sum() == 1:
        out[t_out == t_in[m][0]] = v[m][0]
        return out
    ti, vi = t_in[m], v[m]
    inside = (t_out >= ti[0]) & (t_out <= ti[-1])
    out[inside] = np.interp(t_out[inside], ti, vi)
    return out


def hourly(fixes: pd.DataFrame) -> HourlyTrack:
    """Hourly track for one storm from its IBTrACS rows (sorted or not)."""
    f = fixes.sort_values("iso_time")
    sid = str(f.sid.iloc[0])
    t = f.iso_time.dt.tz_convert("UTC").dt.tz_localize(None).to_numpy().astype("datetime64[s]")
    ts = t.astype("int64").astype(float)
    start = np.datetime64(pd.Timestamp(t[0]).ceil("h").to_datetime64(), "s")
    end = np.datetime64(pd.Timestamp(t[-1]).floor("h").to_datetime64(), "s")
    if end < start:  # a storm shorter than an hour boundary: keep its first fix rounded
        start = end = np.datetime64(pd.Timestamp(t[0]).round("h").to_datetime64(), "s")
    hours = np.arange(start, end + np.timedelta64(1, "h"), np.timedelta64(1, "h"))
    hs = hours.astype("int64").astype(float)
    lon = np.unwrap(np.radians(f.lon.to_numpy(float)))
    lat_h = np.interp(hs, ts, f.lat.to_numpy(float))
    lon_h = np.degrees(np.interp(hs, ts, lon)) % 360
    wind = {a: _interp(hs, ts, f[c].to_numpy(float)) for a, (c, _, _) in AGENCY_COLUMNS.items()}
    pres = {a: _interp(hs, ts, f[p].to_numpy(float)) for a, (_, p, _) in AGENCY_COLUMNS.items()}
    gust = _interp(hs, ts, f["usa_gust_kt"].to_numpy(float))
    obs_t = t[is_observed(f.iflag).to_numpy()]
    observed = np.isin(hours, obs_t)
    idx = np.searchsorted(obs_t, hours, side="right") - 1
    prev_fix = np.where(idx >= 0, obs_t[np.clip(idx, 0, None)] if len(obs_t) else np.datetime64("NaT", "s"),
                        np.datetime64("NaT", "s")).astype("datetime64[s]")
    jdx = np.searchsorted(obs_t, hours, side="left")
    next_fix = np.where(jdx < len(obs_t), obs_t[np.clip(jdx, 0, max(len(obs_t) - 1, 0))] if len(obs_t)
                        else np.datetime64("NaT", "s"), np.datetime64("NaT", "s")).astype("datetime64[s]")
    return HourlyTrack(sid, hours, lat_h, lon_h, wind, pres, gust, observed, prev_fix, next_fix)


def hourly_frame(tr: HourlyTrack) -> pd.DataFrame:
    w, ag = tr.preferred_wind()
    return pd.DataFrame({
        "sid": tr.sid, "time": pd.to_datetime(tr.time).tz_localize("UTC"), "lat": tr.lat, "lon": tr.lon,
        "wind_kt": w, "wind_agency": ag, "pressure_hpa": tr.preferred_pressure(),
        "jtwc_wind_kt": tr.wind["jtwc"], "jma_wind_kt": tr.wind["jma"], "wmo_wind_kt": tr.wind["wmo"],
        "jtwc_pressure_hpa": tr.pres["jtwc"], "jma_pressure_hpa": tr.pres["jma"], "gust_kt": tr.gust_kt,
        "observed": tr.observed,
    })
