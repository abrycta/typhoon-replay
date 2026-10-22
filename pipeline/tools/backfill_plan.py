"""backfill.yml helper: job outputs and the summary line for a batch plan (run from pipeline/ with uv).

    PYTHONPATH=. uv run python tools/backfill_plan.py PLAN_JSON GITHUB_OUTPUT GITHUB_STEP_SUMMARY

Writes canary=[...] (keys c0, c1, ... from `typhoon plan --canary`), batches=[...] (the full run), and
canary_timeout / batch_timeout in minutes, sized from the largest batch: ~0.6 s per storm-hour (measured),
x1.75, plus 20 min for setup and upload, capped at 345 (GitHub's job limit is 6 h).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from typhoon import catalog

plan_path, out_path, summary_path = sys.argv[1:4]
plan = {k: v for k, v in json.loads(Path(plan_path).read_text()).items() if v}
hours: dict[str, int] = {}
if plan:
    st = catalog.load("storms")
    hours = {str(s): int(h) for s, h in zip(st.sid, st.hours, strict=True)}


def load(key: str) -> int:
    return sum(hours.get(s, 0) for s in plan[key])


def timeout(keys: list[str]) -> int:
    most = max((load(k) for k in keys), default=0)
    return min(345, round(most * 0.6 * 1.75 / 60) + 20)


canary = sorted(k for k in plan if k.startswith("c"))
full = sorted((k for k in plan if not k.startswith("c")), key=int)
with open(out_path, "a") as f:
    f.write(f"canary={json.dumps(canary)}\nbatches={json.dumps(full)}\n")
    f.write(f"canary_timeout={timeout(canary)}\nbatch_timeout={timeout(full)}\n")
total = sum(load(k) for k in plan) or 1
c_hours = sum(load(k) for k in canary)
with open(summary_path, "a") as f:
    f.write(f"Plan: canary {sum(len(plan[k]) for k in canary)} storms ({100 * c_hours / total:.1f} % of storm-hours) "
            f"in {len(canary)} batches, timeout {timeout(canary)} min; then "
            f"{sum(len(plan[k]) for k in full)} storms in {len(full)} batches, timeout {timeout(full)} min.\n")
print(f"canary={canary} batches={full} canary_timeout={timeout(canary)} batch_timeout={timeout(full)}")
