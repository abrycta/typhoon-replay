#!/usr/bin/env bash
# Switch the pipeline from the local path dependency on ../../data-archive-kit to a tagged release
# of the private kit. Run after the tag exists:  pipeline/tools/use-archivekit-tag.sh [v1.0.0]
# Needs git access to the private repo: locally `gh auth setup-git`; in CI the ARCHIVE_READ_TOKEN
# insteadOf rewrite shown in docs/architecture/DATA-RESILIENCE.md.
set -euo pipefail
TAG="${1:-v1.0.0}"
cd "$(dirname "$0")/.."
uv remove archivekit
uv add "archivekit @ git+https://github.com/abrycta/data-archive-kit@${TAG}"
# drop the TODO comment that pointed at this switch
python3 - <<'PY'
from pathlib import Path
p = Path("pyproject.toml")
lines = [l for l in p.read_text().splitlines(keepends=True)
         if not l.startswith(("# TODO: switch to the tagged release", "#   archivekit = { git ="))]
p.write_text("".join(lines))
PY
uv lock --check
uv run pytest -q tests/test_sources.py
grep -A3 '^\[tool.uv.sources\]' pyproject.toml
