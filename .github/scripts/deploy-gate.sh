#!/usr/bin/env bash
# deploy-gate.sh: which commit should production deploy now? ("Merged means deployed")
#
#   .github/scripts/deploy-gate.sh <ci-workflow-file> [<ci-job-name>]
#
# The answer is always the NEWEST main commit the deploy covers (paths= in .github/deploy-target), never the
# commit that happened to trigger this run, so any run that gets through deploys everything merged so far and
# a later green run catches up anything skipped. That commit's CI (the workflow's push run, or only its
# <ci-job-name> job when the deploy is a later job of the same workflow) decides:
#   success            -> deploy=true, sha=<commit>, run_id=<its CI run>  (GITHUB_OUTPUT)
#   queued / running   -> deploy=false: that run's own success deploys it (CI on main is never cancelled)
#   anything else      -> exit 1: main's newest commit is red, so production stays behind; fix main
# Same file in every deployed repo; canonical copy in the workspace tools/lib/deploy-gate.sh.
set -euo pipefail
ci="$1" job="${2:-}"
repo="$GITHUB_REPOSITORY"
conf="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.github/deploy-target"
paths="*"
[ -f "$conf" ] && paths="$(sed -n 's/^paths=//p' "$conf" | head -1)"
out="${GITHUB_OUTPUT:-/dev/stdout}" summary="${GITHUB_STEP_SUMMARY:-/dev/stderr}"

if [ "${paths:-*}" = "*" ]; then
  sha="$(gh api "repos/$repo/commits/main" --jq .sha)"
else
  # Newest commit on main touching any covered path.
  sha="$(for p in $paths; do
      gh api "repos/$repo/commits?sha=main&path=$p&per_page=1" --jq '.[] | "\(.commit.committer.date) \(.sha)"'
    done | sort | tail -1 | cut -d' ' -f2)"
fi
[ -n "$sha" ] || { echo "::error::could not find the newest main commit"; exit 1; }

# The filtered listing (?head_sha=) can leave out runs that are still in progress, which includes the run this
# deploy job belongs to, so the gate would report "not started" and skip its own commit. Look in the newest
# unfiltered runs first; the filtered query only finds older commits that have dropped out of that page.
# shellcheck disable=SC2016 # $sha is a jq variable
pick='[.workflow_runs[] | select(.head_sha == $sha and .head_branch == "main" and .event == "push")]
  | sort_by(.created_at) | last // empty | "\(.id) \(.status) \(.conclusion)"'
run="$(gh api "repos/$repo/actions/workflows/$ci/runs?per_page=100" | jq -r --arg sha "$sha" "$pick")"
[ -n "$run" ] || run="$(gh api "repos/$repo/actions/workflows/$ci/runs?head_sha=$sha&event=push&per_page=20" \
  | jq -r --arg sha "$sha" "$pick")"
read -r run_id status conclusion <<<"${run:-- none none}"
if [ -n "$job" ] && [ "$run_id" != "-" ]; then
  read -r status conclusion <<<"$(gh api "repos/$repo/actions/runs/$run_id/jobs" \
    --jq "[.jobs[] | select(.name == \"$job\")] | last // {status: \"queued\", conclusion: null} | \"\(.status) \(.conclusion)\"")"
fi

short="${sha:0:7}"
if [ "$status" = completed ] && [ "$conclusion" = success ]; then
  { echo "deploy=true"; echo "sha=$sha"; echo "run_id=$run_id"; } >> "$out"
  echo "Deploying main's newest covered commit \`$short\` (CI run $run_id passed)." >> "$summary"
elif [ "$run_id" = "-" ] || [ "$status" != completed ]; then
  echo "deploy=false" >> "$out"
  echo "::notice title=Not deploying yet::CI for main's newest commit $short is ${status/none/not started}; its own success deploys it."
  echo "Not deploying: CI for main's newest commit \`$short\` is still ${status/none/not started}; that run deploys it." >> "$summary"
else
  echo "deploy=false" >> "$out"
  echo "::error title=Main is red::CI for main's newest commit $short concluded '$conclusion' (run $run_id); production stays at its last green deploy. Fix main."
  exit 1
fi
