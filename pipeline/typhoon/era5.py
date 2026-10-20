"""Storm-following ERA5 windows (81 x 81 at 0.25 deg, about +-10 deg) read chunk by chunk.

Five fields per hour: 10 m u and v, MSLP (analysis), the hourly maximum 10 m gust (10fg) and the mean
total precipitation rate (mtpr) over the hour ending at the valid time.

Sources, in the registry's order (pipeline/sources.yaml, remote datasets `era5-an-sfc`,
`era5-fc-gust`, `era5-fc-precip-rate`):

1. NSF NCAR ERA5 on AWS (`ncar-aws`), 2. the same files through OSDF (`ncar-osdf`): NetCDF-4/HDF5. The
   chunk index of each file is read once with h5py over HTTP and cached under data/cache/ncar-index/;
   after that only the needed chunks are fetched with concurrent HTTP range requests and decoded
   (shuffle + zlib) here. Analysis chunks are (27 h, 139, 279), so a storm window touches a few tiles;
   forecast chunks are one whole globe x 12 hours.
3. ARCO-ERA5 on Google Cloud (`arco-gcs`): Zarr v2, one global hour per chunk (blosc). Used per file
   whenever NCAR fails, e.g. for the last ~3 months that NCAR has not published yet.

Every object read is recorded in a typhoon.sources.RemoteRead per dataset, so the data version's manifest
says which link served (and a fallback warns and opens the source-health issue in CI).
"""
from __future__ import annotations

import calendar
import json
import logging
import threading
import time
import zlib
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import numcodecs
import numpy as np

from . import sources
from .config import CACHE, ensure_dir

log = logging.getLogger("typhoon.era5")

HALF = 40                     # window = 2*HALF+1 cells
N = 2 * HALF + 1
NLAT, NLON = 721, 1440
T0 = np.datetime64("1900-01-01T00", "h")
HOUR = np.timedelta64(1, "h")


@dataclass(frozen=True)
class Var:
    key: str            # our name
    source_id: str      # registry remote dataset
    ncar_code: str      # file code
    ncar_name: str      # HDF5 dataset name
    family: str         # an | fc
    arco: str           # ARCO variable name


VARS: dict[str, Var] = {v.key: v for v in (
    Var("u10", "era5-an-sfc", "128_165_10u", "VAR_10U", "an", "10m_u_component_of_wind"),
    Var("v10", "era5-an-sfc", "128_166_10v", "VAR_10V", "an", "10m_v_component_of_wind"),
    Var("msl", "era5-an-sfc", "128_151_msl", "MSL", "an", "mean_sea_level_pressure"),
    Var("fg10", "era5-fc-gust", "128_049_10fg", "VAR_10FG", "fc", "10m_wind_gust_since_previous_post_processing"),
    Var("mtpr", "era5-fc-precip-rate", "235_055_mtpr", "MTPR", "fc", "mean_total_precipitation_rate"),
)}
PRODUCT = {"an": "e5.oper.an.sfc", "fc128_049_10fg": "e5.oper.fc.sfc.minmax", "fc235_055_mtpr": "e5.oper.fc.sfc.meanflux"}


class LinkFailed(Exception):
    pass


# ----------------------------------------------------------------------------- windows

