"""Offline unit tests for the pipeline stages (synthetic inputs; no network, no data/ directory)."""
from __future__ import annotations

import io
import zlib

import numcodecs
import numpy as np
import pandas as pd
import pytest
import shapely
from PIL import Image

from typhoon import catalog, dataset, era5, exposure, frames, places, stats, track

# ----------------------------------------------------------------------------- track

def fixes(times: list[str], lats: list[float], lons: list[float], usa: list[float | None],
          iflags: list[str] | None = None) -> pd.DataFrame:
    n = len(times)
    nan = np.nan
    return pd.DataFrame({
        "sid": "2013306N07162", "iso_time": pd.to_datetime(times, utc=True), "lat": lats, "lon": lons,
        "usa_wind_kt": [nan if v is None else v for v in usa], "usa_pres_hpa": nan, "tokyo_wind_kt": nan,
        "tokyo_pres_hpa": nan, "wmo_wind_kt": nan, "wmo_pres_hpa": nan, "usa_gust_kt": nan,
        "iflag": iflags or ["O_____________"] * n,
    })


def test_hourly_interpolates_positions_and_flags_observed_fixes() -> None:
    f = fixes(["2013-11-07 00:00", "2013-11-07 03:00", "2013-11-07 06:00"], [10, 11, 12], [130, 129, 128],
              [100, None, 160], ["O_____________", "P_____________", "O_____________"])
    tr = track.hourly(f)
    assert len(tr) == 7
    assert tr.lat[1] == pytest.approx(10 + 1 / 3) and tr.lon[3] == pytest.approx(129)
    w, ag = tr.preferred_wind()
    assert w[0] == 100 and w[6] == 160 and w[3] == pytest.approx(130) and ag[3] == "jtwc"
    assert tr.observed.tolist() == [True, False, False, False, False, False, True]


def test_hourly_unwraps_the_dateline() -> None:
    tr = track.hourly(fixes(["2000-01-01 00:00", "2000-01-01 02:00"], [20, 20], [179.5, 180.5], [50, 50]))
    assert tr.lon[1] == pytest.approx(180.0)
    assert track.lon180(np.array([359.0, 10.0])).tolist() == [-1.0, 10.0]


# ----------------------------------------------------------------------------- ERA5 addressing

def test_forecast_init_and_step() -> None:
    v = np.array(["2013-11-07T07", "2013-11-07T18", "2013-11-07T19", "2013-11-08T06"], dtype="datetime64[h]")
    init, step = era5.fc_init(v)
    assert [str(i)[11:13] for i in init] == ["06", "06", "18", "18"]
    assert step.tolist() == [1, 12, 1, 12]


def test_ncar_paths() -> None:
    v = era5.VARS
    assert era5.ncar_relpath(v["u10"], month="201402") == \
        "201402/e5.oper.an.sfc.128_165_10u.ll025sc.2014020100_2014022823.nc"
    first = era5.ncar_relpath(v["fg10"], init=np.datetime64("2013-11-15T18", "h"))
    second = era5.ncar_relpath(v["mtpr"], init=np.datetime64("2013-12-16T06", "h"))
    assert first.endswith("e5.oper.fc.sfc.minmax.128_049_10fg.ll025sc.2013110106_2013111606.nc")
    assert second == "201312/e5.oper.fc.sfc.meanflux.235_055_mtpr.ll025sc.2013121606_2014010106.nc"


def test_window_origin_clamps_and_wraps() -> None:
    r, c = era5.window_origin(np.array([89.9, 10.0]), np.array([359.9, 0.1]))
    assert r[0] == 0 and r[1] == (90 - 10) * 4 - era5.HALF
    assert c[0] == (1440 - era5.HALF) % 1440 and c[1] == 1440 - era5.HALF


