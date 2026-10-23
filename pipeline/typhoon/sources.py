"""Replay's adapter over archivekit (abrycta/data-archive-kit).

The fallback chain (primary -> mirrors -> private archive), validation, provenance, auto-issues,
snapshots and health checks all live in the kit. This module binds the project's registry
(pipeline/sources.yaml), holds the project-specific validation hook referenced from it, and adds two
thin conveniences that still go through the kit:

* ``fetch_template(id, year=2013)``: an ``update-input`` source whose URL has ``{placeholders}``
  (the Wikipedia season pages) is fetched one page at a time as a concrete ``file`` source, so every
  page gets the same checks, atomic write and provenance as any other download.
* ``RemoteRead``: ``remote-dataset`` sources (ERA5) are never downloaded whole; ``typhoon.era5`` reads
  chunks from their links in registry order and records which link served as an archivekit
  ``Provenance`` in the run manifest, warning (and opening the source-health issue in CI) on fallback.

    uv run python -m typhoon.sources fetch ibtracs-wp     # = archivekit fetch --registry pipeline/sources.yaml
    from typhoon.sources import fetch; prov = fetch("ibtracs-wp")
"""
from __future__ import annotations

import copy
import csv
import dataclasses
import hashlib
import json
import logging
import os
import re
import sys
from collections.abc import Iterator
from functools import lru_cache
from pathlib import Path
from typing import Any

import archivekit
from archivekit import (
    AllLinksFailed,
    NotFetchable,
    Provenance,
    Registry,
    RunManifest,
    SchemaError,
    data_version_metadata,
)
from archivekit.fetch import attempts_md, now_iso

PIPELINE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = PIPELINE_DIR.parent
REGISTRY_PATH = PIPELINE_DIR / "sources.yaml"

log = logging.getLogger("typhoon.sources")


def provenance_from_dict(d: dict[str, Any]) -> Provenance:
    """Rebuild a Provenance from a sidecar or manifest dict, tolerating keys this kit version doesn't know.

    `Provenance(**d)` raises on a sidecar written by a newer kit (new fields), which would break a rollback
    of the kit pin. Kit 1.3+ has `Provenance.from_dict` for this; older kits get the same by filtering on
    the dataclass fields.
    """
    from_dict = getattr(Provenance, "from_dict", None)
    if from_dict is not None:
        return from_dict(d)
    known = {f.name for f in dataclasses.fields(Provenance)}
    return Provenance(**{k: v for k, v in d.items() if k in known})

__all__ = [
    "REGISTRY_PATH",
    "AllLinksFailed",
    "Provenance",
    "RemoteRead",
    "RunManifest",
    "check_ibtracs",
    "check_jma",
    "data_version_metadata",
    "fetch",
    "fetch_template",
    "local_path",
    "provenance_from_dict",
    "registry",
    "remote_links",
    "source",
]


@lru_cache(maxsize=1)
def registry() -> Registry:
    return archivekit.load_registry(REGISTRY_PATH, root=REPO_ROOT)


def source(source_id: str) -> dict[str, Any]:
    return registry().source(source_id)


def local_path(source_id: str, **params: str | int) -> Path:
    """Where fetch() puts a source (the registry's local_path, placeholders filled)."""
    return REPO_ROOT / str(source(source_id)["local_path"]).format(**params)


def fetch(source_id: str, dest: Path | str | None = None, **kw: Any) -> Provenance:
    """archivekit.fetch with this project's registry (dest defaults to the source's local_path)."""
    return archivekit.fetch(source_id, kw.pop("registry", None) or registry(), dest, **kw)


def ensure(source_id: str, manifest: RunManifest | None = None, *, refresh: bool = False) -> Path:
    """Fetch a file source unless a validated local copy with provenance exists; record provenance.

    Pinned sources (checks.sha256) are fetched once; `refresh=True` re-fetches (IBTrACS updates).
    """
    path = local_path(source_id)
    prov_file = archivekit.provenance_path(path)
    if path.exists() and prov_file.exists() and not refresh:
        d = json.loads(prov_file.read_text())
        d.pop("data_as_of", None)
        prov = provenance_from_dict(d)
        if manifest is not None:
            manifest.add(prov)
        return path
    fetch(source_id, path, manifest=manifest)
    return path


