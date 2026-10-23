#!/usr/bin/env bash
# Keep every scheduled workflow of this repo enabled. GitHub disables cron workflows after 60 days
# without repository activity; re-enabling resets that clock, and it also brings back a workflow that was
# already disabled. Never fails the calling job: a problem is a ::warning (needs `actions: write`).
set -uo pipefail
for wf in refresh.yml live-check.yml live.yml budget.yml; do
  state=$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/$wf" --jq .state 2>/dev/null) || {
    echo "::warning title=keep-alive::cannot read $wf"; continue; }
  if [ "$state" != "active" ]; then
    echo "::warning title=keep-alive::$wf was $state; re-enabling it"
  fi
  gh api -X PUT "repos/$GITHUB_REPOSITORY/actions/workflows/$wf/enable" >/dev/null 2>&1 \
    || echo "::warning title=keep-alive::could not re-enable $wf"
done
