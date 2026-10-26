"""Load the published data version into the API database (Neon), idempotently.

    python -m typhoon.apiload [--root URL] [--version N] [--force] [--dsn DSN]

Used by .github/workflows/api-load.yml after every successful Refresh or Backfill run, and by hand:

1. Read latest.json (or --version N) from the dataset root, then v<N>/manifest.json and v<N>/tables.json.
2. If catalog.current_dataset_version already records this data version (description "data v<N>") and the same
   pipeline commit, stop: nothing to do (exit 0, `loaded=false`). A Refresh run that published nothing therefore
   costs one small query, and re-running the workflow never bumps datasetVersion or invalidates cached ETags.
3. Download the version's Parquet tables (content-addressed: each file's name is the first 16 hex digits of its
   SHA-256, which is checked), join the per-season exposure files into one table, and check every row count
   against the manifest.
4. Hand the directory to typhoon.dbload, which stages, validates and swaps in ONE transaction: a failure at any
   step leaves the API serving the previous version, never a half-loaded or empty catalogue. Before staging, its
   size guard refuses a load that would take the database past 85 % of Neon Free's 1 GB cap (::error, exit 1).

Prints one JSON line: {"dataVersion": N, "datasetVersion": M, "loaded": true|false} (after a load also
"databaseMB", "peakMB" and "capMB"). The connection string is never logged.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import httpx
import psycopg
import pyarrow as pa  # type: ignore[import-untyped]
import pyarrow.parquet as pq  # type: ignore[import-untyped]

from . import dbload

log = logging.getLogger("typhoon.apiload")

DEFAULT_ROOT = "https://huggingface.co/datasets/permission-alluring/typhoon-replay/resolve/main/"


def marker(data_version: int) -> str:
    return f"data v{data_version}"


def _get(c: httpx.Client, url: str) -> bytes:
    r = c.get(url)
    r.raise_for_status()
    return r.content


def _json(c: httpx.Client, url: str) -> Any:
    return json.loads(_get(c, url))


def ibtracs_version(manifest: dict[str, Any]) -> str:
    """The IBTrACS release the version was built from, e.g. v04r01 (from the ibtracs-wp source URL)."""
    for s in manifest.get("sources", []):
        if s.get("id") == "ibtracs-wp" and (m := re.search(r"/(v\d+r\d+)/", s.get("url", ""))):
            return m.group(1)
    raise RuntimeError("manifest has no ibtracs-wp source with a vNNrNN URL")


def current(dsn: str) -> tuple[int, str | None, str | None]:
    """(datasetVersion, description, source_commit) of the catalogue the API serves now."""
    with psycopg.connect(dsn, connect_timeout=30) as conn, conn.cursor() as cur:
        cur.execute("SELECT v.version, v.description, v.source_commit FROM catalog.dataset_version v"
                    " ORDER BY v.version DESC LIMIT 1")
        row = cur.fetchone()
    return (int(row[0]), row[1], row[2]) if row else (0, None, None)


def fetch_tables(c: httpx.Client, root: str, table_paths: dict[str, list[str]], counts: dict[str, Any],
                 out: Path) -> None:
    """Download the tables typhoon.dbload needs into `out` as <name>.parquet, verifying hashes and row counts."""
    for t in dbload.TABLES:
        files = table_paths.get(t.parquet)
        if not files:
            raise RuntimeError(f"tables.json lists no files for {t.parquet}")
        parts = []
        for rel in files:
            data = _get(c, root + rel)
            want = Path(rel).stem
            if not hashlib.sha256(data).hexdigest().startswith(want):
                raise RuntimeError(f"{rel}: SHA-256 does not match its content-addressed name")
            parts.append(pa.BufferReader(data))
        if len(parts) == 1:
            table = pq.read_table(parts[0])
        else:
            table = pa.concat_tables([pq.read_table(p) for p in parts], promote_options="default")
        want_rows = int(counts.get(t.parquet, {}).get("rows", -1))
        if table.num_rows != want_rows:
            raise RuntimeError(f"{t.parquet}: {table.num_rows} rows downloaded, manifest says {want_rows}")
        pq.write_table(table, out / f"{t.parquet}.parquet", compression="zstd")
        log.info("fetched %-16s %9d rows from %d file(s)", t.parquet, table.num_rows, len(files))


def run(dsn: str, root: str, version: int | None, force: bool) -> dict[str, Any]:
    root = root if root.endswith("/") else root + "/"
    with httpx.Client(follow_redirects=True, timeout=180) as c:
        if version is None:
            version = int(_json(c, root + "latest.json")["version"])
        manifest = _json(c, f"{root}v{version}/manifest.json")
        commit = manifest.get("pipelineCommit")
        have, desc, have_commit = current(dsn)
        if not force and desc == marker(version) and have_commit == commit:
            log.info("datasetVersion %d already holds data v%d; nothing to load", have, version)
            return {"dataVersion": version, "datasetVersion": have, "loaded": False}
        log.info("API serves datasetVersion %d (%s); loading data v%d", have, desc or "no description", version)
        table_paths = _json(c, f"{root}v{version}/tables.json")["tables"]
        with tempfile.TemporaryDirectory(prefix="apiload-") as tmp:
            fetch_tables(c, root, table_paths, manifest["counts"]["tables"], Path(tmp))
            sizes: dict[str, int] = {}
            new = dbload.load(dsn, Path(tmp), ibtracs_version=ibtracs_version(manifest), source_commit=commit,
                              description=marker(version), sizes=sizes)
    return {"dataVersion": version, "datasetVersion": new, "loaded": True,
            "databaseMB": sizes["after"] // dbload.MB, "capMB": sizes["cap"] // dbload.MB,
            "peakMB": (sizes["database"] + sizes["staged"]) // dbload.MB}


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m typhoon.apiload", description=__doc__.split("\n")[0])
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"), help="default: $DATABASE_URL")
    ap.add_argument("--root", default=os.environ.get("TR_DATA_ROOT", DEFAULT_ROOT), help="dataset root URL")
    ap.add_argument("--version", type=int, help="data version to load (default: latest.json)")
    ap.add_argument("--force", action="store_true", help="load even if this version is already loaded")
    a = ap.parse_args(argv)
    if not a.dsn:
        ap.error("--dsn or DATABASE_URL is required")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    try:
        result = run(a.dsn, a.root, a.version, a.force)
    except dbload.SizeGuardError as e:
        # Internal only: the workflow's report job opens (or comments on) the "API load failed" issue.
        print(f"::error title=API load refused (database size guard)::{e}", file=sys.stderr)
        return 1
    except (dbload.ValidationError, dbload.LoadBusyError) as e:
        print(e, file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
