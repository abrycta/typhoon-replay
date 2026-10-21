"""Replay pipeline CLI: `uv run python -m typhoon <stage> [...]` (run from pipeline/).

Stages, in order (each reads the previous stages' Parquet under data/processed/):

    sources <archivekit cmd>   registry tools (fetch, validate-registry, health, restore, ...)
    ibtracs [--refresh]        IBTrACS WP (through archivekit) -> fixes/storms Parquet
    places                     PH ADM3 + JP municipalities with codes and geometry
    jma                        JMA typhoon numbers (RSMC Tokyo best track)
    crosswalk [build|scrape]   PAGASA names (curated seed + Wikipedia season pages)
    catalog                    storm catalogue, hourly tracks, landfalls
    exposure                   place x storm exposure bands
    selection [--target 1000]  which storms get frames (documented score, decade floor)
    prepare [--refresh]        all of the above, in order (what CI's prepare job runs)
    plan --batches N [--list FILE] [--mode all|missing|changed --previous ROOT]   balanced batches
    frames --sid S | --list FILE | --batch I --plan FILE   ERA5 frames per storm
    dataset build|check --version N [--previous ROOT] [--frames-uploaded]
    publish upload|verify|flip|rollback|current|all
    dbload --dsn DSN --tables DIR --ibtracs-version v04r01
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from .config import RUN_MANIFEST


def prepare(refresh: bool) -> None:
    from . import catalog, crosswalk, exposure, ibtracs, jma, places, sources

    man = sources.RunManifest()
    ibtracs.build(man, refresh=refresh)
    places.load() if (places.OUT / "places.parquet").exists() else places.build(man)
    for sid in ("geoboundaries-phl-adm3", "hdx-cod-ab-phl-tabular", "psgc-cities-municipalities", "mlit-n03-jpn",
                "geoboundaries-jpn-adm2", "naturalearth-50m-coastline"):
        sources.ensure(sid, man)
    sources.ensure("jma-rsmc-besttrack", man, refresh=refresh)
    jma.build(verbose=False)
    crosswalk.build()
    catalog.build()
    exposure.build()
    from . import selection

    selection.build()
    man.write(RUN_MANIFEST)


def plan(batches: int, list_file: Path | None, previous: str | None, mode: str = "all",
         selected: bool = False) -> dict[str, list[str]]:
    """Greedy longest-first split of storms into `batches` with balanced storm-hours.

    mode "all": every selected storm; "missing" (backfill): storms whose published frames are absent or
    stale; "changed" (weekly refresh): storms new since the previous version, plus storms whose published
    frames are stale because IBTrACS revised the track. Stale = the hourly track hash changed.
    """
    from . import catalog
    from .dataset import load_previous, track_hash
    from .frames import read_list

    st = catalog.load("storms")
    if list_file:
        st = st[st.sid.isin(read_list(list_file))]
    if selected:
        from . import selection

        sel = selection.load()
        st = st[st.sid.isin(sel[sel.selected].index)]
    if mode != "all":
        prev_index, prev_frames = load_previous(previous)
        known = set()
        if prev_index:
            known = {r["sid"] for r in prev_index["storms"]}
        hr = catalog.load("hourly")
        keep = []
        for sid, h in hr[hr.sid.isin(st.sid)].groupby("sid"):
            stale = sid in prev_frames and prev_frames[sid]["trackHash"] != track_hash(h)
            if mode == "missing" and (sid not in prev_frames or stale) or mode == "changed" and (sid not in known or stale):
                keep.append(sid)
        st = st[st.sid.isin(keep)]
    loads = [0] * batches
    out: dict[str, list[str]] = {str(i): [] for i in range(batches)}
    for sid, hours in zip(st.sort_values("hours", ascending=False).sid, st.sort_values("hours", ascending=False).hours, strict=True):
        i = loads.index(min(loads))
        out[str(i)].append(str(sid))
        loads[i] += int(hours)
    return out


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd, rest = args[0], args[1:]
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("fsspec").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if cmd == "sources":
        from .sources import main as m
        return m(rest)
    if cmd in ("ibtracs", "places", "jma", "crosswalk", "catalog", "exposure", "selection", "frames", "dataset", "publish",
               "dbload"):
        import importlib

        mod = importlib.import_module(f"typhoon.{cmd}")
        r = mod.main(rest) if cmd not in ("places", "catalog", "exposure") else mod.main()
        return int(r or 0)
    if cmd == "prepare":
        ap = argparse.ArgumentParser(prog="typhoon prepare")
        ap.add_argument("--refresh", action="store_true")
        prepare(ap.parse_args(rest).refresh)
        return 0
    if cmd == "plan":
        ap = argparse.ArgumentParser(prog="typhoon plan")
        ap.add_argument("--batches", type=int, required=True)
        ap.add_argument("--list", type=Path)
        ap.add_argument("--mode", choices=["all", "missing", "changed"], default="all")
        ap.add_argument("--previous", help="dataset root (URL or dir) of the published version, for --mode")
        ap.add_argument("--selected", action="store_true", help="only storms chosen by typhoon.selection")
        ap.add_argument("--out", type=Path)
        a = ap.parse_args(rest)
        p = plan(a.batches, a.list, a.previous, a.mode, a.selected)
        text = json.dumps(p)
        if a.out:
            a.out.write_text(text)
        print(json.dumps({k: len(v) for k, v in p.items()}))
        return 0
    print(f"unknown stage {cmd!r}\n{__doc__}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