def fetch_template(source_id: str, dest: Path | str | None = None, *, manifest: RunManifest | None = None,
                   reporter: Any = True, **params: str | int) -> Provenance:
    """Fetch one instance of a templated source (e.g. a Wikipedia season page) through archivekit.

    The registry entry stays an `update-input` (never fetched at runtime by anything else); here it is
    materialised as a concrete `file` source with `{placeholders}` filled, with archiving off.
    """
    reg = registry()
    src = copy.deepcopy(reg.source(source_id))
    if src.get("kind") != "update-input":
        raise NotFetchable(f"{source_id} is kind={src.get('kind')}; use fetch()")
    concrete_id = f"{source_id}-" + "-".join(str(v) for v in params.values())
    src.update(id=concrete_id, kind="file", archived={"enabled": False})
    for k in ("filename", "local_path"):
        if k in src:
            src[k] = str(src[k]).format(**params)
    src["links"] = [dict(lk, url=lk["url"].format(**params)) for lk in src["links"]
                    if lk.get("automatic", True) and "url" in lk]
    raw = copy.deepcopy(reg.raw)
    raw["sources"] = [src]
    one = Registry(raw, f"{reg.location}#{concrete_id}", reg.root)
    out = Path(dest) if dest else reg.root / src["local_path"]
    return archivekit.fetch(concrete_id, one, out, manifest=manifest, reporter=reporter)


# ----------------------------------------------------------------------------- remote datasets (ERA5)

def remote_links(source_id: str) -> list[dict[str, Any]]:
    """The automatic links of a remote-dataset source, in fallback order."""
    src = source(source_id)
    if src.get("kind") != "remote-dataset":
        raise NotFetchable(f"{source_id} is not a remote-dataset")
    return archivekit.automatic_links(src)


@dataclasses.dataclass
class RemoteRead:
    """Accumulates which link served each read of a remote dataset during one run."""

    source_id: str
    served: dict[str, int] = dataclasses.field(default_factory=dict)      # link id -> objects read
    nbytes: dict[str, int] = dataclasses.field(default_factory=dict)      # link id -> bytes read
    attempts: list[dict[str, str]] = dataclasses.field(default_factory=list)
    keys: list[str] = dataclasses.field(default_factory=list)              # what was read, for the fingerprint

    def ok(self, link_id: str, key: str, nbytes: int) -> None:
        self.served[link_id] = self.served.get(link_id, 0) + 1
        self.nbytes[link_id] = self.nbytes.get(link_id, 0) + nbytes
        self.keys.append(f"{link_id}:{key}")

    def failed(self, link_id: str, key: str, error: str, message: str) -> None:
        self.attempts.append({"link": link_id, "error": error, "message": f"{key}: {message}"[:500]})

    @property
    def fallback_used(self) -> bool:
        first = remote_links(self.source_id)[0]["id"]
        return any(k != first for k in self.served)

    def provenance(self) -> Provenance:
        links = {lk["id"]: lk for lk in remote_links(self.source_id)}
        main = max(self.served, key=lambda k: self.served[k]) if self.served else next(iter(links))
        order = list(links)
        fp = hashlib.sha256("\n".join(sorted(self.keys)).encode()).hexdigest()
        return Provenance(
            source_id=self.source_id, link_id=main,
            served_by="primary" if not self.fallback_used else "fallback",
            url=links[main].get("url", ""), fetched_at=now_iso(), sha256=fp, bytes=sum(self.nbytes.values()), rows=len(self.keys),
            fallback_used=self.fallback_used,
            attempts=self.attempts[:50] + [{"link": k, "error": "served",
                                            "message": f"{self.served[k]} objects, {self.nbytes.get(k, 0)} bytes"}
                                           for k in sorted(self.served, key=order.index)])

    def record(self, manifest: RunManifest | None) -> Provenance:
        """Add to the run manifest; on fallback warn and open/update the source-health issue (CI only)."""
        prov = self.provenance()
        if manifest is not None:
            if self.source_id in manifest.items:      # merge with earlier storms of the same run
                prev = manifest.items[self.source_id]
                prov.bytes += prev.bytes
                prov.rows = (prov.rows or 0) + (prev.rows or 0)
                prov.fallback_used = prov.fallback_used or prev.fallback_used
                prov.served_by = "fallback" if prov.fallback_used else "primary"
                prov.attempts = (prev.attempts + prov.attempts)[-100:]
                prov.sha256 = hashlib.sha256((prev.sha256 + prov.sha256).encode()).hexdigest()
            manifest.add(prov)
        if self.fallback_used:
            what = ", ".join(f"{k}: {v} objects" for k, v in self.served.items())
            log.warning("%s: FALLBACK USED (%s)", self.source_id, what)
            if os.environ.get("GITHUB_ACTIONS") == "true":
                print(f"::warning title=fallback used::{self.source_id} served by {what}")
            _report(self.source_id, "fallback:" + ",".join(sorted(self.served)),
                    f"`{self.source_id}` was read through a fallback link ({what}).\n\n"
                    + attempts_md(self.attempts[:20])
                    + "\n\nThe run continued. Follow docs/architecture/DATA-RESILIENCE.md.")
        return prov


