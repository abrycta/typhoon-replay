"""Chaos tests for the refresh's resilience fixes (R1-R4): malformed input, a changed shape, a dead source and
Hugging Face read errors must never publish a wrong version or turn a healthy run red."""
from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any

import httpx
import numpy as np
import pandas as pd
import pytest
from archivekit import SchemaError

from typhoon import __main__ as cli
from typhoon import dataset, era5, frames, jma, publish, sources
from typhoon.dataset import CheckFailed, PreviousUnreadable, compare_previous

NOW = np.datetime64("2026-10-23T12", "h")


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dataset.time, "sleep", lambda s: None)


# ----------------------------------------------------------------------------- R3: ERA5T end


def test_era5_end_reads_era5t_stop() -> None:
    end, how = era5.parse_era5_end({"valid_time_stop": "2026-06-30", "valid_time_stop_era5t": "2026-10-16"}, NOW)
    assert (end, how) == (np.datetime64("2026-10-16T23", "h"), "valid_time_stop_era5t")


@pytest.mark.parametrize("attrs", [
    {},                                                      # key renamed or removed (changed shape)
    {"valid_time_stop_era5t": "soon"},                      # malformed value
    {"valid_time_stop_era5t": "2027-01-01"},                # in the future: not trusted
    ["not", "a", "dict"],                                   # wrong JSON type
])
def test_era5_end_changed_or_malformed_metadata_falls_back(attrs: Any) -> None:
    end, how = era5.parse_era5_end(attrs, NOW)
    assert how.startswith("fallback") and end == NOW - np.timedelta64(era5.ERA5_LAG_FALLBACK_DAYS * 24, "h")


def test_era5_end_dead_store_never_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def dead(url: str, retries: int = 4) -> bytes:
        raise era5.LinkFailed(f"404 {url}")

    monkeypatch.setattr(era5, "get_all", dead)
    assert era5.era5_end(NOW) == NOW - np.timedelta64(era5.ERA5_LAG_FALLBACK_DAYS * 24, "h")


def test_storms_past_era5t_are_deferred_not_failed() -> None:
    st = pd.DataFrame({"sid": ["OLD", "LIVE"], "hours": [100, 50]})
    last = {"OLD": pd.Timestamp("2026-10-01T00"), "LIVE": pd.Timestamp("2026-10-20T06")}
    kept, late = cli.defer_past_era5(st, last, np.datetime64("2026-10-16T23", "h"))
    assert list(kept.sid) == ["OLD"] and late == ["LIVE"]


