#!/usr/bin/env bash
# Local development: check tools, install dependencies, start the dev server
# (APP_DEV in deploy.config).
#
# Usage: scripts/dev.sh [--host] [--akari-local] [--sample] [-- <extra dev-server args>]
#   --host         listen on all interfaces (open the app from a phone on your LAN)
#   --akari-local  use the local design-system checkout (see scripts/link-akari.sh)
#   --sample       run the pipeline's sample-data step first, if it has one
#
# Sample data: the pipeline can opt in by exposing ONE of these (checked in order):
#   - a [project.scripts] entry named "sample-data" in pipeline/pyproject.toml
#   - a module pipeline/typhoon/sample.py (run as `python -m typhoon.sample`)
# It should write a small, fast-to-build dataset into the app's static folder.
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

host=0 akari_local=0 sample=0 extra=()
while (($#)); do
  case "$1" in
    --host) host=1 ;;
    --akari-local) akari_local=1 ;;
    --sample) sample=1 ;;
    --) shift; extra=("$@"); break ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

info "Checking prerequisites"
check_node
if have uv; then ok "$(uv --version)"; else warn "uv not found: only needed for the data pipeline (https://docs.astral.sh/uv/)"; fi

ensure_deps
if have_wrangler; then ok "wrangler $(wrangler --version 2>/dev/null | tail -n 1)"; else warn "wrangler unavailable: preview.sh will fall back to APP_PREVIEW"; fi

# --- optional sample-data step (detected, never required) ---
pipeline="$REPO_ROOT/pipeline"
sample_cmd=()
if [[ -f "$pipeline/pyproject.toml" ]] && grep -Eq '^[[:space:]]*"?sample-data"?[[:space:]]*=' "$pipeline/pyproject.toml"; then
  sample_cmd=(uv run --project "$pipeline" sample-data)
elif [[ -f "$pipeline/typhoon/sample.py" ]]; then
  sample_cmd=(uv run --project "$pipeline" python -m typhoon.sample)
fi
if ((sample)); then
  if ((${#sample_cmd[@]} == 0)); then
    warn "--sample given but the pipeline exposes no sample step yet; skipping"
  else
    have uv || die "uv is required for --sample"
    info "Sample data: ${sample_cmd[*]}"
    (cd "$REPO_ROOT" && "${sample_cmd[@]}")
  fi
elif ((${#sample_cmd[@]} > 0)); then
  info "Tip: the pipeline has a sample-data step; run with --sample to refresh it"
fi

if ((akari_local)); then
  "$REPO_ROOT/scripts/link-akari.sh" link
fi

dev_cmd="$APP_DEV"
((host)) && dev_cmd+=" --host"
for arg in ${extra[@]+"${extra[@]}"}; do dev_cmd+=" $(printf '%q' "$arg")"; done
info "Starting dev server: $dev_cmd (Ctrl-C to stop)"
cd "$APP_DIR"
exec bash -c "$dev_cmd"