def _report(key: str, state: str, summary: str) -> None:
    try:
        from archivekit.github import IssueReporter
        from archivekit.http import make_client

        reg = registry()
        client = make_client(reg.health.get("user_agent"))
        rep = IssueReporter.from_env(reg.issue_repo, client,
                                     token_env=reg.health.get("issue_token_env", "ARCHIVE_READ_TOKEN"),
                                     label=reg.health.get("issue_label", "source-health"))
        if rep is not None:
            log.warning("%s: health issue %s", key, rep.report_problem(key, state, summary))
    except Exception as e:  # reporting must never fail the pipeline  # noqa: BLE001
        log.warning("%s: could not open/update the health issue: %s", key, e)


def attributions() -> Iterator[dict[str, Any]]:
    """Every source's licence and attribution, for the dataset card and manifest."""
    for s in registry().sources:
        yield {"id": s["id"], "kind": s["kind"], "licence": " ".join(str(s["licence"]).split()),
               "attribution": " ".join(str(s["attribution"]).split()), "share_alike": bool(s.get("share_alike"))}


# ----------------------------------------------------------------------------- project hook

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


JMA_MIN_STORMS = 1800   # bst_all.txt held 1,9xx storms (1951-2025) in 2026; it only grows


def check_jma(path: Path, src: dict[str, Any]) -> list[str]:
    """Project hook (sources.yaml `hooks`): the RSMC Tokyo best track must parse with typhoon.jma's parser
    (fixed-column format) and hold at least JMA_MIN_STORMS storms with fixes. A changed layout or a truncated
    file raises SchemaError, so the kit falls back to the next link (the archive) instead of handing
    typhoon.jma a file it cannot read (resilience fix R4)."""
    import zipfile

    from .jma import parse_bst

    try:
        if zipfile.is_zipfile(path):   # the kit validates a temporary file, so do not trust the suffix
            with zipfile.ZipFile(path) as z:
                text = z.read(src.get("checks", {}).get("zip_member", "bst_all.txt")).decode("ascii")
        else:
            text = Path(path).read_text(encoding="ascii")
        storms = parse_bst(text.splitlines())
    except (ValueError, IndexError, KeyError, UnicodeDecodeError, zipfile.BadZipFile) as e:
        raise SchemaError(f"bst_all does not parse as the RSMC Tokyo best-track format: {e}") from None
    with_fixes = sum(1 for st in storms if st.fixes)
    if with_fixes < JMA_MIN_STORMS:
        raise SchemaError(f"bst_all has {with_fixes} storms with fixes (expected >= {JMA_MIN_STORMS})")
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
    return int(kit_main(args))


if __name__ == "__main__":
    sys.exit(main())
