"""typhoon.apiload: download checks and the idempotency marker (no network, no database)."""
import hashlib
import io
import sys
from pathlib import Path

import httpx
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # pipeline/ is not an installed package
from typhoon import apiload, dbload

ROOT = "https://data.test/"


def _parquet(n: int, **extra: list[object]) -> bytes:
    buf = io.BytesIO()
    pq.write_table(pa.table({"k": list(range(n)), **extra}), buf)
    return buf.getvalue()


def _site(seasons: int = 2) -> tuple[dict[str, bytes], dict[str, list[str]], dict[str, dict[str, int]]]:
    files: dict[str, bytes] = {}
    paths: dict[str, list[str]] = {}
    counts: dict[str, dict[str, int]] = {}
    for t in dbload.TABLES:
        blobs = [_parquet(3, season=[1990 + i] * 3) for i in range(seasons)] if t.parquet == "exposure" \
            else [_parquet(2)]
        paths[t.parquet] = []
        for b in blobs:
            rel = f"tables/{t.parquet}/{hashlib.sha256(b).hexdigest()[:16]}.parquet"
            files[rel] = b
            paths[t.parquet].append(rel)
        counts[t.parquet] = {"rows": sum(pq.read_table(io.BytesIO(b)).num_rows for b in blobs)}
    return files, paths, counts


def _client(files: dict[str, bytes]) -> httpx.Client:
    def handler(req: httpx.Request) -> httpx.Response:
        rel = str(req.url).removeprefix(ROOT)
        return httpx.Response(200, content=files[rel]) if rel in files else httpx.Response(404)

    return httpx.Client(transport=httpx.MockTransport(handler))


def test_fetch_joins_exposure_and_checks_counts(tmp_path: Path) -> None:
    files, paths, counts = _site()
    apiload.fetch_tables(_client(files), ROOT, paths, counts, tmp_path)
    assert pq.read_table(tmp_path / "exposure.parquet").num_rows == 6
    assert {p.name for p in tmp_path.iterdir()} == {f"{t.parquet}.parquet" for t in dbload.TABLES}


def test_fetch_rejects_a_wrong_count(tmp_path: Path) -> None:
    files, paths, counts = _site()
    counts["storms"]["rows"] = 5
    with pytest.raises(RuntimeError, match="storms: 2 rows"):
        apiload.fetch_tables(_client(files), ROOT, paths, counts, tmp_path)


def test_fetch_rejects_a_corrupt_file(tmp_path: Path) -> None:
    files, paths, counts = _site()
    rel = paths["places"][0]
    files[rel] = _parquet(2, extra=[1, 2])
    with pytest.raises(RuntimeError, match="SHA-256"):
        apiload.fetch_tables(_client(files), ROOT, paths, counts, tmp_path)


def test_ibtracs_version_and_marker() -> None:
    url = "https://www.ncei.noaa.gov/data/x/v04r01/access/csv/ibtracs.WP.list.v04r01.csv"
    assert apiload.ibtracs_version({"sources": [{"id": "ibtracs-all", "url": ""}, {"id": "ibtracs-wp", "url": url}]}) \
        == "v04r01"
    assert apiload.marker(4) == "data v4"
