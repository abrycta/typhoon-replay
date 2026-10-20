#!/usr/bin/env bash
# The full verification pipeline, as run by CI and before a manual deploy:
# install, checks (typecheck, lint, tests), edge proxy tests (functions/ +
# edge/, in workerd), production build, size guard, then end-to-end tests
# against the build (APP_E2E, optional).
# Commands come from deploy.config, the output directory from wrangler.jsonc.
#
# Usage: scripts/ci.sh [--skip-checks] [--skip-e2e] [--clean]
#   --skip-checks  only build and run the size guard (implies --skip-e2e)
#   --skip-e2e     skip APP_E2E
#   --clean        always do a clean install (the default when CI=true)
# Env: BUILD_SHA  commit to stamp into the build (defaults to git HEAD)
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

checks=1 e2e=1 clean=0
[[ "${CI:-}" == true ]] && clean=1
while (($#)); do
  case "$1" in
    --skip-checks) checks=0 e2e=0 ;;
    --skip-e2e) e2e=0 ;;
    --clean) clean=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
  info "Edge proxy: typecheck + tests (npm run test:edge)"
  (cd "$REPO_ROOT" && npm run --silent test:edge)
fi

info "Build: $APP_BUILD"
rm -rf "$DIST_DIR"
app_run "$APP_BUILD"
[[ -f "$DIST_DIR/index.html" ]] || die "build did not produce $DIST_DIR/index.html (check pages_build_output_dir in wrangler.jsonc)"
"$REPO_ROOT/scripts/check-size.sh" "$DIST_DIR"

if ((e2e)) && [[ -n "${APP_E2E:-}" ]]; then
  info "End-to-end: $APP_E2E"
  app_run "$APP_E2E"
fi
