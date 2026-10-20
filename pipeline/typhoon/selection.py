"""Which storms get animated ERA5 frames: a transparent selection score (about 1,000 of the catalogue).

Usage: uv run python -m typhoon.selection [--target 1000]   -> data/processed/catalog/selection.parquet (+ .json)

Every catalogue storm (PH/JP-affecting, since 1940) keeps its summary, best track, landfalls and exposure.
Frames cost storage, so they go to the storms people are most likely to look for. The score (0-100) is the
sum of:

  landfall      40  made landfall in PH or JP (+5 more when it hit both)
  intensity     25  peak sustained wind, preferred agency, linear from 34 kt (0) to 150 kt (25)
  impact        15  places whose boundary the centre passed within 50 km, log-scaled (0 places -> 0,
                    300+ places -> 15): a population-free proxy for how much land the core crossed
  local name     8  PAGASA-named (5 if it only entered the PAR without a name)
  recency        7  linear from 1940 (0) to the latest season (7): newer storms have better data

Notability from deaths or damage is not used: no open, citable, machine-readable source covers the
whole period consistently.

Selection: the curated v1 list (curated/replay-v1.txt) is always in. Every decade then gets at least
`min(its storms, decade_floor)` of its best-scoring storms, so no decade is starved; the rest of the target
is filled by score. Ties break by SID.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from . import catalog, exposure
from .config import PIPELINE_DIR, PROCESSED

log = logging.getLogger("typhoon.selection")
OUT = PROCESSED / "catalog"
CURATED = PIPELINE_DIR / "curated/replay-v1.txt"
WEIGHTS = {"landfall": 40, "bothCountries": 5, "intensity": 25, "impact": 15, "pagasaNamed": 8, "enteredPar": 5,
           "recency": 7}
DECADE_FLOOR = 60


def read_list(path: Path) -> list[str]:
    return [s for line in path.read_text().splitlines() if (s := line.split("#", 1)[0].strip())]


def scores(storms: pd.DataFrame, ex: pd.DataFrame) -> pd.DataFrame:
    s = storms.set_index("sid")
    near = ex[ex.closest_approach_km <= 50].groupby("sid").size().reindex(s.index, fill_value=0)
    lf = s.landfall_countries.map(len)
    peak = s.peak_wind_kt.astype(float).fillna(0)
    last = int(s.season.max())
    w = WEIGHTS
    out = pd.DataFrame({
        "landfall": np.where(lf > 0, w["landfall"], 0) + np.where(lf > 1, w["bothCountries"], 0),
        "intensity": (np.clip((peak - 34) / (150 - 34), 0, 1) * w["intensity"]).round(2),
        "impact": (np.clip(np.log1p(near) / math.log1p(300), 0, 1) * w["impact"]).round(2),
        "localName": np.where(s.name_pagasa.notna(), w["pagasaNamed"], np.where(s.entered_par, w["enteredPar"], 0)),
        "recency": ((s.season - 1940) / max(last - 1940, 1) * w["recency"]).round(2),
        "placesWithin50Km": near, "season": s.season, "name": s["name"],
    }, index=s.index)
    out["score"] = out[["landfall", "intensity", "impact", "localName", "recency"]].sum(axis=1).round(2)
    return out


def select(sc: pd.DataFrame, target: int, curated: list[str], decade_floor: int = DECADE_FLOOR) -> pd.DataFrame:
    sc = sc.copy()
    sc["decade"] = (sc.season // 10 * 10).astype(int)
    order = sc.sort_values(["score", "season"], ascending=[False, False]).index
    chosen: dict[str, str] = {sid: "curated" for sid in curated if sid in sc.index}
    for _d, g in sc.loc[order].groupby("decade", sort=True):
        for sid in g.index[:decade_floor]:
            chosen.setdefault(sid, "decade-floor")
    for sid in order:
        if len(chosen) >= target:
            break
        chosen.setdefault(sid, "score")
    sc["selected"] = sc.index.isin(list(chosen))
    sc["reason"] = sc.index.map(lambda s: chosen.get(s))
    sc["rank"] = sc.score.rank(ascending=False, method="first").astype(int)
    return sc.sort_values("rank")


def build(target: int = 1000) -> pd.DataFrame:
    sel = select(scores(catalog.load("storms"), exposure.load()), target, read_list(CURATED))
    sel.reset_index().to_parquet(OUT / "selection.parquet", index=False)
    summary = describe(sel, target)
    (OUT / "selection.json").write_text(json.dumps(summary, indent=1))
    log.info("selection: %d of %d storms", int(sel.selected.sum()), len(sel))
    return sel


def describe(sel: pd.DataFrame, target: int) -> dict[str, Any]:
    by_dec = sel.groupby("decade").agg(storms=("score", "size"), selected=("selected", "sum"))
    return {
        "rule": (__doc__ or "").split("\n\n", 1)[1].strip(), "weights": WEIGHTS, "decadeFloor": DECADE_FLOOR,
        "target": target, "selected": int(sel.selected.sum()), "storms": len(sel),
        "byDecade": {int(d): {"storms": int(r.storms), "selected": int(r.selected)} for d, r in by_dec.iterrows()},
        "byReason": sel.reason.value_counts().to_dict(),
        "minSelectedScore": float(sel[sel.selected].score.min()),
        "selectedSids": sel[sel.selected].index.tolist(),
    }


def load() -> pd.DataFrame:
    return pd.read_parquet(OUT / "selection.parquet").set_index("sid")


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", type=int, default=1000)
    a = ap.parse_args(argv)
    sel = build(a.target)
    d = describe(sel, a.target)
    print(json.dumps({k: v for k, v in d.items() if k not in ("rule", "selectedSids")}, indent=1))
    print(sel[sel.selected].head(15)[["name", "season", "score", "reason"]].to_string())


if __name__ == "__main__":
    main()
