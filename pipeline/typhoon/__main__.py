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
    plan --batches N [--list FILE] [--mode all|missing|changed --previous ROOT] [--canary 0.05]
                               balanced batches (+ canary batches c0, c1, ... run first by backfill.yml)
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
from typing import Any

from .config import RUN_MANIFEST


def prepare(refresh: bool) -> None:
    from . import catalog, crosswalk, exposure, ibtracs, jma, places, sources

    man = sources.RunManifest()
    ibtracs.build(man, refresh=refresh)
    places.load() if (places.OUT / "places.parquet").exists() else places.build(man)
    for sid in ("geoboundaries-phl-adm3", "hdx-cod-ab-phl-tabular", "psgc-cities-municipalities", "mlit-n03-jpn",
                "geoboundaries-jpn-adm2", "naturalearth-50m-coastline"):
        sources.ensure(sid, man)
    try:   # R4: JMA numbers are an extra; a dead or changed JMA source must not stop the refresh
        sources.ensure("jma-rsmc-besttrack", man, refresh=refresh)
        jma.build(verbose=False)
    except Exception as e:  # noqa: BLE001
        jma.OUT.unlink(missing_ok=True)   # never let catalog read numbers from an older, unrelated run
        print(f"::warning title=JMA numbers unavailable::{type(e).__name__}: {e}. The catalogue is built without "
              "them; dataset.compare_previous stops the publish if storms lose their JMA designation.")
    crosswalk.build()
    catalog.build()
    exposure.build()
    from . import selection

    selection.build()
    man.write(RUN_MANIFEST)


def carve_canary(batches: dict[str, list[str]], hours: dict[str, int], fraction: float,
                 jobs: int = 4) -> dict[str, list[str]]:
    """Move about `fraction` of the planned storm-hours into canary batches "c0".."c<jobs-1>".

    The canary is a stratified sample: every k-th storm by length (k = 1/fraction), so it holds long and short
    storms alike. backfill.yml builds, validates and uploads the canary batches with the same checks as the
    others and starts the full run only if all of them pass. Storms move, not copy, so no work is repeated.
    """
    if fraction <= 0:
        return batches
    ranked = sorted((sid for b in batches.values() for sid in b), key=lambda sid: (-hours[sid], sid))
    if not ranked:
        return batches
    step = max(1, round(1 / fraction))
    picks = ranked[step // 2::step] or ranked[:1]
    chosen = set(picks)
    out = {k: [sid for sid in v if sid not in chosen] for k, v in batches.items()}
    n = max(1, min(jobs, len(picks)))
    loads = [0] * n
    canary: list[list[str]] = [[] for _ in range(n)]
    for sid in picks:  # longest first: greedy balance, as plan() does
        i = loads.index(min(loads))
        canary[i].append(sid)
        loads[i] += hours[sid]
    out.update({f"c{i}": c for i, c in enumerate(canary)})
    return out


def defer_past_era5(st: Any, last_hour: dict[str, Any], end: Any) -> tuple[Any, list[str]]:
    """Drop storms whose track runs past the last hour ERA5 can serve (R3): their frames would be partly
    nodata and fail the run. They have no published frames, so the next refresh picks them up again."""
    import numpy as np

    late = sorted(sid for sid in st.sid if np.datetime64(last_hour[sid], "h") > end)
    for sid in late:
        print(f"::notice title=frames deferred::{sid} runs to {last_hour[sid]}, past the end of ERA5T ({end}); "
              "its replay is built by a later refresh")
    return st[~st.sid.isin(late)], late


def plan(batches: int, list_file: Path | None, previous: str | None, mode: str = "all",
         selected: bool = False, canary: float = 0.0, canary_jobs: int = 4,
         era5_end: Any = None) -> dict[str, list[str]]:
    """Greedy longest-first split of storms into `batches` with balanced storm-hours.

    mode "all": every selected storm; "missing" (backfill): storms whose published frames are absent or
    stale; "changed" (weekly refresh): storms without published frames (new since the previous version, or
    deferred / failed in an earlier refresh), plus storms whose published frames are stale because IBTrACS
    revised the track. Stale = the hourly track hash changed. Storms that run past the end of ERA5T are
    deferred in every mode (`era5_end`, default: read from ARCO-ERA5).
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
    hr = catalog.load("hourly")
    hr = hr[hr.sid.isin(st.sid)]
    if mode != "all":
        _, prev_frames = load_previous(previous)
        keep = []
        for sid, h in hr.groupby("sid"):
            stale = sid in prev_frames and prev_frames[sid]["trackHash"] != track_hash(h)
            if sid not in prev_frames or stale:   # "missing" and "changed" agree since every storm gets frames
                keep.append(sid)
        st = st[st.sid.isin(keep)]
    if era5_end is None:
        from .era5 import era5_end as read_end

        era5_end = read_end()
    last_hour = {str(k): v for k, v in hr.groupby("sid").time.max().dt.tz_convert("UTC").dt.tz_localize(None).items()}
    st, _ = defer_past_era5(st, last_hour, era5_end)
    loads = [0] * batches
    out: dict[str, list[str]] = {str(i): [] for i in range(batches)}
    for sid, hours in zip(st.sort_values("hours", ascending=False).sid, st.sort_values("hours", ascending=False).hours, strict=True):
        i = loads.index(min(loads))
        out[str(i)].append(str(sid))
        loads[i] += int(hours)
    return carve_canary(out, {str(k): int(v) for k, v in zip(st.sid, st.hours, strict=True)}, canary, canary_jobs)


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
        ap.add_argument("--canary", type=float, default=0.0,
                        help="share of storm-hours moved into canary batches c0, c1, ... (e.g. 0.05)")
        ap.add_argument("--canary-jobs", type=int, default=4, help="number of canary batches (run in parallel)")
        ap.add_argument("--out", type=Path)
        a = ap.parse_args(rest)
        p = plan(a.batches, a.list, a.previous, a.mode, a.selected, a.canary, a.canary_jobs)
        text = json.dumps(p)
        if a.out:
            a.out.write_text(text)
        print(json.dumps({k: len(v) for k, v in p.items()}))
        return 0
    print(f"unknown stage {cmd!r}\n{__doc__}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
