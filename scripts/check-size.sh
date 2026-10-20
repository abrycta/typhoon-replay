#!/usr/bin/env bash
# Fail if a build output breaks Cloudflare Pages' free-tier upload limits:
# no file over 25 MiB and at most 20,000 files per deployment.
# https://developers.cloudflare.com/pages/platform/limits/
#
# Usage: scripts/check-size.sh [DIR]   (default: pages_build_output_dir in wrangler.jsonc)
# Env:   MAX_FILE_BYTES (default 26214400), MAX_FILES (default 20000)
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [[ -n "${1:-}" ]]; then
  dir="$1"
else
  load_pages_config
  dir="$DIST_DIR"
fi
max_bytes="${MAX_FILE_BYTES:-26214400}"
max_files="${MAX_FILES:-20000}"

[[ -d "$dir" ]] || die "$dir does not exist. Build first (scripts/ci.sh or the APP_BUILD command)."

count="$(find "$dir" -type f | wc -l | tr -d ' ')"
big="$(find "$dir" -type f -size +"${max_bytes}"c)"
total_kib="$(du -sk "$dir" | cut -f1)"

info "Size guard: $dir ($count files, $((total_kib / 1024)) MiB total)"

status=0
if [[ -n "$big" ]]; then
  warn "files over $((max_bytes / 1048576)) MiB (Cloudflare Pages rejects these):"
  while IFS= read -r f; do
    printf '  %s (%s MiB)\n' "${f#"$dir"/}" "$(( $(wc -c <"$f") / 1048576 ))" >&2
  done <<<"$big"
  status=1
fi
if (( count > max_files )); then
  warn "$count files exceeds the $max_files-file limit per deployment"
  status=1
elif (( count > max_files * 8 / 10 )); then
  warn "$count files is over 80% of the $max_files-file limit"
fi

if (( status != 0 )); then
  die "size guard failed"
fi
ok "size guard passed (largest files below)"
find "$dir" -type f -exec du -k {} + | sort -rn | awk 'NR <= 3' | while read -r kib f; do  # awk, not head: head closing the pipe early makes sort exit 141 under pipefail
  printf '  %6s KiB  %s\n' "$kib" "${f#"$dir"/}"
done
