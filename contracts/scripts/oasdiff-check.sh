#!/usr/bin/env bash
# Breaking-change gate: bundle the contract at BASE_REF and compare it with the working tree's dist/openapi.json.
#   contracts/scripts/oasdiff-check.sh [BASE_REF]      (default: origin/main)
# Fails on ERR-level breaking changes unless they are marked intended (CONTRACT-GUIDE §2): info.version's major was
# bumped AND CHANGELOG.md has a "## <major>.0.0" entry explaining them. The breaking changes are then printed for the
# record and saved to dist/breaking.txt. Whether the major also needs a new /vN URL prefix is a review question (§2):
# removing operations keeps the prefix; changing an operation that stays needs /vN.
# Uses the oasdiff binary if installed, else the tufin/oasdiff Docker image. Writes dist/changelog.md for CONTRACT CHANGELOG notes.
set -euo pipefail

BASE_REF="${1:-origin/main}"
OASDIFF_IMAGE="tufin/oasdiff:v1.34.0"
here="$(cd "$(dirname "$0")/.." && pwd)"     # contracts/
repo="$(git -C "$here" rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'git -C "$repo" worktree remove --force "$work/base" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

[ -f "$here/dist/openapi.json" ] || { echo "dist/openapi.json missing: run 'just bundle' first" >&2; exit 2; }

if ! git -C "$repo" cat-file -e "$BASE_REF:contracts/openapi/openapi.yaml" 2>/dev/null; then
  echo "No contract at $BASE_REF yet: nothing to compare (first version)."
  exit 0
fi

git -C "$repo" worktree add --detach "$work/base" "$BASE_REF" >/dev/null
( cd "$work/base/contracts" && { [ -e node_modules ] || ln -s "$here/node_modules" node_modules; } && node scripts/bundle.mjs >/dev/null 2>&1 )
cp "$work/base/contracts/dist/openapi.json" "$work/base.json"
cp "$here/dist/openapi.json" "$work/head.json"

oasdiff() {
  if type -P oasdiff >/dev/null 2>&1; then
    (cd "$work" && command oasdiff "$@")
  else
    docker run --rm -v "$work:/specs:ro" -w /specs "$OASDIFF_IMAGE" "$@"
  fi
}

major() { node -e 'console.log(require(process.argv[1]).info.version.split(".")[0])' "$1"; }
base_major="$(major "$work/base.json")"
head_major="$(major "$work/head.json")"

oasdiff changelog base.json head.json --format markdown > "$here/dist/changelog.md" || true
echo "Changelog vs $BASE_REF: contracts/dist/changelog.md"

if [ "$head_major" != "$base_major" ]; then
  head_version="$(node -e 'console.log(require(process.argv[1]).info.version)' "$work/head.json")"
  if ! grep -Eq "^## ${head_version//./\\.}( |$)" "$here/CHANGELOG.md"; then
    echo "Major version bumped ($base_major -> $head_major) but CHANGELOG.md has no '## $head_version' entry: document the breaking changes there." >&2
    exit 1
  fi
  echo "Major version bumped ($base_major -> $head_major) and documented in CHANGELOG.md: breaking changes are intended."
  oasdiff breaking base.json head.json | tee "$here/dist/breaking.txt" || true
  exit 0
fi
oasdiff breaking base.json head.json --fail-on ERR
echo "No breaking changes vs $BASE_REF."
