"""Typhoon Replay's adapter over archivekit (abrycta/data-archive-kit).

The fallback chain (primary -> mirrors -> private archive), validation, provenance, auto-issues,
snapshots and health checks all live in the kit. This module only binds the project's registry
(pipeline/sources.yaml) and holds the project-specific validation hook referenced from it.

    uv run python -m typhoon.sources fetch ibtracs-wp     # = archivekit fetch --registry pipeline/sources.yaml
    from typhoon.sources import fetch; prov = fetch("ibtracs-wp")
"""
from __future__ import annotations

import csv
import re
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

import archivekit
from archivekit import AllLinksFailed, Provenance, Registry, RunManifest, SchemaError, data_version_metadata

PIPELINE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = PIPELINE_DIR.parent
REGISTRY_PATH = PIPELINE_DIR / "sources.yaml"

__all__ = ["REGISTRY_PATH", "AllLinksFailed", "Provenance", "RunManifest", "check_ibtracs", "data_version_metadata",
           "fetch", "registry"]


@lru_cache(maxsize=1)
def registry() -> Registry:
    return archivekit.load_registry(REGISTRY_PATH, root=REPO_ROOT)


def fetch(source_id: str, dest: Path | str | None = None, **kw: Any) -> Provenance:
    """archivekit.fetch with this project's registry (dest defaults to the source's local_path)."""
    return archivekit.fetch(source_id, kw.pop("registry", None) or registry(), dest, **kw)


SID_RE = re.compile(r"\d{7}[NS]\d{5}")
TIME_RE = re.compile(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}")


def check_ibtracs(path: Path, src: dict[str, Any], sample: int = 5000) -> list[str]:
    """Project hook (sources.yaml `hooks`): IBTrACS-specific sanity on the first `sample` data rows.

    Rejects data whose SIDs, times or coordinates no longer parse the way typhoon.ibtracs expects;
    the kit then moves on to the next link. Full data-quality tests run in tests/test_ibtracs.py.
    """
    with open(path, encoding="utf-8", newline="") as f:
        rows = csv.reader(f)
        header = next(rows)
        next(rows)  # units row
        i_sid, i_time, i_lat, i_lon = (header.index(c) for c in ("SID", "ISO_TIME", "LAT", "LON"))
        for n, row in enumerate(rows):
            if n >= sample:
                break
            line = n + 3
            if not SID_RE.fullmatch(row[i_sid]):
                raise SchemaError(f"row {line}: SID {row[i_sid]!r} does not match {SID_RE.pattern}")
            if not TIME_RE.fullmatch(row[i_time]):
                raise SchemaError(f"row {line}: ISO_TIME {row[i_time]!r} is not 'YYYY-MM-DD HH:MM:SS'")
            lat, lon = float(row[i_lat]), float(row[i_lon])
            if not (-90 <= lat <= 90 and -180 <= lon <= 360):
                raise SchemaError(f"row {line}: LAT/LON {lat},{lon} out of range")
    return []


def main(argv: list[str] | None = None) -> int:
    """`python -m typhoon.sources <archivekit command>` with this project's registry filled in."""
    from archivekit.cli import main as kit_main

    args = list(sys.argv[1:] if argv is None else argv)
    if args and args[0] in ("fetch", "snapshot", "health", "restore", "validate-registry") \
            and "--registry" not in args:
        extra = ["--registry", str(REGISTRY_PATH)]
        if args[0] != "validate-registry":
            extra += ["--root", str(REPO_ROOT)]
        args[1:1] = extra
    return kit_main(args)


if __name__ == "__main__":
    sys.exit(main())
