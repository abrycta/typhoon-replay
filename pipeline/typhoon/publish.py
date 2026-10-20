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
import subprocess
import time
from pathlib import Path
from typing import Any

import httpx

from .config import BUILD, ERA5_HONESTY, HF_REPO, PIPELINE_DIR
from .dataset import check

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
    man = json.loads((vdir / "manifest.json").read_text())
    have = remote_paths("frames")
    frames = [r for r, f in man["files"].items() if r.startswith("frames/") and have.get(r) != f["bytes"]
              and (root / r).exists()]
    version_files = sorted(str(p.relative_to(root)) for p in vdir.rglob("*") if p.is_file())
    log.info("uploading %d new frame files and %d files of v%d to %s", len(frames), len(version_files), version, HF_REPO)
    push(root, sorted(frames), "frames")
    push(root, version_files, f"v{version}")


def verify(version: int, root: Path = BUILD, *, sample: str | None = None) -> dict[str, Any]:
    """Every manifest file exists remotely with the right size; Range and CORS work on a frame file."""
    man = json.loads((root / f"v{version}" / "manifest.json").read_text())
    remote = remote_paths(f"v{version}") | remote_paths("frames")
    bad = [p for p, f in man["files"].items() if remote.get(p) != f["bytes"]]
    if f"v{version}/manifest.json" not in remote:
        bad.append(f"v{version}/manifest.json")
    if bad:
        raise SystemExit(f"{len(bad)} files missing or wrong size remotely, e.g. {bad[:5]}")
    tyf = sample or next((p for p in man["files"] if p.endswith(".tyf")),
                         next(p for p in man["files"] if p.endswith(".webp")))
    info = man["files"][tyf]
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
    out = {"files": len(man["files"]), "sample": tyf, "sampleBytes": info["bytes"],
           "range_status": [first, r2.status_code], "range_bytes": len(r2.content),
           "content_range": r2.headers.get("content-range"), "cors_allow_origin": cors,
           "preflight_status": pre.status_code,
           "preflight_allow_headers": pre.headers.get("access-control-allow-headers"),
           "magic_ok": r.content[:4] == (b"TYF1" if is_tyf else b"RIFF")}
    if not (first == 206 and r2.status_code == 206 and len(r2.content) == size and cors and out["magic_ok"]):
        raise SystemExit(f"range/CORS check failed: {out}")
    return out


def card(version: int, man: dict[str, Any]) -> str:
    t = CARD_TEMPLATE.read_text()
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
    latest = {
        "schema": "typhoon-replay/latest@1", "version": version, "dataVersion": version, "path": f"v{version}/",
        "index": f"v{version}/index.json", "manifest": f"v{version}/manifest.json",
        "publishedAt": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "dataAsOf": man["provenance"].get("data_as_of"), "archiveUsed": man["provenance"].get("archive_used", False),
        "previous": prev.get("dataVersion") if prev else None, "note": note or None,
    }
    ops = [CommitOperationAdd("latest.json", json.dumps(latest, indent=1).encode()),
           CommitOperationAdd("README.md", card(version, man).encode())]
    a.create_commit(HF_REPO, repo_type="dataset", operations=ops,
                    commit_message=f"Publish data version {version}" + (f" ({note})" if note else ""))
    try:
        a.create_tag(HF_REPO, repo_type="dataset", tag=f"data-v{version}", exist_ok=True)
    except TypeError:  # older hub without exist_ok
        a.create_tag(HF_REPO, repo_type="dataset", tag=f"data-v{version}")
    return latest


def current() -> dict[str, Any] | None:
    r = httpx.get(resolve_url("latest.json"), follow_redirects=True, timeout=30)
    return dict(r.json()) if r.status_code == 200 else None


def input_changed(source_id: str) -> dict[str, Any]:
    """Whether the local copy of a source (just fetched) differs from what the published version used."""
    from .sources import local_path

    local = json.loads((local_path(source_id).with_name(local_path(source_id).name + ".provenance.json")).read_text())
    cur = current()
    used = None
    if cur:
        r = httpx.get(resolve_url(cur["manifest"]), follow_redirects=True, timeout=120)
        if r.status_code == 200:
            used = r.json()["provenance"]["inputs"].get(source_id, {}).get("sha256")
    return {"source": source_id, "changed": used != local["sha256"], "published": used, "local": local["sha256"]}


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
    ap.add_argument("cmd", choices=["upload", "verify", "flip", "rollback", "all", "current", "next-version", "changed"])
    ap.add_argument("--source", default="ibtracs-wp")
    ap.add_argument("--version", type=int)
    ap.add_argument("--to", type=int)
    a = ap.parse_args(argv)
    if a.cmd == "current":
        print(json.dumps(current(), indent=1))
    elif a.cmd == "changed":
        print(json.dumps(input_changed(a.source)))
    elif a.cmd == "next-version":
        cur = current()
        print(int(cur["dataVersion"]) + 1 if cur else 1)
    elif a.cmd == "rollback":
        print(json.dumps(rollback(a.to), indent=1))
    elif a.cmd == "upload":
        upload(a.version)
    elif a.cmd == "verify":
        print(json.dumps(verify(a.version), indent=1))
    elif a.cmd == "flip":
        check(BUILD / f"v{a.version}")
        print(json.dumps(verify(a.version), indent=1))
        print(json.dumps(flip(a.version), indent=1))
    else:
        print(json.dumps(check(BUILD / f"v{a.version}"), indent=1))
        upload(a.version)
        print(json.dumps(verify(a.version), indent=1))
        print(json.dumps(flip(a.version), indent=1))


if __name__ == "__main__":
    main()