def test_one_failing_storm_does_not_sink_the_batch(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    sids = ["A", "B", "C", "D"]
    st = pd.DataFrame({"sid": sids, "name": sids, "season": [2026] * 4})
    hr = pd.DataFrame({"sid": sids, "time": pd.to_datetime(["2026-09-01"] * 4, utc=True)})
    monkeypatch.setattr("typhoon.catalog.load", lambda name: st if name == "storms" else hr)
    monkeypatch.setattr(frames, "OUT", tmp_path)
    monkeypatch.setattr(era5, "era5_end", lambda now=None: np.datetime64("2026-10-16T23", "h"))
    monkeypatch.setattr(frames, "validate_storm", lambda d: None)
    bad = {"B"}

    def build(sid: str, *a: Any, **k: Any) -> dict[str, Any]:
        (tmp_path / sid).mkdir()
        (tmp_path / sid / "frames.json").write_text("{}")   # half-built output must be removed
        if sid in bad:
            raise era5.LinkFailed("every link failed")
        return {"frames": 1, "era5VsBestTrack": {"headlineRatio": 0.5, "headlineAgency": "jma"}, "servedBy": {}}

    monkeypatch.setattr(frames, "build_storm", build)
    frames.main(["--sid", "A", "--sid", "B", "--sid", "C", "--sid", "D"])
    assert not (tmp_path / "B").exists() and (tmp_path / "A" / "frames.json").exists()
    bad |= {"A", "C"}   # more failures than the limit: the job fails loudly
    for d in tmp_path.iterdir():
        for f in d.iterdir():
            f.unlink()
        d.rmdir()
    with pytest.raises(SystemExit, match="frames failed for 3 of 4"):
        frames.main(["--sid", "A", "--sid", "B", "--sid", "C", "--sid", "D"])


# ----------------------------------------------------------------------------- R4: JMA hook and guard

HEADER = "66666 {id}  001 0001 {id} 0 6               NAME                20250101"
LINE = "25090100 002 5 108 1286  895     170"


def bst_zip(path: Path, text: str, member: str = "bst_all.txt") -> Path:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(member, text)
    path.write_bytes(buf.getvalue())
    return path


def good_bst(n: int) -> str:
    return "\n".join(f"{HEADER.format(id=f'{25 if i < 99 else 24}{i % 99 + 1:02d}')}\n{LINE}" for i in range(n))


SRC = {"id": "jma-rsmc-besttrack", "checks": {"zip_member": "bst_all.txt"}}


def test_jma_hook_accepts_a_full_file(tmp_path: Path) -> None:
    assert sources.check_jma(bst_zip(tmp_path / "tmp-download", good_bst(sources.JMA_MIN_STORMS)), SRC) == []


@pytest.mark.parametrize("case", ["garbage", "shifted-columns", "truncated", "renamed-member", "not-a-zip"])
def test_jma_hook_rejects_malformed_or_changed_files(tmp_path: Path, case: str) -> None:
    p = tmp_path / "tmp-download"
    if case == "garbage":
        bst_zip(p, "<html>Service unavailable</html>\n")
    elif case == "shifted-columns":   # a format change: the international number moved
        bst_zip(p, good_bst(sources.JMA_MIN_STORMS).replace("66666 ", "66666  X"))
    elif case == "truncated":
        bst_zip(p, good_bst(50))
    elif case == "renamed-member":
        bst_zip(p, good_bst(sources.JMA_MIN_STORMS), member="bst_all_2026.txt")
    else:
        p.write_bytes(b"\x00\x01binary")
    with pytest.raises(SchemaError):
        sources.check_jma(p, SRC)


def test_prepare_survives_a_dead_jma_source(monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
                                            capsys: pytest.CaptureFixture[str]) -> None:
    from typhoon import catalog, crosswalk, exposure, ibtracs, places, selection

    for mod, fn in ((ibtracs, "build"), (places, "build"), (places, "load"), (crosswalk, "build"),
                    (catalog, "build"), (exposure, "build"), (selection, "build")):
        monkeypatch.setattr(mod, fn, lambda *a, **k: None)
    monkeypatch.setattr(places, "OUT", tmp_path)
    monkeypatch.setattr(cli, "RUN_MANIFEST", tmp_path / "run.json")

    def ensure(sid: str, man: Any = None, refresh: bool = False) -> Path:
        if sid == "jma-rsmc-besttrack":
            raise sources.AllLinksFailed("jma-rsmc-besttrack: every link failed")
        return tmp_path

    monkeypatch.setattr(sources, "ensure", ensure)
    stale = tmp_path / "jma_numbers.parquet"
    stale.write_text("from an older run")
    monkeypatch.setattr(jma, "OUT", stale)
    monkeypatch.setattr(sources.RunManifest, "write", lambda self, p: None)
    cli.prepare(refresh=True)
    assert "::warning title=JMA numbers unavailable::" in capsys.readouterr().out
    assert not stale.exists()


# ----------------------------------------------------------------------------- R2: HF read errors


def fake_http(monkeypatch: pytest.MonkeyPatch, routes: dict[str, Any]) -> None:
    def get(url: str, **k: Any) -> httpx.Response:
        for suffix, r in routes.items():
            if url.endswith(suffix):
                if isinstance(r, Exception):
                    raise r
                code, body = r
                return httpx.Response(code, json=body) if body is not None else httpx.Response(code)
        return httpx.Response(404)

    monkeypatch.setattr(httpx, "get", get)


ROOT = "https://huggingface.co/datasets/x/resolve/main"


@pytest.mark.parametrize("failure", [(401, None), (403, None), (503, None), (429, None),
                                     httpx.ConnectError("dns"), (200, None)])
def test_hf_read_error_is_not_no_previous_version(monkeypatch: pytest.MonkeyPatch, failure: Any) -> None:
    if failure == (200, None):   # 200 with a body that is not JSON
        monkeypatch.setattr(httpx, "get", lambda url, **k: httpx.Response(200, text="<html>"))
    else:
        fake_http(monkeypatch, {"latest.json": failure})
    with pytest.raises(PreviousUnreadable):
        dataset.load_previous(ROOT)
    monkeypatch.setattr(publish, "resolve_url", lambda p, revision="main": f"{ROOT}/{p}")
    with pytest.raises(PreviousUnreadable):
        publish.current()


def test_missing_latest_with_published_versions_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_http(monkeypatch, {"v1/manifest.json": (200, {"dataVersion": 1})})
    with pytest.raises(PreviousUnreadable, match="v1/ exists"):
        dataset.load_previous(ROOT)
    monkeypatch.setattr(publish, "resolve_url", lambda p, revision="main": f"{ROOT}/{p}")
    with pytest.raises(PreviousUnreadable, match="v1/ exists"):
        publish.current()


def test_missing_frames_shard_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_http(monkeypatch, {
        "latest.json": (200, {"dataVersion": 4, "index": "v4/index.json", "path": "v4/"}),
        "v4/index.json": (200, {"storms": [{"sid": "S", "season": 2020, "replayAvailable": True}],
                                "framesIndexShards": "v4/frames-index/{season}.json"}),
    })
    with pytest.raises(PreviousUnreadable, match="shard"):
        dataset.load_previous(ROOT)


def test_unpublished_dataset_has_no_previous(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_http(monkeypatch, {})
    assert dataset.load_previous(ROOT) == (None, {})


def test_next_version_never_reuses_a_number() -> None:
    assert publish.next_version({"dataVersion": 4}, [1, 2, 3, 4]) == 5
    assert publish.next_version({"dataVersion": 4}, [1, 2, 3, 4, 5]) == 6   # v5 uploaded, never flipped
    assert publish.next_version(None, []) == 1
    with pytest.raises(PreviousUnreadable):
        publish.next_version(None, [1, 2, 3, 4])


def test_flip_never_rolls_latest_back(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    (tmp_path / "v1").mkdir()
    (tmp_path / "v1" / "manifest.json").write_text(json.dumps({"provenance": {}}))
    monkeypatch.setattr(publish, "api", lambda: object())
    monkeypatch.setattr(publish, "current", lambda: {"dataVersion": 4})
    with pytest.raises(SystemExit, match="refusing to flip"):
        publish.flip(1, tmp_path)


# ----------------------------------------------------------------------------- R1: compare with the published version


def index(n: int, *, drop: int = 0, unreplay: int = 0, unname: int = 0) -> dict[str, Any]:
    rows = [{"sid": f"S{i:04d}", "name": f"N{i}", "season": 2000, "replayAvailable": True, "trackHash": "h",
             "localNames": {"ph": "x", "ja": "y"}} for i in range(n)]
    rows = rows[drop:]
    for r in rows[:unreplay]:
        r["replayAvailable"] = False
    for r in rows[unreplay:unreplay + unname]:
        r["localNames"] = {"ph": "x"}
    return {"dataVersion": 5, "storms": rows}


def test_compare_allows_a_few_logged_changes(capsys: pytest.CaptureFixture[str]) -> None:
    out = compare_previous(index(2000, drop=3, unreplay=2, unname=1), index(2000), ib_sids={"S0001"})
    assert len(out["vanished"]) == 3 and out["problems"] == []
    assert out["vanished"]["S0000"].startswith("no longer in IBTrACS")
    assert out["vanished"]["S0001"].startswith("still in IBTrACS")
    assert "frames of an unchanged track were not reused" in out["lostReplay"].values()
    log = capsys.readouterr().out
    assert log.count("::warning title=storm vanished::") == 3 and "::warning title=storm lostNames::" in log


@pytest.mark.parametrize("kw", [{"drop": 100}, {"unreplay": 100}, {"unname": 100}])
def test_compare_stops_mass_loss(kw: dict[str, int]) -> None:
    with pytest.raises(CheckFailed, match="compared with the published version"):
        compare_previous(index(2000, **kw), index(2000))
    assert compare_previous(index(2000, **kw), index(2000), allow_shrink=True)["problems"]


def test_compare_without_previous_is_a_first_publish() -> None:
    assert compare_previous(index(10), None)["problems"] == []
