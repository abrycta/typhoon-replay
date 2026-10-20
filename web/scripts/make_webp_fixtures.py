"""Add the published WebP frame sets to the fixture dataset in web/fixtures/ (run after make_fixtures.py).

The pipeline publishes every storm's frames as lossy WebP field sheets (hourly) plus lossless WebP exact
sheets (3-hourly, 0.5 deg); the original .tyf is optional (pipeline/typhoon/frames.py). The fixture covers
both shapes the app must play:

- Haiyan (2013306N07162) keeps its 72-hour frames.tyf and gains the WebP sets, like the v1 storms that
  carry both formats.
- Goni (2020299N11144) gets WebP only (48 hours around its Catanduanes landfall), like the backfilled storms.

Frame files are written by the pipeline's own writer (`typhoon.frames.write_frames`) from the lossless .tyf
codes and laid out as published: content-addressed under fixtures/frames/<sid>/, referenced from the
summary as ../../../frames/<sid>/<file> (`typhoon.dataset.summary_frames`). Per-hour maxima (`series`) and
the ERA5-vs-best-track numbers are cropped from the published v1 summary, so they are the pipeline's values
from the unquantised fields.

Inputs (real data only): the fixture's own frames.tyf for Haiyan; for Goni the v1 .tyf and both v1 summaries
from the Hugging Face dataset (frames/<sid>/<hash>.tyf, v1/storms/<sid>/summary.json).

Usage (from web/):
  uv run --project ../pipeline python scripts/make_webp_fixtures.py \
      --haiyan-summary v1-haiyan-summary.json --goni-summary v1-goni-summary.json --goni-tyf goni.tyf
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB.parent / "pipeline"))

from typhoon.dataset import frames_entry, summary_frames  # noqa: E402
from typhoon.frames import ENC, dequantise, parse_tyf, uv_codes, var_meta, validate_storm, write_frames  # noqa: E402

OUT = WEB / "fixtures"
VERSION_DIR = "v1/"
HAIYAN = "2013306N07162"
GONI = ("2020299N11144", "2020-10-31T00:00:00Z", 48)


def unix(iso: str) -> int:
    return int(np.datetime64(iso.rstrip("Z"), "s").astype("int64"))


def crop_codes(tyf: bytes, start: int, n: int) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    h, q = parse_tyf(tyf)
    i0 = h["time"].index(start)
    names = [("tp" if v["name"] == "rain" else v["name"]) for v in h["vars"]]
    codes = {name: np.ascontiguousarray(q[i0:i0 + n, k]) for k, name in enumerate(names)}
    lat = (h.get("nw_lat") or h["nwLat"])[i0:i0 + n]
    lon = (h.get("nw_lon") or h["nwLon"])[i0:i0 + n]
    return {"time": h["time"][i0:i0 + n], "nw_lat": lat, "nw_lon": lon, "name": h.get("name"),
            "season": h.get("season")}, codes


def webp_frames(sid: str, meta: dict[str, Any], codes: dict[str, np.ndarray], published: dict[str, Any]) -> dict[str, Any]:
    """Write the WebP sets for the cropped codes; return the summary's `frames` record (WebP part)."""
    pub = published["frames"]
    j0 = pub["time"].index(meta["time"][0])
    n = len(meta["time"])
    assert pub["time"][j0:j0 + n] == meta["time"], f"{sid}: published frame times differ from the .tyf crop"
    series = {k: (v[j0:j0 + n] if isinstance(v, list) else v) for k, v in pub["series"].items()}
    check = {**published.get("era5VsBestTrack", {}), "series": series}
    if published.get("reanalysisCheck"):
        check["reanalysisCheck"] = published["reanalysisCheck"]
    fields = {e.name: dequantise(codes[e.name], e) for e in ENC}
    all_codes = {**codes, **uv_codes(fields["wind"], fields["wdir"])}
    hours = np.array(meta["time"], dtype="datetime64[s]").astype("datetime64[h]")
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / sid
        out.mkdir()
        m = write_frames(sid, all_codes, hours, np.array(meta["nw_lat"], float), np.array(meta["nw_lon"], float) % 360,
                         {"name": meta["name"], "season": meta["season"]}, pub["servedBy"], pub["quantisation"], check, out)
        validate_storm(out)
        dest = OUT / "frames" / sid
        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(parents=True)
        for f in out.glob("*.webp"):
            shutil.copy2(f, dest / f.name)
    fr = frames_entry(m, sid)
    sf = summary_frames(fr, f"{VERSION_DIR}storms/{sid}/")
    sf["era5VsBestTrack"] = fr["era5VsBestTrack"]
    return sf