def test_h5_chunk_decode_and_tile_assembly() -> None:
    rng = np.random.default_rng(1)
    glob = rng.random((721, 1440)).astype("<f4")
    chunk = glob[:139, :279].copy()
    raw = zlib.compress(numcodecs.Shuffle(elementsize=4).encode(chunk.tobytes()))
    assert np.array_equal(era5.decode_h5(raw, [139, 279]), chunk)
    rows = np.arange(100, 181)
    cols = np.arange(1400, 1481) % 1440            # crosses the 0/360 seam
    out = np.empty((81, 81), np.float32)
    era5._fill(out, lambda rc, cc: glob[rc * 139:(rc + 1) * 139, cc * 279:(cc + 1) * 279], rows, cols, 139, 279)
    assert np.array_equal(out, glob[np.ix_(rows, cols)])


# ----------------------------------------------------------------------------- frames

def test_quantisation_errors_within_half_a_step() -> None:
    rng = np.random.default_rng(2)
    for e in frames.ENC:
        if e.kind == "angle":
            x = rng.uniform(0, 360, 1000)
            back = frames.dequantise(frames.quantise(x, e), e)
            assert np.abs(((back - x + 180) % 360) - 180).max() <= e.scale / 2 + 1e-6
            continue
        hi = (e.scale * 254) ** 2 if e.kind == "sqrt" else e.offset + e.scale * 254
        x = rng.uniform(e.offset, hi, 1000)
        x[0] = np.nan
        q = frames.quantise(x, e)
        assert q[0] == frames.NODATA
        back = frames.dequantise(q, e)
        assert np.isnan(back[0])
        err = np.abs(back[1:] - x[1:])
        step = e.scale if e.kind == "linear" else 2 * np.sqrt(x[1:]) * e.scale  # d(v)/dq for sqrt coding
        assert (err <= step / 2 + 1e-3).all()


def test_tyf_roundtrip_and_hour_ranges() -> None:
    q = np.random.default_rng(3).integers(0, 255, (5, 5, 81, 81), dtype=np.uint8)
    blob, hlen = frames.tyf_bytes(q, {"frames": 5, "vars": [{"name": e.name} for e in frames.ENC], "nx": 81, "ny": 81})
    assert hlen % 8 == 0 and blob[:4] == b"TYF1"
    _h, back = frames.parse_tyf(blob)
    assert np.array_equal(back, q)
    i, fb = 3, 5 * 81 * 81    # one hour = one contiguous range
    assert np.array_equal(np.frombuffer(blob[hlen + i * fb:hlen + (i + 1) * fb], np.uint8).reshape(5, 81, 81), q[i])


def test_webp_sprites_are_lossless() -> None:
    q = np.random.default_rng(4).integers(0, 256, (23, 81, 81), dtype=np.uint8)
    data, cols, rows = frames.sprite(q)
    assert (cols, rows) == (5, 5)
    assert Image.open(io.BytesIO(data)).format == "WEBP"
    assert np.array_equal(frames.unsprite(data, 23, 81, 81, cols), q)


# ----------------------------------------------------------------------------- landfall and exposure

def square(lon: float, lat: float, half: float) -> shapely.Geometry:
    return shapely.MultiPolygon([shapely.box(lon - half, lat - half, lon + half, lat + half)])


def places_frame(geoms: list[shapely.Geometry], ids: list[str]) -> pd.DataFrame:
    return pd.DataFrame({
        "place_id": ids, "country": "PH", "geom_wkb": [shapely.to_wkb(g) for g in geoms],
        "centroid_lon": [g.centroid.x for g in geoms], "centroid_lat": [g.centroid.y for g in geoms],
    })


def test_landfall_time_is_interpolated_to_the_coast() -> None:
    land = catalog.Land(places_frame([square(125.0, 11.0, 0.5)], ["PH-0000000001"]))
    t = np.array(["2013-11-07T20", "2013-11-07T21", "2013-11-07T22"], dtype="datetime64[s]")
    lf = land.entries(np.array([124.0, 124.75, 125.5]), np.array([11.0, 11.0, 11.0]), t)
    assert len(lf) == 1 and lf[0]["country"] == "PH" and lf[0]["place_id"] == "PH-0000000001"
    assert lf[0]["lon"] == pytest.approx(124.5)
    assert lf[0]["at"] == pd.Timestamp("2013-11-07T20:40Z")   # 2/3 of the way from 20:00 to 21:00


