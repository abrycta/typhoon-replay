#!/usr/bin/env bash
# Runs the built Worker in local workerd: scripts/serve-local.sh <port> <hooks 0|1>
# Needs DATABASE_URL (the connection string the Neon proxy expects) and NEON_HTTP_URL (default http://localhost:4444/sql).
set -euo pipefail
port="$1"; hooks="$2"
cd "$(dirname "$0")/.."
exec npx wrangler dev --port "$port" --ip 127.0.0.1 --persist-to ".wrangler/state-$port" --log-level log \
  --var "TR_TEST_HOOKS:$hooks" --var "TR_RATE_LIMIT_PER_MINUTE:0" \
  --var "TR_SITE_ORIGIN:${SITE_ORIGIN:-http://localhost:8788}" \
  --var "DATABASE_URL:${DATABASE_URL:?DATABASE_URL is required}" \
  --var "NEON_HTTP_URL:${NEON_HTTP_URL:-http://localhost:4444/sql}" \
  --var "TR_COMMIT:${TR_COMMIT:-dev}"