def write_json(path: Path, doc: Any) -> None:
    path.write_text(json.dumps(doc, indent=1, ensure_ascii=False))


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--haiyan-summary", type=Path, required=True, help="v1/storms/2013306N07162/summary.json")
    ap.add_argument("--goni-summary", type=Path, required=True, help="v1/storms/2020299N11144/summary.json")
    ap.add_argument("--goni-tyf", type=Path, required=True, help="Goni's published v1 .tyf")
    a = ap.parse_args(argv)
    storms = OUT / VERSION_DIR / "storms"

    # Haiyan: both formats.
    sdir = storms / HAIYAN
    detail = json.loads((sdir / "summary.json").read_text())
    tyf = (sdir / "frames.tyf").read_bytes()
    meta, codes = crop_codes(tyf, unix(detail["frames"]["start"]), detail["frames"]["frames"])
    published = json.loads(a.haiyan_summary.read_text())
    sf = webp_frames(HAIYAN, meta, codes, published)
    sf.pop("era5VsBestTrack")
    old = detail["frames"]
    sf.update(format="tyf", path=old["path"], bytes=old["bytes"], sha256=old["sha256"],
              headerBytes=8 + int.from_bytes(tyf[4:8], "little"), frameBytes=len(ENC) * 81 * 81,
              vars=[var_meta(e) for e in ENC])
    detail["frames"] = sf
    write_json(sdir / "summary.json", detail)

    # Goni: WebP only (as published for backfilled storms).
    sid, start, n = GONI
    sdir = storms / sid
    detail = json.loads((sdir / "summary.json").read_text())
    published = json.loads(a.goni_summary.read_text())
    meta, codes = crop_codes(a.goni_tyf.read_bytes(), unix(start), n)
    sf = webp_frames(sid, meta, codes, published)
    detail["era5VsBestTrack"] = {k: v for k, v in sf.pop("era5VsBestTrack").items() if k != "reanalysisCheck"}
    detail.update(replayAvailable=True, frames=sf, frameCount=n, reanalysisCheck=published["reanalysisCheck"])
    era5 = next(s for s in json.loads((storms / HAIYAN / "summary.json").read_text())["sources"] if s["id"] == "era5")
    if not any(s["id"] == "era5" for s in detail["sources"]):
        detail["sources"].append(era5)
    write_json(sdir / "summary.json", detail)

    index_path = OUT / VERSION_DIR / "index.json"
    index = json.loads(index_path.read_text())
    for row in index["storms"]:
        if row["sid"] == sid:
            row.update(replayAvailable=True, frameCount=n)
    write_json(index_path, index)

    man_path = OUT / VERSION_DIR / "manifest.json"
    man = json.loads(man_path.read_text())
    man["note"] = ("Fixture: 16 storms with real IBTrACS tracks; ERA5 frames for Haiyan (72 h around landfall, "
                   ".tyf and WebP) and Goni (48 h around landfall, WebP only, as published for backfilled storms).")
    man["stormsWithFrames"] = 2
    write_json(man_path, man)
    print("fixtures: WebP frames for", HAIYAN, "and", sid)


if __name__ == "__main__":
    main()
