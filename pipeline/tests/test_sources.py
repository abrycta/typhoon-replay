"""Replay's use of archivekit: the registry, the IBTrACS hook and the fallback chain as wired here.

The kit's own suite covers every failure type in depth; these tests pin the project's configuration.
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import httpx
import pytest
import respx
import zstandard

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # pipeline/ is not an installed package
import archivekit

from typhoon import sources as S

WP = "https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.WP.list.v04r01.csv"
ALL = WP.replace("ibtracs.WP.list", "ibtracs.ALL.list")
API = "https://api.github.com/repos/abrycta/typhoon-replay-archive"
HEADER = (Path(__file__).resolve().parents[2] / "data/raw/ibtracs/ibtracs.WP.list.v04r01.csv")


def ibtracs_bytes(n: int = 300, basin: str = "WP", bad_sid: bool = False, day: str = "306") -> bytes:
    """A tiny IBTrACS-shaped CSV with the real 174-column header (fingerprint must match)."""
    reg = S.registry()
    cols = reg.source("ibtracs-wp")["checks"]["required_columns"]
    header = _real_header() or ",".join(cols)
    names = header.split(",")
    rows = []
    for i in range(n):
        vals = dict.fromkeys(names, " ")
        vals.update(SID=("BAD" if bad_sid else f"2013{day}N{i:05d}"), SEASON="2013", BASIN=basin,
                    ISO_TIME="2013-11-07 18:00:00", LAT="11.0", LON="125.0", NAME="HAIYAN")
        rows.append(",".join(vals[c] for c in names))
    units = ",".join(" " for _ in names)
    return ("\n".join([header, units, *rows]) + "\n").encode()


def _real_header() -> str | None:
    return HEADER.open().readline().rstrip("\n") if HEADER.exists() else None


@pytest.fixture
def small_registry(tmp_path: Path) -> archivekit.Registry:
    """The real registry with size/row bounds shrunk so a 300-row fixture is 'valid'."""
    import copy

    reg = S.registry()
    raw = copy.deepcopy(reg.raw)
    for s in raw["sources"]:
        if s["id"] in ("ibtracs-wp", "ibtracs-all"):
            s["checks"]["bytes"] = {"min": 100, "max": 10_000_000}
            s["checks"]["rows"] = {"min": 100, "max": 10_000}
            if not _real_header():
                s["checks"].pop("header_sha256")
    return archivekit.Registry(raw, "test", tmp_path)


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ARCHIVE_READ_TOKEN", "t")
    for v in ("GITHUB_ACTIONS", "CI", "GITHUB_REPOSITORY", "GITHUB_TOKEN"):
        monkeypatch.delenv(v, raising=False)


def test_registry_is_valid_and_complete() -> None:
    reg = S.registry()
    assert archivekit.validate_registry(reg.raw) == []
    ids = {s["id"] for s in reg.sources}
    assert {"ibtracs-wp", "ibtracs-all", "era5-an-sfc", "era5-fc-gust", "era5-fc-precip-rate",
            "geoboundaries-phl-adm3", "geoboundaries-jpn-adm2", "hdx-cod-ab-phl-tabular", "mlit-n03-jpn",
            "jma-rsmc-besttrack", "naturalearth-50m-coastline", "naturalearth-50m-countries", "pagasa-crosswalk",
            "wikipedia-season-pages", "jtwc-rss", "jma-bosai-target-tc", "gdacs-rss-tc"} <= ids
    assert reg.archive_repo == reg.issue_repo == "abrycta/typhoon-replay-archive"
    for sid in ("era5-an-sfc", "era5-fc-gust", "era5-fc-precip-rate"):
        era5 = reg.source(sid)
        assert not era5["archived"]["enabled"]
        assert [lk["id"] for lk in archivekit.automatic_links(era5)] == ["ncar-aws", "ncar-osdf", "arco-gcs"]


def test_chains_as_designed() -> None:
    chain = {s["id"]: [lk["id"] for lk in archivekit.automatic_links(s)] for s in S.registry().sources}
    assert chain["ibtracs-wp"] == ["ncei-csv-wp", "ncei-csv-all-subset", "archive"]
    assert chain["geoboundaries-phl-adm3"] == ["geoboundaries-github", "geoboundaries-lfs-media", "archive"]
    assert chain["naturalearth-50m-coastline"] == ["github-raw", "jsdelivr", "archive"]
    assert chain["jtwc-rss"] == ["metoc"]  # live feeds: samples only, never an archive fallback
    assert chain["mlit-n03-jpn"] == ["mlit-ksj", "archive"]
    assert chain["hdx-cod-ab-phl-tabular"] == ["hdx", "archive"]


def test_local_raw_files_match_registry_pins() -> None:
    root = Path(__file__).resolve().parents[2]
    reg = S.registry()
    for sid in ("naturalearth-50m-coastline", "naturalearth-50m-countries", "ibtracs-wp"):
        src = reg.source(sid)
        p = root / src["local_path"]
        if not p.exists():
            pytest.skip(f"{p} not downloaded")
        v = archivekit.validate_file(p, src)
        assert v.rows and not v.drift, (sid, v)


def test_ibtracs_hook_rejects_bad_sids(tmp_path: Path) -> None:
    p = tmp_path / "x.csv"
    p.write_bytes(ibtracs_bytes(5, bad_sid=True))
    with pytest.raises(archivekit.SchemaError, match="SID"):
        S.check_ibtracs(p, {})
    p.write_bytes(ibtracs_bytes(5))
    assert S.check_ibtracs(p, {}) == []


@respx.mock
def test_ibtracs_wp_falls_back_to_all_subset_then_archive(small_registry: archivekit.Registry,
                                                         tmp_path: Path) -> None:
    good = ibtracs_bytes(300)
    respx.get(WP).mock(return_value=httpx.Response(200, content=b"<html>moved</html>",
                                                   headers={"Content-Type": "text/html"}))
    respx.get(ALL).mock(return_value=httpx.Response(200, content=good + ibtracs_bytes(5, basin="EP", day="200")
                                                    .split(b"\n", 2)[2]))
    p = S.fetch("ibtracs-wp", tmp_path / "wp.csv", registry=small_registry, reporter=False)
    assert (p.served_by, p.link_id, p.rows) == ("fallback", "ncei-csv-all-subset", 300)

    # both NCEI paths down -> the archive release serves, with the snapshot date in provenance
    respx.get(ALL).mock(return_value=httpx.Response(503))
    z = zstandard.ZstdCompressor().compress(good)
    import json

    man = json.dumps({"asset": "ibtracs.WP.list.v04r01.csv.zst", "raw_sha256": hashlib.sha256(good).hexdigest(),
                      "url_used": WP}).encode()
    sums = (f"{hashlib.sha256(z).hexdigest()}  ibtracs.WP.list.v04r01.csv.zst\n"
            f"{hashlib.sha256(man).hexdigest()}  manifest.json\n").encode()
    assets = []
    for i, (name, body) in enumerate([("ibtracs.WP.list.v04r01.csv.zst", z), ("manifest.json", man),
                                      ("SHA256SUMS", sums)]):
        respx.get(f"{API}/releases/assets/{i}").mock(return_value=httpx.Response(200, content=body))
        assets.append({"name": name, "url": f"{API}/releases/assets/{i}"})
    respx.get(f"{API}/releases").mock(return_value=httpx.Response(200, json=[
        {"tag_name": "ibtracs-wp-2026-10-18", "draft": False, "assets": assets}]))
    man_run = S.RunManifest()
    p = S.fetch("ibtracs-wp", tmp_path / "wp.csv", registry=small_registry, reporter=False, manifest=man_run)
    assert (p.served_by, p.snapshot_date) == ("archive", "2026-10-18")
    meta = S.data_version_metadata(man_run, "2026.10.21")
    assert meta["archive_used"] and meta["data_as_of"] == "2026-10-18"


def test_fetch_template_materialises_one_page(tmp_path: Path) -> None:
    """A templated update-input is fetched as a concrete file source: checks, atomic write, provenance."""
    url = "https://en.wikipedia.org/w/index.php?title=1999_Pacific_typhoon_season&action=raw"
    body = ("{{Infobox hurricane season}} The 1999 Pacific typhoon season ... " + "x" * 6000).encode()
    with respx.mock:
        respx.get(url).mock(return_value=httpx.Response(200, content=body))
        p = S.fetch_template("wikipedia-season-pages", tmp_path / "1999.wiki", reporter=False, year=1999)
    assert (p.source_id, p.link_id, p.url) == ("wikipedia-season-pages-1999", "enwiki-raw", url)
    assert (tmp_path / "1999.wiki").read_bytes() == body
    with respx.mock:
        respx.get(url).mock(return_value=httpx.Response(200, content=b"tiny"))
        with pytest.raises(archivekit.AllLinksFailed):
            S.fetch_template("wikipedia-season-pages", tmp_path / "1999.wiki", reporter=False, year=1999)
    assert (tmp_path / "1999.wiki").read_bytes() == body  # bad data never replaces good data


def test_remote_read_provenance_marks_fallback() -> None:
    r = S.RemoteRead("era5-an-sfc")
    r.ok("ncar-aws", "201311/u", 100)
    assert not r.fallback_used and r.provenance().served_by == "primary"
    r.failed("ncar-aws", "202608/u", "http-status", "404")
    r.ok("arco-gcs", "2026-08-01T00/u", 50)
    man = S.RunManifest()
    prov = r.record(man)
    assert prov.fallback_used and prov.served_by == "fallback" and prov.bytes == 150
    assert man.to_dict()["fallbacks_used"] == ["era5-an-sfc"]


def test_live_feed_row_change_limits():
    """JMA XML and GDACS TC feeds swing in size as storms start and end; widen the anomaly gate."""
    from archivekit.profile import Profile, Thresholds, compare

    reg = S.registry()
    for sid, limit in (("jma-xml-extra", 1.0), ("gdacs-rss-tc", 3.0)):
        t = Thresholds.from_source(reg.source(sid))
        assert t.max_row_change == limit
        assert not compare(Profile(rows=10), Profile(rows=int(10 * (1 + limit))), t)
        assert compare(Profile(rows=10), Profile(rows=int(10 * (1 + limit)) + 1), t)


def test_provenance_from_dict_ignores_unknown_keys() -> None:
    """A sidecar written by a newer kit (extra fields) must still load after a kit rollback."""
    d = {"source_id": "ibtracs-wp", "link_id": "primary", "served_by": "upstream", "url": "https://x/y.csv",
         "fetched_at": "2026-10-23T00:00:00Z", "sha256": "0" * 64, "bytes": 1, "rows": 1, "fallback_used": False,
         "a_field_from_kit_9": {"x": 1}}
    p = S.provenance_from_dict(d)
    assert p.source_id == "ibtracs-wp" and p.sha256 == "0" * 64
