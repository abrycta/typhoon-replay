"""R10: scheduled runs fail on a missing secret, keep themselves enabled, and report failures as an issue."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
GH = REPO / ".github"


def _gate(event: str, token: str, tmp_path: Path) -> tuple[int, str, str]:
    action = yaml.safe_load((GH / "actions/setup-pipeline/action.yml").read_text())
    script = next(s for s in action["runs"]["steps"] if s.get("id") == "gate")["run"]
    out = tmp_path / "out"
    out.write_text("")
    env = {"PATH": os.environ["PATH"], "T": token, "H": "", "NEED_HF": "true", "EVENT": event,
           "GITHUB_OUTPUT": str(out)}
    r = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, check=False)
    return r.returncode, r.stdout, out.read_text()


def test_secret_gate_fails_scheduled_runs_but_skips_pull_requests(tmp_path: Path) -> None:
    code, stdout, _ = _gate("schedule", "", tmp_path)
    assert code == 1 and "::error" in stdout and "ARCHIVE_READ_TOKEN and HF_TOKEN" in stdout
    assert _gate("workflow_dispatch", "t", tmp_path)[0] == 1          # HF_TOKEN alone missing
    code, _, out = _gate("pull_request", "", tmp_path)
    assert code == 0 and "ok=false" in out


def test_keepalive_reenables_a_disabled_workflow(tmp_path: Path) -> None:
    log = tmp_path / "calls"
    fake = tmp_path / "gh"
    fake.write_text('#!/usr/bin/env bash\necho "$*" >> "$LOG"\n'
                    'case "$*" in *--jq*) case "$*" in *live.yml*) echo disabled_inactivity ;; *) echo active ;; esac ;; esac\n')
    fake.chmod(0o755)
    env = {"PATH": f"{tmp_path}:{os.environ['PATH']}", "LOG": str(log), "GITHUB_REPOSITORY": "o/r"}
    r = subprocess.run([str(GH / "scripts/keepalive.sh")], env=env, capture_output=True, text=True, check=False)
    assert r.returncode == 0
    assert "live.yml was disabled_inactivity; re-enabling it" in r.stdout
    enabled = [ln for ln in log.read_text().splitlines() if ln.startswith("api -X PUT")]
    assert {ln.split("/")[-2] for ln in enabled} == {"refresh.yml", "live-check.yml", "live.yml", "budget.yml"}


def test_refresh_reports_failures_as_an_issue_and_runs_the_keepalive() -> None:
    wf = yaml.safe_load((GH / "workflows/refresh.yml").read_text())
    steps = wf["jobs"]["refresh"]["steps"]
    assert wf["jobs"]["refresh"]["permissions"]["issues"] == "write"
    assert any(s.get("if") == "failure()" and "gh issue create" in s["run"] for s in steps)
    assert any(s.get("if") == "success()" and "gh issue close" in s["run"] for s in steps)
    assert wf["jobs"]["keepalive"]["permissions"] == {"actions": "write"}
