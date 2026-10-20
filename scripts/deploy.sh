#!/usr/bin/env bash
# Manual deploy to Cloudflare Pages with `wrangler pages deploy` (direct upload).
#
# Usage: scripts/deploy.sh --preview [--branch NAME] [--skip-checks]
#        scripts/deploy.sh --production [--yes] [--skip-checks]
#   --preview      branch deploy: <branch>.<project>.pages.dev (default branch:
#                  the current git branch, or "preview" when that is main)
#   --production   deploy to the production branch (main); asks to confirm
#   --branch NAME  branch name for a preview deploy
#   --yes          don't ask for confirmation
#   --skip-checks  skip APP_CHECKS (the build and size guard always run)
#
# Credentials come from the environment or from a gitignored .env.deploy in the
# repo root (copy .env.deploy.example): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
#
# Idempotent: re-running uploads only changed files, and the Pages project is
# created on the first run if it doesn't exist (same as running by hand:
#   npx wrangler pages project create <name> --production-branch main).
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

target='' branch='' yes=0 checks=1
while (($#)); do
  case "$1" in
    --preview) target=preview ;;
    --production) target=production ;;
    --branch) branch="${2:?--branch needs a value}"; shift ;;
    --yes|-y) yes=1 ;;
    --skip-checks) checks=0 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done
[[ -n "$target" ]] || die "choose --preview or --production (see --help)"

# --- credentials ---
load_env_file "$REPO_ROOT/.env.deploy" CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || die "CLOUDFLARE_API_TOKEN is not set (env or .env.deploy; see README)"
[[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] || die "CLOUDFLARE_ACCOUNT_ID is not set (env or .env.deploy; see README)"
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID WRANGLER_SEND_METRICS=false

check_node
load_pages_config
project="$PAGES_PROJECT"

# --- git metadata ---
git_branch='' commit='' dirty=false
if git -C "$REPO_ROOT" rev-parse --verify -q HEAD >/dev/null; then
  git_branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
  commit="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]] && dirty=true
fi

if [[ "$target" == production ]]; then
  [[ -z "$branch" ]] || die "--branch only applies to --preview"
  branch="$PRODUCTION_BRANCH"
  [[ "$git_branch" == "$PRODUCTION_BRANCH" ]] ||
    warn "you are on '${git_branch:-<no commits>}', not '$PRODUCTION_BRANCH'"
  [[ "$dirty" == false ]] || warn "the working tree has uncommitted changes"
  if ((!yes)); then
    [[ -t 0 ]] || die "production deploy needs confirmation; pass --yes when not interactive"
    read -r -p "Deploy ${commit:0:7}${commit:+ }to PRODUCTION ($project.pages.dev)? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] || die "aborted"
  fi
else
  if [[ -z "$branch" ]]; then
    branch="${git_branch:-preview}"
    [[ "$branch" == "$PRODUCTION_BRANCH" || "$branch" == HEAD ]] && branch=preview
  fi
  [[ "$branch" != "$PRODUCTION_BRANCH" ]] || die "--branch $PRODUCTION_BRANCH would deploy to production; use --production"
fi

# --- install, checks, build, size guard (same as CI) ---
ci_args=()
((checks)) || ci_args+=(--skip-checks)
BUILD_SHA="$commit" "$REPO_ROOT/scripts/ci.sh" ${ci_args[@]+"${ci_args[@]}"}
have_wrangler || die "wrangler is missing from the root node_modules (run npm ci in the repo root)"

# --- Pages project (first run only) ---
ensure_pages_project

# --- deploy ---
deploy_args=(pages deploy "$DIST_DIR" --project-name "$project" --branch "$branch" --commit-dirty="$dirty")
if [[ -n "$commit" ]]; then
  deploy_args+=(--commit-hash "$commit" --commit-message "$(git -C "$REPO_ROOT" log -1 --format=%s)")
fi
info "Deploying to $target (branch '$branch')"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
wrangler "${deploy_args[@]}" 2>&1 | tee "$log"

url="$(grep -Eo 'https://[A-Za-z0-9.-]+\.pages\.dev' "$log" | head -n 1 || true)"
echo
if [[ "$target" == production ]]; then
  ok "production: https://$project.pages.dev"
  if [[ -n "$url" ]]; then echo "     this deployment: $url"; fi
else
  alias_host="$(printf '%s' "$branch" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+|-+$//g' | cut -c1-28)"
  ok "preview: ${url:-<see wrangler output above>}"
  echo "     branch alias: https://$alias_host.$project.pages.dev"
fi
