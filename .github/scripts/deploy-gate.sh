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
#   this very run      -> deploy=true: with <ci-job-name>, the deploy job needs that job, so it passed here;
#                         from a workflow_run event, the triggering CI run is that commit's and it passed
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

short="${sha:0:7}"
# This run IS that commit's CI: the deploy job `needs` <ci-job-name>, so the job already passed here. Decide
# without the API, which can still report this run's finished job as queued for a few seconds; asking it made
# the gate skip its own commit ("its own success deploys it") and nothing ever deployed that commit.
if [ -n "$job" ] && [ "$sha" = "${GITHUB_SHA:-}" ] && [ -n "${GITHUB_RUN_ID:-}" ] \
  && [ "${GITHUB_REF:-}" = refs/heads/main ]; then
  { echo "deploy=true"; echo "sha=$sha"; echo "run_id=$GITHUB_RUN_ID"; } >> "$out"
  echo "Deploying main's newest covered commit \`$short\` (this run's \`$job\` passed)." >> "$summary"
  exit 0
fi

# A deploy workflow triggered by that commit's CI finishing (workflow_run): the event says it passed, so trust it
# rather than the API, which can lag behind the run that just finished.
if [ "${GITHUB_EVENT_NAME:-}" = workflow_run ] && [ -f "${GITHUB_EVENT_PATH:-}" ]; then
  read -r ev_sha ev_id ev_conclusion ev_event ev_branch ev_path <<<"$(jq -r '.workflow_run
    | "\(.head_sha) \(.id) \(.conclusion) \(.event) \(.head_branch) \(.path)"' "$GITHUB_EVENT_PATH")"
  if [ "$ev_sha" = "$sha" ] && [ "$ev_conclusion" = success ] && [ "$ev_event" = push ] \
    && [ "$ev_branch" = main ] && [ "${ev_path%%@*}" = ".github/workflows/$ci" ]; then
    { echo "deploy=true"; echo "sha=$sha"; echo "run_id=$ev_id"; } >> "$out"
    echo "Deploying main's newest covered commit \`$short\` (the CI run that triggered this deploy, $ev_id, passed)." >> "$summary"
    exit 0
  fi
fi

# The filtered listing (?head_sha=) can leave out runs that are still in progress, which includes the run this
# deploy job belongs to, so the gate would report "not started" and skip its own commit. Look in the newest
# unfiltered runs first; for older commits fall back to the repo-wide ?head_sha= listing (the per-workflow
# filtered endpoint has also returned 0 for runs that existed), keeping only this workflow's runs.
# shellcheck disable=SC2016 # $sha is a jq variable
pick='[.workflow_runs[] | select(.head_sha == $sha and .head_branch == "main" and .event == "push")]
  | sort_by(.created_at) | last // empty | "\(.id) \(.status) \(.conclusion)"'
run="$(gh api "repos/$repo/actions/workflows/$ci/runs?per_page=100" | jq -r --arg sha "$sha" "$pick")"
[ -n "$run" ] || run="$(gh api "repos/$repo/actions/runs?head_sha=$sha&event=push&per_page=100" \
  | jq -r --arg sha "$sha" --arg wf ".github/workflows/$ci" '.workflow_runs |= map(select(.path == $wf))' \
  | jq -r --arg sha "$sha" "$pick")"
read -r run_id status conclusion <<<"${run:-- none none}"
if [ -n "$job" ] && [ "$run_id" != "-" ]; then
  read -r status conclusion <<<"$(gh api "repos/$repo/actions/runs/$run_id/jobs" \
    --jq "[.jobs[] | select(.name == \"$job\")] | last // {status: \"queued\", conclusion: null} | \"\(.status) \(.conclusion)\"")"
fi

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