def window_origin(lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Global row/col index of each window's north-west cell (centre snapped to the 0.25 deg grid)."""
    ci = np.clip(np.round((90 - np.asarray(lat)) / 0.25).astype(int), HALF, NLAT - 1 - HALF)
    cj = np.round((np.asarray(lon) % 360) / 0.25).astype(int) % NLON
    return ci - HALF, (cj - HALF) % NLON


def nw_corner(row0: np.ndarray, col0: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    return 90 - row0 * 0.25, (col0 * 0.25) % 360


# ----------------------------------------------------------------------------- HTTP

_local = threading.local()


def client() -> httpx.Client:
    c = getattr(_local, "client", None)
    if c is None:
        c = httpx.Client(timeout=httpx.Timeout(60, connect=20), follow_redirects=True,
                         headers={"User-Agent": sources.registry().health.get("user_agent", "typhoon-replay"),
                                  "Accept-Encoding": "identity"},
                         limits=httpx.Limits(max_connections=64, max_keepalive_connections=64))
        _local.client = c
    return c


def get_range(url: str, start: int, size: int, retries: int = 4) -> bytes:
    last: Exception | None = None
    for k in range(retries):
        try:
            r = client().get(url, headers={"Range": f"bytes={start}-{start + size - 1}"})
            if r.status_code == 404:
                raise LinkFailed(f"404 {url}")
            r.raise_for_status()
            if len(r.content) != size:
                raise LinkFailed(f"short read {len(r.content)}/{size} {url}")
            return r.content
        except LinkFailed:
            raise
        except Exception as e:  # network errors, 5xx: retry with backoff
            last = e
            time.sleep(1.5 * (k + 1))
    raise LinkFailed(f"{url}: {last}")


def get_all(url: str, retries: int = 4) -> bytes:
    last: Exception | None = None
    for k in range(retries):
        try:
            r = client().get(url)
            if r.status_code == 404:
                raise LinkFailed(f"404 {url}")
            r.raise_for_status()
            return r.content
        except LinkFailed:
            raise
        except Exception as e:
            last = e
            time.sleep(1.5 * (k + 1))
    raise LinkFailed(f"{url}: {last}")


# ----------------------------------------------------------------------------- NCAR (HDF5 chunks)

def ncar_relpath(var: Var, month: str | None = None, init: np.datetime64 | None = None) -> str:
    """Path below the product directory of the file holding `month` (an) or forecast `init` (fc)."""
    if var.family == "an":
        assert month is not None
        y, m = int(month[:4]), int(month[4:])
        last = calendar.monthrange(y, m)[1]
        return f"{month}/e5.oper.an.sfc.{var.ncar_code}.ll025sc.{month}0100_{month}{last:02d}23.nc"
    assert init is not None
    d = init.astype("datetime64[D]")
    ym = str(d)[:7].replace("-", "")
    day = int(str(d)[8:10])
    y, m = int(ym[:4]), int(ym[4:])
    nxt = f"{y + (m == 12)}{(m % 12) + 1:02d}"
    span = f"{ym}0106_{ym}1606" if day < 16 or (day == 16 and str(init)[11:13] == "00") else f"{ym}1606_{nxt}0106"
    return f"{ym}/{PRODUCT['fc' + var.ncar_code]}.{var.ncar_code}.ll025sc.{span}.nc"


def fc_init(valid: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Forecast initialisation (06/18 UTC) and step (1..12 h) whose step ends at each valid hour."""
    v = valid.astype("datetime64[h]")
    k = ((v - np.timedelta64(7, "h") - T0) // np.timedelta64(12, "h"))
    init = T0 + k * np.timedelta64(12, "h") + np.timedelta64(6, "h")
    return init, (v - init).astype(int)


@dataclass
class H5Index:
    url: str
    shape: list[int]
    chunks: list[int]
    t0: int                       # first time (an) / first init (fc), hours since 1900
    offsets: dict[str, tuple[int, int]] = field(default_factory=dict)   # "a,b,c[,d]" -> (offset, size)

    def chunk(self, coord: tuple[int, ...]) -> tuple[int, int]:
        return self.offsets[",".join(map(str, coord))]


_index_lock = threading.Lock()


def h5_index(base: str, relpath: str, dsname: str) -> H5Index:
    """Chunk byte offsets of one NCAR file (cached as JSON; the file layout never changes)."""
    cache = ensure_dir(CACHE / "ncar-index") / (relpath.replace("/", "__") + ".json")
    url = f"{base}/{relpath}"
    if cache.exists():
        d = json.loads(cache.read_text())
        return H5Index(url, d["shape"], d["chunks"], d["t0"], {k: tuple(v) for k, v in d["offsets"].items()})
    import fsspec
    import h5py

    fs = fsspec.filesystem("http", headers={"Accept-Encoding": "identity"})
    try:
        f = h5py.File(fs.open(url, block_size=2**20, cache_type="blockcache"), "r")
    except FileNotFoundError as e:
        raise LinkFailed(f"404 {url}") from e
    except Exception as e:
        raise LinkFailed(f"{url}: {e}") from e
    with f:
        v = f[dsname]
        filters = v._filters
        if set(filters) - {"shuffle", "gzip"}:
            raise LinkFailed(f"{url}: unexpected HDF5 filters {filters}")
        lat = f["latitude"]
        lon = f["longitude"]
        if lat.shape != (NLAT,) or lon.shape != (NLON,) or lat[0] != 90 or lon[0] != 0:
            raise LinkFailed(f"{url}: unexpected grid")
        tname = "time" if "time" in f else "forecast_initial_time"
        t0 = int(f[tname][0])
        offs = {}
        for i in range(v.id.get_num_chunks()):
            ci = v.id.get_chunk_info(i)
            if ci.filter_mask != 0:
                raise LinkFailed(f"{url}: chunk {ci.chunk_offset} has filters disabled")
            coord = tuple(o // c for o, c in zip(ci.chunk_offset, v.chunks, strict=True))
            offs[",".join(map(str, coord))] = (int(ci.byte_offset), int(ci.size))
        idx = H5Index(url, list(v.shape), list(v.chunks), t0, offs)
    with _index_lock:
        cache.write_text(json.dumps({"shape": idx.shape, "chunks": idx.chunks, "t0": idx.t0, "offsets": idx.offsets}))
    return idx


def decode_h5(raw: bytes, chunks: list[int]) -> np.ndarray:
    data = numcodecs.Shuffle(elementsize=4).decode(zlib.decompress(raw))
    return np.frombuffer(data, "<f4").reshape(chunks)


def _fill(out: np.ndarray, plane: Callable[[int, int], np.ndarray], rows: np.ndarray, cols: np.ndarray,
          ch: int, cw: int) -> None:
    """Copy the window rows x cols from tiles of size ch x cw; plane(rc, cc) gives a tile."""
    for rc in np.unique(rows // ch):
        rm = np.flatnonzero(rows // ch == rc)
        for cc in np.unique(cols // cw):
            cm = np.flatnonzero(cols // cw == cc)
            tile = plane(int(rc), int(cc))
            out[np.ix_(rm, cm)] = tile[np.ix_(rows[rm] - rc * ch, cols[cm] - cc * cw)]


def ncar_an(var: Var, base: str, month: str, hours: np.ndarray, row0: np.ndarray, col0: np.ndarray,
            rr: sources.RemoteRead, link_id: str, pool: ThreadPoolExecutor) -> np.ndarray:
    rel = ncar_relpath(var, month=month)
    idx = h5_index(base, rel, var.ncar_name)
    ct, ch, cw = idx.chunks
    ti = ((hours.astype("datetime64[h]") - T0).astype(int) - idx.t0)
    if (ti < 0).any() or (ti >= idx.shape[0]).any():
        raise LinkFailed(f"{rel}: hours outside file")
    need: set[tuple[int, int, int]] = set()
    rows_all = [np.arange(r, r + N) for r in row0]
    cols_all = [(np.arange(c, c + N)) % NLON for c in col0]
    for t, rows, cols in zip(ti, rows_all, cols_all, strict=True):
        for rc in np.unique(rows // ch):
            for cc in np.unique(cols // cw):
                need.add((int(t // ct), int(rc), int(cc)))
    keys = sorted(need)

    def fetch(k: tuple[int, int, int]) -> tuple[tuple[int, int, int], np.ndarray]:
        off, size = idx.chunk(k)
        raw = get_range(idx.url, off, size)
        rr.ok(link_id, f"{rel}#{k}", size)
        return k, decode_h5(raw, idx.chunks)

    tiles = dict(pool.map(fetch, keys))
    out = np.empty((len(hours), N, N), np.float32)
    for i, (t, rows, cols) in enumerate(zip(ti, rows_all, cols_all, strict=True)):
        _fill(out[i], lambda rc, cc, t=t: tiles[(int(t // ct), rc, cc)][t % ct], rows, cols, ch, cw)
    return out


def ncar_fc(var: Var, base: str, init_key: np.datetime64, hours: np.ndarray, steps: np.ndarray,
            inits: np.ndarray, row0: np.ndarray, col0: np.ndarray, rr: sources.RemoteRead, link_id: str,
            pool: ThreadPoolExecutor) -> np.ndarray:
    rel = ncar_relpath(var, init=init_key)
    idx = h5_index(base, rel, var.ncar_name)
    ii = ((inits.astype("datetime64[h]") - T0).astype(int) - idx.t0) // 12
    if (ii < 0).any() or (ii >= idx.shape[0]).any():
        raise LinkFailed(f"{rel}: initialisations outside file")
    keys = sorted({int(x) for x in ii})

    def fetch(k: int) -> tuple[int, np.ndarray]:
        off, size = idx.chunk((k, 0, 0, 0))
        raw = get_range(idx.url, off, size)
        rr.ok(link_id, f"{rel}#{k}", size)
        return k, decode_h5(raw, idx.chunks)[0]          # (12, 721, 1440)

    out = np.empty((len(hours), N, N), np.float32)
    # whole-globe chunks are 50 MB decoded: stream them through the pool a few at a time
    for b in range(0, len(keys), 4):
        got = dict(pool.map(fetch, keys[b:b + 4]))
        for i in np.flatnonzero(np.isin(ii, list(got))):
            g = got[int(ii[i])][steps[i] - 1]
            rows = np.arange(row0[i], row0[i] + N)
            cols = np.arange(col0[i], col0[i] + N) % NLON
            out[i] = g[np.ix_(rows, cols)]
    return out


# ----------------------------------------------------------------------------- ARCO (Zarr v2, one hour per chunk)

ARCO = "https://storage.googleapis.com/gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3"
_arco_codecs: dict[str, Any] = {}


def arco_codec(var: Var) -> Any:
    if var.arco not in _arco_codecs:
        meta = json.loads(get_all(f"{ARCO}/{var.arco}/.zarray"))
        if meta["chunks"] != [1, NLAT, NLON] or meta["dtype"] != "<f4":
            raise LinkFailed(f"ARCO {var.arco}: unexpected layout {meta['chunks']} {meta['dtype']}")
        _arco_codecs[var.arco] = numcodecs.get_codec(meta["compressor"])
    return _arco_codecs[var.arco]


def arco(var: Var, hours: np.ndarray, row0: np.ndarray, col0: np.ndarray, rr: sources.RemoteRead,
         pool: ThreadPoolExecutor) -> np.ndarray:
    codec = arco_codec(var)
    tidx = (hours.astype("datetime64[h]") - T0).astype(int)

    def one(i: int) -> tuple[int, np.ndarray]:
        key = f"{var.arco}/{tidx[i]}.0.0"
        raw = get_all(f"{ARCO}/{key}")
        rr.ok("arco-gcs", key, len(raw))
        g = np.frombuffer(codec.decode(raw), "<f4").reshape(NLAT, NLON)
        rows = np.arange(row0[i], row0[i] + N)
        cols = np.arange(col0[i], col0[i] + N) % NLON
        return i, g[np.ix_(rows, cols)].copy()

    out = np.empty((len(hours), N, N), np.float32)
    for i, w in pool.map(one, range(len(hours))):
        out[i] = w
    return out


# ----------------------------------------------------------------------------- orchestration

@dataclass
class Windows:
    time: np.ndarray                 # datetime64[h]
    row0: np.ndarray
    col0: np.ndarray
    fields: dict[str, np.ndarray]    # var key -> float32 [T, N, N]
    served: dict[str, list[str]]     # var key -> link id per hour

    @property
    def nw_lat(self) -> np.ndarray:
        return nw_corner(self.row0, self.col0)[0]

    @property
    def nw_lon(self) -> np.ndarray:
        return nw_corner(self.row0, self.col0)[1]


def _groups(var: Var, hours: np.ndarray) -> Iterable[tuple[Any, np.ndarray]]:
    if var.family == "an":
        months = np.array([str(h)[:7].replace("-", "") for h in hours.astype("datetime64[M]")])
        for m in dict.fromkeys(months):
            yield m, np.flatnonzero(months == m)
    else:
        inits, _ = fc_init(hours)
        files = np.array([ncar_relpath(var, init=i) for i in inits])
        for f in dict.fromkeys(files):
            sel = np.flatnonzero(files == f)
            yield inits[sel[0]], sel


def read_windows(hours: np.ndarray, lat: np.ndarray, lon: np.ndarray, *,
                 manifest: sources.RunManifest | None = None, concurrency: int = 32,
                 links: list[str] | None = None) -> Windows:
    """ERA5 windows for the given hours/centres, walking each dataset's links per file."""
    hours = hours.astype("datetime64[h]")
    row0, col0 = window_origin(lat, lon)
    fields: dict[str, np.ndarray] = {}
    served: dict[str, list[str]] = {}
    reads = {sid: sources.RemoteRead(sid) for sid in {v.source_id for v in VARS.values()}}
    with ThreadPoolExecutor(concurrency) as pool:
        for var in VARS.values():
            rr = reads[var.source_id]
            arr = np.full((len(hours), N, N), np.nan, np.float32)
            who = [""] * len(hours)
            chain = [lk for lk in sources.remote_links(var.source_id) if links is None or lk["id"] in links]
            for gkey, sel in _groups(var, hours):
                for lk in chain:
                    try:
                        if lk["id"] == "arco-gcs":
                            arr[sel] = arco(var, hours[sel], row0[sel], col0[sel], rr, pool)
                        elif var.family == "an":
                            arr[sel] = ncar_an(var, lk["url"], gkey, hours[sel], row0[sel], col0[sel], rr,
                                               lk["id"], pool)
                        else:
                            inits, steps = fc_init(hours[sel])
                            arr[sel] = ncar_fc(var, lk["url"], gkey, hours[sel], steps, inits, row0[sel],
                                               col0[sel], rr, lk["id"], pool)
                        for i in sel:
                            who[i] = lk["id"]
                        break
                    except (LinkFailed, httpx.HTTPError, OSError, ValueError, KeyError, zlib.error) as e:
                        rr.failed(lk["id"], f"{var.key}:{gkey}", type(e).__name__, str(e))
                        log.warning("%s %s via %s failed: %s", var.key, gkey, lk["id"], e)
                else:
                    log.error("%s %s: every link failed; hours left as nodata", var.key, gkey)
            fields[var.key] = arr
            served[var.key] = who
    for rr in reads.values():
        rr.record(manifest)
    return Windows(hours, row0, col0, fields, served)