def test_islands_crossed_between_hours_count() -> None:
    land = catalog.Land(places_frame([square(125.0, 11.0, 0.02)], ["PH-0000000002"]))
    t = np.array(["2013-11-07T20", "2013-11-07T21"], dtype="datetime64[s]")
    assert len(land.entries(np.array([124.7, 125.3]), np.array([11.0, 11.0]), t)) == 1


def test_exposure_distances_and_bands() -> None:
    # place: 0.1 deg square at the equator-ish; track passes due north at about 1 deg (~111 km) away
    pl = places_frame([square(125.0, 10.0, 0.05)], ["PH-0000000003"])
    hours = pd.date_range("2013-11-07", periods=41, freq="h", tz="UTC")
    lon = np.linspace(123.0, 127.0, 41)
    hr = pd.DataFrame({"sid": "2013306N07162", "time": hours, "lat": 11.05, "lon": lon,
                       "wind_kt": np.linspace(100, 140, 41), "gust_kt": np.nan})
    st = pd.DataFrame({"sid": ["2013306N07162"], "season": [2013]})
    ex = exposure.compute(pl, hr, st)
    assert len(ex) == 1
    r = ex.iloc[0]
    assert r.closest_approach_km == pytest.approx(110.6, abs=1.0)        # 1.0 deg of latitude ~ 110.6 km
    assert r.closest_approach_at == pd.Timestamp("2013-11-07T20:00Z")
    assert r.hours_r50 == 0 and r.hours_r100 == 0 and r.hours_r200 > 0 and r.hours_r500 >= r.hours_r300
    assert pd.isna(r.max_wind_kt_r100) and r.max_wind_kt_r500 == 140
    assert pd.isna(r.max_gust_kt_r500)


# ----------------------------------------------------------------------------- places and dataset helpers

def test_place_names_and_regions() -> None:
    assert places.norm_name("City of Las Piñas") == places.norm_name("Las Pinas City") == "laspinas"
    assert places.clean_region("Region VIII (Eastern Visayas)") == "Eastern Visayas"
    assert places.clean_region("National Capital Region (NCR)") == "National Capital Region"
    assert places.clean_region("Mimaropa Region") == "Mimaropa"


def test_display_geometry_respects_the_vertex_cap() -> None:
    islands = shapely.MultiPolygon([shapely.Point(125 + i * 0.01, 10).buffer(0.003, 16) for i in range(400)])
    d = places.display_geom(islands, max_vertices=1500)
    assert shapely.get_num_coordinates(d) <= 1500 and not d.is_empty


def test_json_cleaning_and_track_hash() -> None:
    assert dataset.clean({"a": float("nan"), "b": [np.int16(3), pd.NA]}) == {"a": None, "b": [3, None]}
    h = pd.DataFrame({"time": pd.date_range("2020", periods=3, freq="h", tz="UTC"), "lat": [1.0, 2, 3], "lon": [359.0, 1, 2]})
    h2 = h.assign(lat=[1.0, 2, 3.5])
    assert dataset.track_hash(h) == dataset.track_hash(h.copy()) != dataset.track_hash(h2)


def test_antimeridian_track_does_not_cross_the_philippines() -> None:
    land = catalog.Land(places_frame([square(125.0, 11.0, 0.5)], ["PH-0000000004"]))
    t = np.array(["2019-08-30T00", "2019-08-30T01", "2019-08-30T02"], dtype="datetime64[s]")
    # 179.6E -> 180.1E -> 180.6E at 11N: in -180..180 the first segment would span the globe through 125E
    assert land.entries(np.array([179.6, 180.1, 180.6]), np.array([11.0, 11.0, 11.0]), t) == []


# ----------------------------------------------------------------------------- stats

