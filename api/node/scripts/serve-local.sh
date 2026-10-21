#!/usr/bin/env bash
# Run the Worker in local workerd (wrangler dev) against a local database reached through Neon's open-source
# SQL-over-HTTP proxy on :4444 (README "Build and run locally"; the CI conformance job does the same).
#   scripts/serve-local.sh <port> <hooks 0|1>
# DATABASE_URL defaults to the proxy's form of the compose database; NEON_HTTP_URL to http://localhost:4444/sql.
set -euo pipefail
port="${1:-8087}"
hooks="${2:-1}"
cd "$(dirname "$0")/.."
export WRANGLER_SEND_METRICS=false
exec npx wrangler dev --ip 127.0.0.1 --port "$port" --inspector-port 0 --persist-to ".wrangler/state-$port" --show-interactive-dev-session=false \
  --var "DATABASE_URL:${DATABASE_URL:-postgres://tr:tr@db.localtest.me:5432/typhoon}" \
  --var "NEON_HTTP_URL:${NEON_HTTP_URL:-http://localhost:4444/sql}" \
  --var "TR_SITE_ORIGIN:${TR_SITE_ORIGIN:-http://localhost:8788}" \
  --var "TR_TEST_HOOKS:$hooks" \
  --var "TR_RATE_LIMIT_PER_MINUTE:${TR_RATE_LIMIT_PER_MINUTE:-0}" \
  --var "TR_COMMIT:${TR_COMMIT:-local}"
