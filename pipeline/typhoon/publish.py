"""Publish a data version to the Hugging Face dataset, flip `latest.json` last, roll back by flipping back.

Usage:
  uv run python -m typhoon.publish upload --version 1     # v1/ (many commits; invisible until the flip)
  uv run python -m typhoon.publish flip --version 1       # README + latest.json in ONE commit, tag data-v1
  uv run python -m typhoon.publish verify --version 1     # remote sizes vs manifest, Range + CORS on a frame
  uv run python -m typhoon.publish rollback --to 1        # latest.json -> an older, still-present version
  uv run python -m typhoon.publish all --version 1        # check -> upload -> verify -> flip

Token: $HF_TOKEN, else the macOS Keychain (service `huggingface-token`). It is never printed.
The flip happens only after `typhoon.dataset.check` passed and every uploaded file matched the manifest,
so a half-uploaded or bad version is never what `latest.json` points at.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any

import httpx

from .config import BUILD, ERA5_HONESTY, HF_BASE, HF_REPO, PIPELINE_DIR
from .dataset import (
    PreviousUnreadable,
    check,
    compare_with_published,
    file_list,
    http_get,
)

log = logging.getLogger("typhoon.publish")
CARD_TEMPLATE = PIPELINE_DIR / "dataset_card.md"


def token() -> str:
    t = os.environ.get("HF_TOKEN")
    if t:
        return t
    try:
        return subprocess.run(["security", "find-generic-password", "-s", "huggingface-token", "-w"],
                              capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as e:
        raise SystemExit("HF_TOKEN is not set and no Keychain item 'huggingface-token' was found") from e


def api() -> Any:
    from huggingface_hub import HfApi

    return HfApi(token=token())


def resolve_url(path: str, revision: str = "main") -> str:
    return f"https://huggingface.co/datasets/{HF_REPO}/resolve/{revision}/{path}"


COMMIT_FILES = 99   # Hugging Face recommends commits of under 100 files


def remote_paths(prefix: str) -> dict[str, int]:
    """path -> size of every file under `prefix` in the dataset repo ({} if absent)."""
    try:
        return {f.path: f.size for f in api().list_repo_tree(HF_REPO, repo_type="dataset", path_in_repo=prefix,
                                                             recursive=True) if hasattr(f, "size")}
    except Exception:  # noqa: BLE001  (404 for a prefix that does not exist yet)
        return {}


def push(root: Path, rels: list[str], message: str) -> int:
    """Upload files (paths relative to `root` = repo paths) in commits of at most COMMIT_FILES files."""
    from huggingface_hub import CommitOperationAdd

    a = api()
    n = 0
    for i in range(0, len(rels), COMMIT_FILES):
        chunk = rels[i:i + COMMIT_FILES]
        ops = [CommitOperationAdd(path_in_repo=r, path_or_fileobj=str(root / r)) for r in chunk]
        for k in range(5):
            try:
                a.create_commit(HF_REPO, repo_type="dataset", operations=ops,
                                commit_message=f"{message} ({i // COMMIT_FILES + 1}/{-(-len(rels) // COMMIT_FILES)})")
                break
            except Exception as e:
                if k == 4:
                    raise
                log.warning("commit failed (%s); retrying", e)
                time.sleep(15 * (k + 1))
        n += len(chunk)
        log.info("uploaded %d/%d files", n, len(rels))
    return n


def upload(version: int, root: Path = BUILD) -> None:
    """Upload v<N>/ and every referenced frame file not yet in the repo (frames are content-addressed)."""
    a = api()
    a.create_repo(HF_REPO, repo_type="dataset", private=False, exist_ok=True)
    vdir = root / f"v{version}"
    if not (vdir / "manifest.json").exists():
        raise SystemExit(f"{vdir} is not built")
    files = local_files(version, root)
    shared = [r for r, f in files.items() if f.get("shared")]
    have: dict[str, int] = {}
    for top in sorted({r.split("/", 1)[0] for r in shared}):
        have |= remote_paths(top)
    frames = [r for r in shared if have.get(r) != files[r]["bytes"] and (root / r).exists()]
    version_files = sorted(str(p.relative_to(root)) for p in vdir.rglob("*") if p.is_file())
    log.info("uploading %d new shared files and %d files of v%d to %s", len(frames), len(version_files), version,
             HF_REPO)
    push(root, sorted(frames), "shared files")
    push(root, version_files, f"v{version}")


def verify(version: int, root: Path = BUILD, *, sample: str | None = None) -> dict[str, Any]:
    """Every manifest file exists remotely with the right size; Range and CORS work on a frame file."""
    files = local_files(version, root)
    remote = remote_paths(f"v{version}")
    for top in ("frames", "places", "tables"):
        remote |= remote_paths(top)
    bad = [p for p, f in files.items() if remote.get(p) != f["bytes"]]
    bad += [p for p in (f"v{version}/manifest.json", f"v{version}/files.json") if p not in remote]
    if bad:
        raise SystemExit(f"{len(bad)} files missing or wrong size remotely, e.g. {bad[:5]}")
    tyf = sample or next((p for p in files if p.endswith(".tyf")),
                         next(p for p in files if p.endswith(".webp")))
    info = files[tyf]
    hdr_len = None
    with httpx.Client(follow_redirects=True, timeout=60) as c:
        r = c.get(resolve_url(tyf), headers={"Range": "bytes=0-7", "Origin": "https://typhoon-replay.pages.dev"})
        is_tyf = tyf.endswith(".tyf")
        hdr_len = int.from_bytes(r.content[4:8], "little") if is_tyf else 0
        cors = r.headers.get("access-control-allow-origin")
        first = r.status_code
        # one hour of frames, by range, as the web loader does
        start = 8 + hdr_len + 10 * 5 * 81 * 81 if is_tyf else 100
        size = 5 * 81 * 81 if is_tyf else 1000
        r2 = c.get(resolve_url(tyf), headers={"Range": f"bytes={start}-{start + size - 1}",
                                              "Origin": "https://typhoon-replay.pages.dev"})
        pre = c.options(resolve_url(tyf), headers={"Origin": "https://typhoon-replay.pages.dev",
                                                   "Access-Control-Request-Method": "GET",
                                                   "Access-Control-Request-Headers": "range"})
    out = {"files": len(files), "sample": tyf, "sampleBytes": info["bytes"],
           "range_status": [first, r2.status_code], "range_bytes": len(r2.content),
           "content_range": r2.headers.get("content-range"), "cors_allow_origin": cors,
           "preflight_status": pre.status_code,
           "preflight_allow_headers": pre.headers.get("access-control-allow-headers"),
           "magic_ok": r.content[:4] == (b"TYF1" if is_tyf else b"RIFF")}
    if not (first == 206 and r2.status_code == 206 and len(r2.content) == size and cors and out["magic_ok"]):
        raise SystemExit(f"range/CORS check failed: {out}")
    return out


def local_files(version: int, root: Path = BUILD) -> dict[str, dict[str, Any]]:
    man = json.loads((root / f"v{version}" / "manifest.json").read_text())
    return file_list(man, lambda rel: json.loads((root / rel).read_text()))


def card(version: int, man: dict[str, Any], root: Path = BUILD) -> str:
    t = CARD_TEMPLATE.read_text()
    tj = root / f"v{version}" / "tables.json"
    table_paths = json.loads(tj.read_text())["tables"] if tj.exists() else {}
    configs = "\n".join(f"- config_name: {name}\n  data_files:\n" + "\n".join(f'  - "{p}"' for p in paths)
                        for name, paths in table_paths.items()) or "[]"
    t = t.replace("{{CONFIGS}}", configs)
    attributions = "\n".join(f"| `{a['id']}` | {a['licence']} | {a['attribution']} |" for a in man["attribution"]
                             if a["kind"] not in ("live-feed",))
    counts = man["counts"]["tables"]
    return (t.replace("{{VERSION}}", str(version)).replace("{{CREATED}}", man["createdAt"])
            .replace("{{STORMS}}", f"{man['counts']['storms']:,}").replace("{{REPLAY}}", str(man["era5"]["stormsWithFrames"]))
            .replace("{{PLACES}}", f"{counts['places']['rows']:,}").replace("{{EXPOSURE}}", f"{counts['exposure']['rows']:,}")
            .replace("{{FIXES}}", f"{counts['storm_fixes']['rows']:,}").replace("{{HONESTY}}", ERA5_HONESTY)
            .replace("{{MEDIAN_RATIO}}", str(man["era5"]["medianHeadlineRatio"]))
            .replace("{{DATA_AS_OF}}", str(man["provenance"].get("data_as_of") or man["createdAt"][:10]))
            .replace("{{ATTRIBUTIONS}}", attributions))


def flip(version: int, root: Path = BUILD, *, note: str = "") -> dict[str, Any]:
    from huggingface_hub import CommitOperationAdd

    a = api()
    man = json.loads((root / f"v{version}" / "manifest.json").read_text())
    prev = current()
    if prev and int(prev["dataVersion"]) > version and not note.startswith("rollback"):
        raise SystemExit(f"refusing to flip latest.json from v{prev['dataVersion']} back to v{version} "
                         "(use `publish rollback --to N` to go back on purpose)")
    latest = {
        "schema": "typhoon-replay/latest@1", "version": version, "dataVersion": version, "path": f"v{version}/",
        "index": f"v{version}/index.json", "manifest": f"v{version}/manifest.json",
        "publishedAt": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "dataAsOf": man["provenance"].get("data_as_of"), "archiveUsed": man["provenance"].get("archive_used", False),
        "previous": prev.get("dataVersion") if prev else None, "note": note or None,
    }
    ops = [CommitOperationAdd("latest.json", json.dumps(latest, indent=1).encode()),
           CommitOperationAdd("README.md", card(version, man, root).encode())]
    a.create_commit(HF_REPO, repo_type="dataset", operations=ops,
                    commit_message=f"Publish data version {version}" + (f" ({note})" if note else ""))
    try:
        a.create_tag(HF_REPO, repo_type="dataset", tag=f"data-v{version}", exist_ok=True)
    except TypeError:  # older hub without exist_ok
        a.create_tag(HF_REPO, repo_type="dataset", tag=f"data-v{version}")
    return latest


def current() -> dict[str, Any] | None:
    """The published latest.json, or None only when the repo has never been published (404 and no v1/).

    Any other failure raises (R2): treating a 401, a 5xx or a network error as "no previous version" used to
    make next-version print 1, overwrite v1 and flip latest.json back to it."""
    r = http_get(resolve_url("latest.json"), timeout=30)
    if r.status_code == 404:
        if http_get(resolve_url("v1/manifest.json"), timeout=30).status_code != 404:
            raise PreviousUnreadable("latest.json is missing but v1/ exists; refusing to start again at v1")
        return None
    if r.status_code != 200:
        raise PreviousUnreadable(f"latest.json: HTTP {r.status_code}")
    try:
        d = r.json()
        int(d["dataVersion"])
    except (ValueError, KeyError, TypeError) as e:
        raise PreviousUnreadable(f"latest.json is malformed: {r.text[:200]!r}") from e
    return dict(d)


def published_versions() -> list[int]:
    """Version numbers with a v<N>/ folder in the dataset repo (raises when the listing fails)."""
    names = [f.path for f in api().list_repo_tree(HF_REPO, repo_type="dataset", recursive=False)]
    return sorted(int(m.group(1)) for n in names if (m := re.fullmatch(r"v(\d+)", n)))


def next_version(cur: dict[str, Any] | None, existing: list[int]) -> int:
    """One more than both latest.json and every v<N>/ already in the repo, so a version is never overwritten."""
    if cur is None and existing:
        raise PreviousUnreadable(f"latest.json is missing but versions {existing[-3:]} exist")
    return max([0, *existing] + ([int(cur["dataVersion"])] if cur else [])) + 1


def input_changed(source_id: str) -> dict[str, Any]:
    """Whether the local copy of a source (just fetched) differs from what the published version used."""
    from .sources import local_path

    local = json.loads((local_path(source_id).with_name(local_path(source_id).name + ".provenance.json")).read_text())
    cur = current()
    used = None
    if cur:
        r = http_get(resolve_url(cur["manifest"]))
        if r.status_code != 200:
            raise PreviousUnreadable(f"{cur['manifest']}: HTTP {r.status_code}")
        used = r.json()["provenance"]["inputs"].get(source_id, {}).get("sha256")
    return {"source": source_id, "changed": used != local["sha256"], "published": used, "local": local["sha256"]}


def prune(keep: int, *, squash: bool = False, dry_run: bool = True) -> dict[str, Any]:
    """Delete version directories older than the newest `keep` (never the published one) and every shared
    content-addressed file no kept version references. `squash` then rewrites the repo history into one
    commit, which is what actually frees storage on the Hub (deleted files otherwise stay in history)."""
    from huggingface_hub import CommitOperationDelete

    a = api()
    files = [f.path for f in a.list_repo_tree(HF_REPO, repo_type="dataset", recursive=True) if hasattr(f, "size")]
    versions = sorted({int(m.group(1)) for f in files if (m := re.match(r"v(\d+)/", f))})
    cur = current()
    kept = set(versions[-keep:]) | ({int(cur["dataVersion"])} if cur else set())
    referenced: set[str] = set()
    for v in kept:
        r = http_get(resolve_url(f"v{v}/manifest.json"))
        if r.status_code != 200:   # R2: an unreadable kept version must not let its frames be deleted
            raise PreviousUnreadable(f"v{v}/manifest.json: HTTP {r.status_code}; nothing pruned")
        vfiles = file_list(r.json(), lambda rel: httpx.get(resolve_url(rel), follow_redirects=True,
                                                           timeout=120).raise_for_status().json())
        referenced |= {k for k, f in vfiles.items() if f.get("shared")}
    drop = [f for f in files if (m := re.match(r"v(\d+)/", f)) and int(m.group(1)) not in kept]
    drop += [f for f in files if f.split("/", 1)[0] in ("frames", "places", "tables") and f not in referenced]
    out = {"versions": versions, "kept": sorted(kept), "delete": len(drop), "dryRun": dry_run}
    if not dry_run and drop:
        for i in range(0, len(drop), 500):
            a.create_commit(HF_REPO, repo_type="dataset", commit_message=f"prune: keep v{sorted(kept)}",
                            operations=[CommitOperationDelete(path_in_repo=f) for f in drop[i:i + 500]])
        if squash:
            a.super_squash_history(HF_REPO, repo_type="dataset", commit_message="Squash history after pruning")
    return out


def rollback(to: int) -> dict[str, Any]:
    """Point latest.json at an older version that is still in the repo (nothing is deleted)."""
    r = httpx.get(resolve_url(f"v{to}/manifest.json"), follow_redirects=True, timeout=60)
    if r.status_code != 200:
        raise SystemExit(f"v{to} is not in {HF_REPO}")
    root = BUILD / "_rollback"
    (root / f"v{to}").mkdir(parents=True, exist_ok=True)
    (root / f"v{to}" / "manifest.json").write_bytes(r.content)
    return flip(to, root, note=f"rollback to v{to}")


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["upload", "verify", "flip", "rollback", "all", "current", "next-version", "changed",
                                        "prune"])
    ap.add_argument("--keep", type=int, default=4)
    ap.add_argument("--apply", action="store_true", help="prune: actually delete (default: dry run)")
    ap.add_argument("--squash", action="store_true", help="prune: squash history to free storage")
    ap.add_argument("--source", default="ibtracs-wp")
    ap.add_argument("--version", type=int)
    ap.add_argument("--to", type=int)
    a = ap.parse_args(argv)
    if a.cmd == "current":
        print(json.dumps(current(), indent=1))
    elif a.cmd == "prune":
        print(json.dumps(prune(a.keep, squash=a.squash, dry_run=not a.apply), indent=1))
    elif a.cmd == "changed":
        print(json.dumps(input_changed(a.source)))
    elif a.cmd == "next-version":
        print(next_version(current(), published_versions()))
    elif a.cmd == "rollback":
        print(json.dumps(rollback(a.to), indent=1))
    elif a.cmd == "upload":
        upload(a.version)
    elif a.cmd == "verify":
        print(json.dumps(verify(a.version), indent=1))
    elif a.cmd == "flip":
        check(BUILD / f"v{a.version}")
        compare_with_published(BUILD / f"v{a.version}", HF_BASE)   # R1: against what is live right now
        print(json.dumps(verify(a.version), indent=1))
        print(json.dumps(flip(a.version), indent=1))
    else:
        print(json.dumps(check(BUILD / f"v{a.version}"), indent=1))
        compare_with_published(BUILD / f"v{a.version}", HF_BASE)
        upload(a.version)
        print(json.dumps(verify(a.version), indent=1))
        print(json.dumps(flip(a.version), indent=1))


if __name__ == "__main__":
    main()
