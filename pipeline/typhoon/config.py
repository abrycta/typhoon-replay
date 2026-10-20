"""Paths and constants shared by the pipeline stages.

Everything the pipeline writes lives under the repo-root `data/` (gitignored):

    data/raw/<source>/...            downloads (typhoon.sources, with .provenance.json)
    data/processed/<stage>/...       intermediate Parquet per stage
    data/build/v<N>/...              a data version being assembled (typhoon.dataset)
    data/run-manifest.json           archivekit provenance of the current run
"""
from __future__ import annotations

import os
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = PIPELINE_DIR.parent
DATA = Path(os.environ.get("TYPHOON_DATA_DIR", REPO_ROOT / "data"))
RAW = DATA / "raw"
PROCESSED = DATA / "processed"
BUILD = DATA / "build"
CACHE = DATA / "cache"
RUN_MANIFEST = DATA / "run-manifest.json"
CROSSWALK_DIR = PIPELINE_DIR / "crosswalk"

KT = 0.514444            # m/s per knot
EARTH_R_KM = 6371.0088   # mean Earth radius (IUGG)
RADII_KM = (50, 100, 200, 300, 500)   # the contract's RadiusKm bands
FIRST_SEASON = 1940

HF_REPO = os.environ.get("TYPHOON_HF_REPO", "permission-alluring/typhoon-replay")
HF_BASE = f"https://huggingface.co/datasets/{HF_REPO}/resolve/main"

ERA5_CREDIT = "Contains modified Copernicus Climate Change Service information {years}"
ERA5_HONESTY = (
    "Wind and rain fields are ERA5 reanalysis (about 28 km grid). For intense typhoons it smooths the "
    "eye wall: the strongest ERA5 10 m wind near the centre is typically a third to a half of the "
    "best-track estimate, and its central pressure is tens of hPa too high. Use the best-track "
    "intensity (with its agency and averaging period) for peak strength, and the field for spatial "
    "extent and timing. Each storm's summary.json carries its own ERA5-vs-best-track ratios."
)


def ensure_dir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p