def test_intensity_classes() -> None:
    assert stats.classify(170, stats.SSHS) == "cat5" and stats.classify(64, stats.SSHS) == "cat1"
    assert stats.classify(125, stats.JMA_CLASS) == "violent-typhoon"
    assert stats.classify(100, stats.PAGASA_CLASS) == "super-typhoon" and stats.classify(None, stats.SSHS) is None


def test_ace_uses_six_hourly_fixes_at_tropical_storm_strength() -> None:
    f = pd.DataFrame({"observed_at": pd.to_datetime(["2013-11-07 00:00", "2013-11-07 03:00", "2013-11-07 06:00",
                                                     "2013-11-07 12:00"], utc=True),
                      "jtwc_wind_kt": [100.0, 120.0, 30.0, 50.0]})
    assert stats.ace(f) == round((100**2 + 50**2) / 1e4, 2)


def test_max_intensification_over_24_hours() -> None:
    t = pd.date_range("2021-12-14", periods=49, freq="h", tz="UTC")
    w = np.concatenate([np.full(12, 50.0), np.linspace(50, 130, 25), np.full(12, 130.0)])
    h = pd.DataFrame({"time": t, "jtwc_wind_kt": w, "jma_wind_kt": np.nan})
    kt, at = stats.max_intensification(h)
    assert kt == 80.0 and at == "2021-12-15T12:00:00Z"


def synthetic_codes(T: int = 10) -> dict[str, np.ndarray]:
    yy, xx = np.mgrid[0:81, 0:81]
    r = np.hypot(yy - 40, xx - 40)
    wind = np.stack([np.clip(60 - np.abs(r - 8 - k * 0.2) * 2, 0, 76) for k in range(T)])
    wdir = np.stack([(np.degrees(np.arctan2(xx - 40, yy - 40)) + 90) % 360 for _ in range(T)])
    fields = {"wind": wind, "gust": wind * 1.3, "mslp": 1000 - wind, "tp": wind / 4, "wdir": wdir}
    codes = {e.name: frames.quantise(fields[e.name], e) for e in frames.ENC}
    codes.update(frames.uv_codes(frames.dequantise(codes["wind"], frames.ENC[0]),
                                 frames.dequantise(codes["wdir"], frames.ENC[4])))
    return codes


def test_padded_sheets_round_trip() -> None:
    q = np.random.default_rng(5).integers(0, 255, (7, 81, 81), dtype=np.uint8)
    s, cols, rows = frames.sheet(q, 96)
    assert s.shape == (rows * 96, cols * 96)
    data = frames.encode_webp(s, None)
    assert np.array_equal(frames.unsheet(data, 7, 81, 81, cols, 96), q)


def test_write_frames_is_content_addressed_and_valid(tmp_path) -> None:
    T = 10
    codes = synthetic_codes(T)
    hours = np.arange(np.datetime64("2013-11-07T00", "h"), np.datetime64("2013-11-07T10", "h"))
    check = {"headlineRatio": 0.3, "series": {"era5MaxWindMs": [1.0] * T}}
    meta = frames.write_frames("2013306N07162", codes, hours, np.full(T, 20.0), np.full(T, 120.0),
                               {"name": "Haiyan", "season": 2013}, {}, {}, check, tmp_path, ("webp", "tyf"))
    frames.validate_storm(tmp_path)
    f = meta["files"]
    assert [v["name"] for v in f["field"]["vars"]] == ["wind", "gust", "mslp", "tp", "u", "v"]
    assert f["exact"]["frameIndex"] == [0, 3, 6, 9] and f["exact"]["tileWidth"] == 41
    for v in [*f["field"]["vars"], *f["exact"]["vars"], f["tyf"]]:
        assert v["file"].startswith(v["sha256"][:16]) and (tmp_path / v["file"]).stat().st_size == v["bytes"]
    assert all(v["maxCodeError"] <= 40 for v in f["field"]["vars"])
    assert meta["series"] == {"era5MaxWindMs": [1.0] * T} and "series" not in meta["era5VsBestTrack"]
