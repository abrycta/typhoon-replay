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
# Prints one line:  CURRENT | PENDING | BLOCKED | STALE  repo · live <sha> · main <sha> · detail
# How "live lags main" is decided (by ancestry and content, never by commit dates):
#   - live is the sha in deploy.json as a visitor gets it (no cache-buster; a differing cache-busted copy is noted);
#   - live == main, or the same tree as main (a rewritten copy of the same commit): CURRENT;
#   - the diff live..main touches nothing the deploy covers: CURRENT;
#   - otherwise the clock starts when CI on main first turned fully green for a commit the deploy covers
#     (every push run of that commit completed with success). Under GRACE_MIN (default 20) minutes: PENDING;
#     older: STALE. No green covered commit yet: PENDING while its CI runs, BLOCKED when it is red (the
#     workflow line in ci-red.sh is the red check), STALE when no CI ran at all for 20+ minutes.
#   - the home page served from an older build than deploy.json (Last-Modified, for 20+ minutes): STALE.
# STALE exits 1, and with --redeploy the deploy workflow is dispatched on main (it deploys the newest green commit).
# LIVE_SHA=<sha> pretends that commit is live (to test the verdicts against past incidents).
# Also prints INFO lines for cancelled or skipped runs of the deploy workflow on main since its last success.
#
# Canonical copy: the workspace tools/lib/live-check.sh (tools/ci-red.sh runs it); each deployed repo carries
# the same file as .github/scripts/live-check.sh for its hourly live-check workflow. Keep them identical.
set -uo pipefail
redeploy=0
[ "${1:-}" = "--redeploy" ] && { redeploy=1; shift; }
repo="${1:-${GITHUB_REPOSITORY:-}}"
grace="${GRACE_MIN:-20}"
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
paths="${paths:-*}"
name="${repo#*/}"
now=$(date -u +%s)
# Minutes since an ISO-8601 UTC time (GitHub's format) or an HTTP date.
mins_since() { jq -rn --arg t "$1" --argjson now "$now" \
  '(($t | sub("\\.[0-9]+Z$"; "Z") | try fromdateiso8601 catch ($t | strptime("%a, %d %b %Y %H:%M:%S GMT") | mktime)) as $s
   | (($now - $s) / 60 | floor))' 2>/dev/null; }

head="$(gh api "repos/$repo/commits/main" --jq .sha 2>/dev/null)"
[ -n "$head" ] || { echo "ERROR     $name · could not read main"; exit 2; }
sha_of() { curl -fsS --max-time 20 "$1" 2>/dev/null | jq -r '.sha // empty' 2>/dev/null; }
live="$(sha_of "$url/deploy.json")"
busted="$(sha_of "$url/deploy.json?t=$now")"
note=""
[ -n "$live" ] || live="$busted"
[ -n "${LIVE_SHA:-}" ] && live="$LIVE_SHA" busted=""   # test hook: pretend this sha is live
[ -n "$busted" ] && [ "$busted" != "$live" ] && note=" (edge cache serves ${live:0:7}, origin ${busted:0:7})"

state=CURRENT detail=""
if [ -z "$live" ]; then
  state=STALE detail="no $url/deploy.json"
