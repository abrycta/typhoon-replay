"""Join the PAGASA local-name seed (pipeline/crosswalk/pagasa_names_seed.csv) to IBTrACS SIDs.

Match on normalised international name + season (international names are reused, e.g. HAIYAN
2001/2007/2013, MEGI 2010/2022, so the season is required). Validates each match by (a) the storm
entering the PAGASA Area of Responsibility and (b) the JTWC number agreeing with USA_ATCF_ID.

Usage: uv run python -m typhoon.crosswalk
Writes pipeline/crosswalk/pagasa_names_sid.csv (small, versioned) and prints a status summary.
"""
from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
CW = ROOT / "pipeline/crosswalk"


def norm(s) -> str:
    return re.sub(r"[^A-Z]", "", str(s).upper()) if isinstance(s, str) else ""


def main():
    seed = pd.read_csv(CW / "pagasa_names_seed.csv", dtype=str)
    seed["season"] = seed["season"].astype(int)
    st = pd.read_parquet(ROOT / "data/processed/ibtracs/storms.parquet")
    # Recent seasons are PROVISIONAL / US-PROVISIONAL until best-track finalisation; spurs excluded.
    st = st[~st.track_type.str.contains("spur")].copy()
    st["key"] = st["name"].map(norm)
    out = []
    for r in seed.itertuples():
        k = norm(r.intl_name)
        cand = st[(st.key == k) & (st.season == r.season)] if k else st.iloc[0:0]
        status, sid = "no_intl_name" if not k else "not_found", None
        if len(cand) == 1:
            c = cand.iloc[0]
            sid = c.sid
            ok_par = bool(c.entered_par)
            jt = str(r.jtwc_id or "").upper().rstrip("W") if isinstance(r.jtwc_id, str) else ""
            atcf = c.usa_atcf_id or ""
            ok_jtwc = (not jt) or (atcf[2:4] == jt.zfill(2))
            status = "matched" if ok_par and ok_jtwc else ("matched_jtwc_mismatch" if ok_par else "matched_not_in_par")
        elif len(cand) > 1:
            status = "ambiguous"
        out.append({"pagasa_name": r.pagasa_name, "intl_name": r.intl_name, "season": r.season,
                    "sid": sid, "status": status,
                    "usa_atcf_id": None if sid is None else cand.iloc[0].usa_atcf_id,
                    "landfall_ph_ibtracs": None if sid is None else bool(cand.iloc[0].landfall_ph),
                    "source_url": r.source_url})
    df = pd.DataFrame(out)
    df.to_csv(CW / "pagasa_names_sid.csv", index=False)
    print(df.status.value_counts().to_string())
    print(df[df.status != "matched"].to_string())


if __name__ == "__main__":
    main()
