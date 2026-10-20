#!/usr/bin/env bash
# The full verification pipeline, as run by CI and before a manual deploy:
# install, checks (typecheck, lint, tests), production build, size guard.
# Commands come from deploy.config, the output directory from wrangler.jsonc.
#
# Usage: scripts/ci.sh [--skip-checks] [--clean]
#   --skip-checks  only build and run the size guard
#   --clean        always do a clean install (the default when CI=true)
# Env: BUILD_SHA  commit to stamp into the build (defaults to git HEAD)
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

checks=1 clean=0
[[ "${CI:-}" == true ]] && clean=1
while (($#)); do
  case "$1" in
    --skip-checks) checks=0 ;;
    --clean) clean=1 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

check_node
load_pages_config
if ((clean)); then
  info "Clean install"
  (cd "$REPO_ROOT" && npm ci)
  app_run "$APP_INSTALL"
else
  ensure_deps
fi

if ((checks)); then
  info "Checks: $APP_CHECKS"
  app_run "$APP_CHECKS"
fi

info "Build: $APP_BUILD"
rm -rf "$DIST_DIR"
app_run "$APP_BUILD"
[[ -f "$DIST_DIR/index.html" ]] || die "build did not produce $DIST_DIR/index.html (check pages_build_output_dir in wrangler.jsonc)"
"$REPO_ROOT/scripts/check-size.sh" "$DIST_DIR"
