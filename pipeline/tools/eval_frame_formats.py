"""Compare frame encodings on real storms: bytes per storm-hour and fidelity of the decoded fields.

Usage (from pipeline/, after `python -m typhoon frames ...`):
    uv run python tools/eval_frame_formats.py 2013306N07162 2021346N05145 ... [--stills 2013306N07162]

Formats (all on the same uint8 codes as frames.tyf):
  tyf            raw .tyf (5 vars, hourly)                     tyf.gz   gzip -9 of it
  webp-ll        lossless WebP sheet per variable, hourly
  webp-q<Q>      lossy WebP (quality Q) for wind/gust/mslp/tp, wdir lossless, hourly
  webp-q<Q>-3h   the same, every 3rd hour (the app blends between frames)
  exact-3h-half  lossless WebP, every 3rd hour, every other cell (0.5 deg): exact numbers for readouts

Fidelity, against the hourly lossless codes, in physical units and as PSNR / SSIM on the codes:
  codec error    lossy frame vs the same hour's exact frame
  3h blend       linear blend of the two neighbouring 3-hourly frames, on the global 0.25 deg grid (as the
                 app's shader does), vs the true hourly frame in between (includes the codec error)
Writes data/eval/frame-formats.json and side-by-side stills data/eval/<sid>-*.png.
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from typhoon.config import DATA
from typhoon.frames import (
    ENC,
    OUT,
    TILE_STRIDE,
    dequantise,
    encode_webp,
    parse_tyf,
    uv_codes,
)
from typhoon.frames import sheet as padded_sheet

QUALITIES = (50, 70, 80, 90)
LOSSY_VARS = ("wind", "gust", "mslp", "tp")


def sheet(q: np.ndarray) -> tuple[np.ndarray, int]:
    t, h, w = q.shape
    cols = int(np.ceil(np.sqrt(t)))
    rows = int(np.ceil(t / cols))
    s = np.zeros((rows * h, cols * w), np.uint8)
    for i in range(t):
        r, c = divmod(i, cols)
        s[r * h:(r + 1) * h, c * w:(c + 1) * w] = q[i]
    return s, cols


def unsheet(s: np.ndarray, t: int, h: int, w: int, cols: int) -> np.ndarray:
    out = np.empty((t, h, w), np.uint8)
    for i in range(t):
        r, c = divmod(i, cols)
        out[i] = s[r * h:(r + 1) * h, c * w:(c + 1) * w]
    return out


def webp(q: np.ndarray, quality: int | None) -> tuple[int, np.ndarray]:
    s, cols = sheet(q)
    buf = io.BytesIO()
    if quality is None:
        Image.fromarray(s, "L").save(buf, format="WEBP", lossless=True, quality=100, method=4, exact=True)
    else:
        Image.fromarray(s, "L").save(buf, format="WEBP", quality=quality, method=6)
    back = np.asarray(Image.open(io.BytesIO(buf.getvalue())).convert("L"))
    return len(buf.getvalue()), unsheet(back, *q.shape, cols)


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    m = float(np.mean((a.astype(float) - b.astype(float)) ** 2))
    return 99.0 if m == 0 else round(10 * np.log10(255**2 / m), 2)


def ssim(a: np.ndarray, b: np.ndarray, k: int = 7) -> float:
    """Mean SSIM over frames (box window k x k), on uint8 codes."""
    def box(x: np.ndarray) -> np.ndarray:
        c = np.cumsum(np.cumsum(np.pad(x, ((0, 0), (1, 0), (1, 0))), 1), 2)
        return (c[:, k:, k:] - c[:, :-k, k:] - c[:, k:, :-k] + c[:, :-k, :-k]) / (k * k)
    a, b = a.astype(float), b.astype(float)
    mu_a, mu_b = box(a), box(b)
    va, vb, cov = box(a * a) - mu_a**2, box(b * b) - mu_b**2, box(a * b) - mu_a * mu_b
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    s = ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / ((mu_a**2 + mu_b**2 + c1) * (va + vb + c2))
    return round(float(s.mean()), 4)


def blend_3h(q3: np.ndarray, rows3: np.ndarray, cols3: np.ndarray, t: int, rows: np.ndarray, cols: np.ndarray,
             nodata: int = 255) -> np.ndarray:
    """Frame at hour t from the 3-hourly frames around it, blended on the global grid like the shader."""
    a, f = divmod(t, 3)
    b = min(a + 1, len(q3) - 1)
    w = f / 3.0
    out = np.empty((len(rows), len(cols)), float)

    def sample(k: int) -> np.ndarray:
        ri = rows[:, None] - rows3[k]
        ci = (cols[None, :] - cols3[k]) % 1440
        ok = (ri >= 0) & (ri < q3.shape[1]) & (ci < q3.shape[2])
        v = np.full(ok.shape, np.nan)
        v[ok] = q3[k][np.clip(ri, 0, q3.shape[1] - 1), np.clip(ci, 0, q3.shape[2] - 1)][ok]
        return v
    va, vb = sample(a), sample(b)
    out = np.where(np.isnan(va), vb, np.where(np.isnan(vb), va, va * (1 - w) + vb * w))
    return np.nan_to_num(out, nan=nodata)


def tyf_path(sid: str) -> Path:
    meta = json.loads((OUT / sid / "frames.json").read_text())
    return OUT / sid / (meta["files"]["tyf"]["file"] if "files" in meta else "frames.tyf")


def evaluate(sid: str) -> dict:
    blob = tyf_path(sid).read_bytes()
    h, q = parse_tyf(blob)
    T = h["frames"]
    rows0 = np.round((90 - np.array(h["nw_lat"])) / 0.25).astype(int)
    cols0 = np.round((np.array(h["nw_lon"]) % 360) / 0.25).astype(int) % 1440
    names = [v["name"] for v in h["vars"]]
    res: dict = {"sid": sid, "hours": T, "bytesPerHour": {}, "fidelity": {}}
    res["bytesPerHour"]["tyf"] = round(len(blob) / T)
    res["bytesPerHour"]["tyf.gz"] = round(len(gzip.compress(blob, 9)) / T)
    ll = {n: webp(q[:, i], None) for i, n in enumerate(names)}
    res["bytesPerHour"]["webp-ll"] = round(sum(s for s, _ in ll.values()) / T)
    idx3 = np.arange(0, T, 3)
    ll3 = {n: webp(q[idx3, i], None) for i, n in enumerate(names)}
    res["bytesPerHour"]["webp-ll-3h"] = round(sum(s for s, _ in ll3.values()) / T)
    half = q[idx3][:, :, ::2, ::2]
    res["bytesPerHour"]["exact-3h-half"] = round(sum(webp(half[:, i], None)[0] for i in range(len(names))) / T)
    for Q in QUALITIES:
        for step, idx in (("", np.arange(T)), ("-3h", idx3)):
            size = 0
            dec = {}
            for i, n in enumerate(names):
                if n in LOSSY_VARS:
                    s, back = webp(q[idx, i], Q)
                else:
                    s, back = webp(q[idx, i], None)
                size += s
                dec[n] = back
            key = f"webp-q{Q}{step}"
            res["bytesPerHour"][key] = round(size / T)
            fid = {}
            for vi, n in enumerate(names):
                if n not in LOSSY_VARS:
                    continue
                e = ENC[[x.name for x in ENC].index(n)]
                if step == "":
                    truth, got = q[:, vi], dec[n]
                else:   # blend the decoded 3-hourly frames to every hour in between
                    truth = q[:, vi]
                    got = np.stack([blend_3h(dec[n], rows0[idx3], cols0[idx3], t,
                                             np.arange(rows0[t], rows0[t] + h["ny"]),
                                             np.arange(cols0[t], cols0[t] + h["nx"]) % 1440) for t in range(T)])
                    got = np.clip(np.round(got), 0, 255).astype(np.uint8)
                diff = dequantise(got, e) - dequantise(truth, e)
                ok = np.isfinite(diff)
                fid[n] = {"psnr": psnr(truth, got), "ssim": ssim(truth, got),
                          "rmse": round(float(np.sqrt(np.mean(diff[ok] ** 2))), 3),
                          "p99AbsErr": round(float(np.percentile(np.abs(diff[ok]), 99)), 3), "units": e.units}
            res["fidelity"][key] = fid
    # the published layout: six lossy fields (u/v instead of the wrapping wdir) on a 96 px stride
    e = {x.name: x for x in ENC}
    wind, wdir = dequantise(q[:, names.index("wind")], e["wind"]), dequantise(q[:, names.index("wdir")], e["wdir"])
    uv = uv_codes(wind, wdir)
    for Q in QUALITIES:
        size = 0
        for n in ("wind", "gust", "mslp", "tp"):
            size += len(encode_webp(padded_sheet(q[:, names.index(n)], TILE_STRIDE)[0], Q))
        for n in ("u", "v"):
            size += len(encode_webp(padded_sheet(uv[n], TILE_STRIDE)[0], Q))
        res["bytesPerHour"][f"published-fields-q{Q}"] = round(size / T)
    return res


def colourise(codes: np.ndarray, vmax: float = 254) -> Image.Image:
    v = np.clip(codes.astype(float) / vmax, 0, 1)
    rgb = np.stack([np.clip(1.5 * v, 0, 1), np.clip(1.5 * v - 0.5, 0, 1), np.clip(0.6 - v, 0, 1) + 0.15 * v], -1)
    rgb[codes == 255] = 0.2
    return Image.fromarray((rgb * 255).astype(np.uint8)).resize((324, 324), Image.NEAREST)


def stills(sid: str, outdir: Path) -> list[str]:
    h, q = parse_tyf(tyf_path(sid).read_bytes())
    T = h["frames"]
    wi = [v["name"] for v in h["vars"]].index("wind")
    rows0 = np.round((90 - np.array(h["nw_lat"])) / 0.25).astype(int)
    cols0 = np.round((np.array(h["nw_lon"]) % 360) / 0.25).astype(int) % 1440
    t = int(np.argmax(q[:, wi].max(axis=(1, 2))))
    t = t - t % 3 + 1   # an hour between two 3-hourly frames
    idx3 = np.arange(0, T, 3)
    panels = [("hourly lossless (exact)", q[t, wi])]
    for Q in (50, 80):
        _, back = webp(q[:, wi], Q)
        panels.append((f"hourly lossy q{Q}", back[t]))
        _, back3 = webp(q[idx3, wi], Q)
        bl = blend_3h(back3, rows0[idx3], cols0[idx3], t, np.arange(rows0[t], rows0[t] + h["ny"]),
                      np.arange(cols0[t], cols0[t] + h["nx"]) % 1440)
        panels.append((f"3-hourly lossy q{Q}, blended", np.clip(np.round(bl), 0, 255).astype(np.uint8)))
    im = Image.new("RGB", (334 * len(panels), 350), (20, 20, 20))
    d = ImageDraw.Draw(im)
    for k, (title, codes) in enumerate(panels):
        im.paste(colourise(codes, float(panels[0][1].max())), (334 * k + 5, 22))
        d.text((334 * k + 8, 4), title, fill=(230, 230, 230))
    d.text((8, 350 - 14), f"{sid} 10 m wind, hour {t} ({h['time'][t]}); colour scaled to the exact frame's maximum",
           fill=(170, 170, 170))
    p = outdir / f"{sid}-wind-formats.png"
    im.save(p)
    return [str(p)]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("sids", nargs="+")
    ap.add_argument("--stills", nargs="*", default=[])
    a = ap.parse_args()
    outdir = DATA / "eval"
    outdir.mkdir(parents=True, exist_ok=True)
    results = [evaluate(s) for s in a.sids]
    hours = sum(r["hours"] for r in results)
    keys = results[0]["bytesPerHour"].keys()
    summary = {k: round(sum(r["bytesPerHour"][k] * r["hours"] for r in results) / hours) for k in keys}
    files = [f for s in a.stills for f in stills(s, outdir)]
    report = {"storms": a.sids, "stormHours": hours, "meanBytesPerStormHour": summary, "perStorm": results,
              "stills": files}
    (outdir / "frame-formats.json").write_text(json.dumps(report, indent=1))
    print(json.dumps({"meanBytesPerStormHour": summary, "fidelity_haiyan_like": results[0]["fidelity"],
                      "stills": files}, indent=1))


if __name__ == "__main__":
    main()
