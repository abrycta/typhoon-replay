#!/usr/bin/env bash
# live-check.sh: is the live site at the newest main commit its deploy covers? ("Merged means deployed")
#
#   live-check.sh [--redeploy] [owner/repo]
#
# Every gated deploy writes <url>/deploy.json ({"sha": ...}). The repo's .github/deploy-target says where:
#   url=https://lights.krtmtthw.dev
#   workflow=web.yml                      (the workflow that deploys main; dispatched by --redeploy)
#   paths=web/ crates/ Cargo.lock ...     (what the deploy covers; * = everything)
# The target file is read from this checkout when run inside a repo without an argument, else through the API.
#
# Prints one line:  CURRENT | PENDING | STALE  repo · live <sha> · main <sha> · detail
# PENDING: newer commits the deploy covers exist, the oldest under GRACE_MIN (default 30) minutes old, so its
# CI and deploy may still be running. STALE: older than that, or no deploy.json: exit 1, and with --redeploy
# the deploy workflow is dispatched on main (it deploys the newest commit whose CI is green).
# Also prints INFO lines for cancelled or skipped runs of the deploy workflow on main since its last success.
#
# Canonical copy: the workspace tools/lib/live-check.sh (tools/ci-red.sh runs it); each deployed repo carries
# the same file as .github/scripts/live-check.sh for its hourly live-check workflow. Keep them identical.
set -uo pipefail
redeploy=0
[ "${1:-}" = "--redeploy" ] && { redeploy=1; shift; }
repo="${1:-${GITHUB_REPOSITORY:-}}"
grace="${GRACE_MIN:-30}"
here="$(cd "$(dirname "$0")" && pwd)"

conf=""
local_conf="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null)/.github/deploy-target"
if [ -z "${1:-}" ] && [ -f "$local_conf" ]; then
  conf="$(cat "$local_conf")"
  [ -n "$repo" ] || repo="$(git -C "$here" remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')"
else
  conf="$(gh api "repos/$repo/contents/.github/deploy-target" --jq .content 2>/dev/null | base64 -d 2>/dev/null)"
fi
[ -n "$repo" ] || { echo "ERROR     usage: live-check.sh [--redeploy] owner/repo"; exit 2; }
[ -n "$conf" ] || { echo "ERROR     $repo · no .github/deploy-target"; exit 2; }
get() { sed -n "s/^$1=//p" <<<"$conf" | head -1; }
url="$(get url)" wf="$(get workflow)" paths="$(get paths)"
name="${repo#*/}"

head="$(gh api "repos/$repo/commits/main" --jq .sha 2>/dev/null)"
[ -n "$head" ] || { echo "ERROR     $name · could not read main"; exit 2; }
live="$(curl -fsS --max-time 20 "$url/deploy.json?t=$(date +%s)" 2>/dev/null | jq -r '.sha // empty' 2>/dev/null)"

state=CURRENT detail="" oldest=""
if [ -z "$live" ]; then
  state=STALE detail="no $url/deploy.json"
elif [ "$live" != "$head" ]; then
  since="$(gh api "repos/$repo/commits/$live" --jq .commit.committer.date 2>/dev/null)"
  if [ -z "$since" ]; then
    state=STALE detail="live commit $live is not in the repo"
  else
    # The oldest commit after the live one that touches what the deploy covers.
    oldest="$(for p in ${paths:-*}; do
        q="repos/$repo/commits?sha=main&since=$since&per_page=100"
        [ "$p" = "*" ] || q="$q&path=$p"
        gh api "$q" --jq ".[] | select(.sha != \"$live\") | .commit.committer.date" 2>/dev/null
      done | sort | head -1)"
    if [ -n "$oldest" ]; then
      age=$(( ( $(date -u +%s) - $(date -u -d "$oldest" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$oldest" +%s) ) / 60 ))
      if [ "$age" -lt "$grace" ]; then state=PENDING detail="undeployed changes since ${age} min (deploy may still be running)"
      else state=STALE detail="undeployed changes since ${age} min"; fi
    else
      detail="newer main commits don't touch what the deploy covers"
    fi
  fi
fi
[ "$state" = CURRENT ] && [ -z "$detail" ] && detail="deployed"
printf '%-9s %s · live %s · main %s · %s · %s\n' "$state" "$name" "${live:0:7}" "${head:0:7}" "$detail" "$url"

# Cancelled or skipped deploy runs on main since the last successful one (information; staleness is the check).
if [ -n "$wf" ]; then
  gh run list -R "$repo" -w "$wf" -b main -L 30 --json conclusion,createdAt,url 2>/dev/null | jq -r --arg n "$name" '
    (map(.conclusion) | index("success")) as $i
    | (if $i == null then . else .[:$i] end)[]
    | select(.conclusion == "cancelled" or .conclusion == "skipped")
    | "INFO      \($n) · deploy run \(.conclusion) \(.createdAt | sub(":[0-9]{2}Z$"; "Z") | sub("T"; " ")) · \(.url)"'
fi

if [ "$state" = STALE ]; then
  if [ "$redeploy" = 1 ] && [ -n "$wf" ]; then
    gh workflow run "$wf" -R "$repo" --ref main && echo "          dispatched $wf on main to deploy the newest green commit"
  fi
  exit 1
fi
exit 0