elif [ "$live" != "$head" ]; then
  live_tree="$(gh api "repos/$repo/commits/$live" --jq .commit.tree.sha 2>/dev/null)"
  head_tree="$(gh api "repos/$repo/commits/$head" --jq .commit.tree.sha 2>/dev/null)"
  if [ -z "$live_tree" ]; then
    state=STALE detail="live commit $live is not in the repo"
  elif [ "$live_tree" = "$head_tree" ]; then
    detail="same content as main (live is a rewritten copy of main's commit)"
  else
    # The commits after live (oldest first) that change what the deploy covers; none if the diff misses it.
    cmp="$(gh api "repos/$repo/compare/$live...$head" 2>/dev/null)" || cmp=""
    if [ -n "$cmp" ] && [ "$(jq -r .status <<<"$cmp")" = behind ]; then
      covered="" detail="live is ahead of main"
    elif [ -n "$cmp" ]; then
      covered="$(jq -r --arg paths "$paths" '
        ($paths | split(" ") | map(select(length > 0) | sub("/$"; ""))) as $p
        | def hit: . as $f | $p | any(. as $q | $q == "*" or $f == $q or ($f | startswith($q + "/")));
        if .files != null and (.files | length) < 300 and ([.files[].filename | select(hit)] | length) == 0
        then empty else .commits[].sha end' <<<"$cmp")"
      # With path filters, keep only the commits that touch a covered path (one listing per path).
      if [ -n "$covered" ] && [ "$paths" != "*" ]; then
        since="$(jq -r '.merge_base_commit.commit.committer.date' <<<"$cmp")"
        touching="$(for p in $paths; do
            gh api "repos/$repo/commits?sha=main&since=$since&per_page=100&path=$p" --jq '.[].sha' 2>/dev/null
          done | sort -u)"
        covered="$(grep -Fxf <(printf '%s\n' "$touching") <<<"$covered")"
      fi
      [ -n "$covered" ] || detail="newer main commits don't touch what the deploy covers"
    else
      # No common ancestor (main was rewritten): every main commit since the live one counts.
      since="$(gh api "repos/$repo/commits/$live" --jq .commit.committer.date 2>/dev/null)"
      covered="$(gh api "repos/$repo/commits?sha=main&since=$since&per_page=100" --jq 'reverse | .[].sha' 2>/dev/null)"
      [ -n "$covered" ] || covered="$head"
      note="$note (live is not in main's history)"
    fi
    if [ -n "$covered" ]; then
      # Push runs on main for the covered commits: a commit is green when all its runs completed with success.
      runs="$(gh run list -R "$repo" -b main -e push -L 200 \
        --json headSha,status,conclusion,updatedAt,workflowName 2>/dev/null || echo '[]')"
      verdict="$(jq -r --arg c "$covered" '
        ($c | split("\n") | map(select(length > 0))) as $cov
        | map(select(.headSha as $s | $cov | index($s))) | group_by(.headSha)
        | map({sha: .[0].headSha,
               green: all(.status == "completed" and (.conclusion == "success" or .conclusion == "skipped")),
               running: any(.status != "completed"),
               red: any(.status == "completed" and (.conclusion | IN("success", "skipped", "cancelled", "neutral") | not)),
               done: (map(.updatedAt) | max)})
        | if any(.green) then "GREEN \(map(select(.green)) | sort_by(.done) | first | "\(.done) \(.sha)")"
          elif any(.running) then "RUNNING"
          elif any(.red) then "RED"
          else "NONE" end' <<<"$runs")"
      case "$verdict" in
        GREEN*)
          read -r _ t sha <<<"$verdict"
          age="$(mins_since "$t")"
          if [ "${age:-0}" -lt "$grace" ]; then
            state=PENDING detail="CI on main went green for ${sha:0:7} ${age} min ago (deploy may still be running)"
          else
            state=STALE detail="CI on main went green for ${sha:0:7} ${age} min ago and live still lags main"
          fi ;;
        RUNNING) state=PENDING detail="CI on main is still running for the undeployed commits" ;;
        RED) state=BLOCKED detail="CI on main is red for the undeployed commits, so the gate holds production (see the workflow line)" ;;
        *)
          oldest="$(gh api "repos/$repo/commits/$(head -1 <<<"$covered")" --jq .commit.committer.date 2>/dev/null)"
          age="$(mins_since "${oldest:-1970-01-01T00:00:00Z}")"
          if [ "${age:-0}" -lt "$grace" ]; then state=PENDING detail="CI on main has not started for the undeployed commits"
          else state=STALE detail="no CI run on main for undeployed commits ${age} min old"; fi ;;
      esac
    fi
  fi
fi

# The page a visitor gets must come from the same build as deploy.json (catches an edge serving an older build).
if [ "$state" = CURRENT ]; then
  lm() { curl -fsS -I --max-time 20 "$1" 2>/dev/null | tr -d '\r' | sed -n 's/^[Ll]ast-[Mm]odified: //p' | head -1; }
  page_lm="$(lm "$url/")" json_lm="$(lm "$url/deploy.json")"
  if [ -n "$page_lm" ] && [ -n "$json_lm" ]; then
    page_age="$(mins_since "$page_lm")" json_age="$(mins_since "$json_lm")"
    if [ -n "$page_age" ] && [ -n "$json_age" ] && [ $((page_age - json_age)) -ge 3 ] && [ "$json_age" -ge "$grace" ]; then
      state=STALE detail="the home page is from an older build (${page_lm}) than deploy.json (${json_lm})"
    fi
  fi
fi
[ "$state" = CURRENT ] && [ -z "$detail" ] && detail="deployed"
printf '%-9s %s · live %s · main %s · %s%s · %s\n' "$state" "$name" "${live:0:7}" "${head:0:7}" "$detail" "$note" "$url"

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
