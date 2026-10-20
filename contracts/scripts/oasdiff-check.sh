#!/usr/bin/env bash
# Breaking-change gate: bundle the contract at BASE_REF and compare it with the working tree's dist/openapi.json.
#   contracts/scripts/oasdiff-check.sh [BASE_REF]      (default: origin/main)
# Fails on ERR-level breaking changes unless info.version's major was bumped (a new /v2 is then expected).
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
  echo "Major version bumped ($base_major -> $head_major): breaking changes allowed; they must ship under /v$head_major."
  oasdiff breaking base.json head.json || true
  exit 0
fi
oasdiff breaking base.json head.json --fail-on ERR
echo "No breaking changes vs $BASE_REF."
