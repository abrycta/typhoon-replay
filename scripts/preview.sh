#!/usr/bin/env bash
# Production build, then serve exactly what Cloudflare Pages will serve.
#
# Usage: scripts/preview.sh [--no-build] [--port N] [--fallback]
#   --no-build  serve the existing build output as is
#   --port N    port to listen on (default 8788)
#   --fallback  use APP_PREVIEW from deploy.config instead of wrangler
#
# Uses `wrangler pages dev` on the build output (pages_build_output_dir in
# wrangler.jsonc): a local emulation of Pages that applies _headers,
# _redirects and Functions if any. No Cloudflare account or login needed.
# Falls back to the framework's own preview server (APP_PREVIEW, e.g.
# `vite preview`, which ignores _headers) when wrangler can't run.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

build=1 port=8788 fallback=0
while (($#)); do
  case "$1" in
    --no-build) build=0 ;;
    --port) port="${2:?--port needs a value}"; shift ;;
    --fallback) fallback=1 ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

check_node
load_pages_config
if ((build)); then
  "$REPO_ROOT/scripts/ci.sh" --skip-checks
fi
[[ -f "$DIST_DIR/index.html" ]] || die "no build in $DIST_DIR; run without --no-build"

if ((!fallback)) && have_wrangler; then
  info "Serving $DIST_DIR with wrangler pages dev on http://localhost:$port"
  cd "$REPO_ROOT"
  export WRANGLER_SEND_METRICS=false
  exec ./node_modules/.bin/wrangler pages dev "$DIST_DIR" --port "$port" --ip 127.0.0.1 \
    --show-interactive-dev-session=false
fi

((fallback)) || warn "wrangler unavailable; falling back to APP_PREVIEW (no _headers emulation)"
info "Serving with: $APP_PREVIEW --port $port"
cd "$APP_DIR"
exec bash -c "$APP_PREVIEW --port $port"
