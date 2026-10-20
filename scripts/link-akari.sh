#!/usr/bin/env bash
# Switch the app (APP_DIR in deploy.config) between the published design
# system package and a local checkout.
#
#   scripts/link-akari.sh link     use the local checkout ($AKARI_DIR, default ../akari)
#   scripts/link-akari.sh unlink   go back to what package.json/package-lock.json say
#   scripts/link-akari.sh status   show where the package currently resolves
#
# How it works: "link" runs `npm install --no-save <dir>`, which symlinks the
# checkout into the app's node_modules without touching package.json or the lockfile,
# so nothing local can be committed by accident. Any later plain `npm install`
# or `npm ci` drops the link again; re-run "link" afterwards. (npm-based apps
# only; adapt if the frontend moves to another package manager.)
#
# The checkout must be built (its package.json "exports" point at dist/). Keep
# a watch build running there (e.g. `npm run dev` in ../akari) while you work.
# The bundler must dedupe react/react-dom (web/vite.config.ts does) so the
# linked copy shares one React instance.
#
# Env: AKARI_DIR (path to the checkout), AKARI_PACKAGE (expected package name,
# default @abrycta/akari; the name is read from the checkout's package.json).
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

expected="${AKARI_PACKAGE:-@abrycta/akari}"

local_name() {
  [[ -f "$AKARI_DIR/package.json" ]] || die "no package.json in $AKARI_DIR (set AKARI_DIR)"
  node -p 'require(process.argv[1]).name' "$AKARI_DIR/package.json"
}

cmd="${1:-status}"
case "$cmd" in
  link)
    name="$(local_name)"
    [[ "$name" == "$expected" ]] ||
      warn "checkout is named '$name', not '$expected'; imports must use '$name' while linked"
    [[ -d "$AKARI_DIR/dist" ]] ||
      warn "$AKARI_DIR/dist is missing; build the design system first (npm run build there)"
    info "Linking $name -> $AKARI_DIR"
    (cd "$APP_DIR" && npm install --no-save "$(cd "$AKARI_DIR" && pwd)")
    ok "linked. Run 'scripts/link-akari.sh unlink' to go back."
    ;;
  unlink)
    name="$(local_name 2>/dev/null || echo "$expected")"
    info "Removing local link for $name and reinstalling from the lockfile"
    rm -rf "${APP_DIR:?}/node_modules/$name"
    (cd "$APP_DIR" && npm install)
    ok "the app now uses the dependency declared in package.json (if any)"
    ;;
  status)
    names=("$expected")
    other="$(local_name 2>/dev/null || true)"
    [[ -n "$other" && "$other" != "$expected" ]] && names+=("$other")
    for name in "${names[@]}"; do
      path="$APP_DIR/node_modules/$name"
      if [[ -L "$path" ]]; then
        echo "$name: linked -> $(cd "$path" && pwd -P)"
      elif [[ -d "$path" ]]; then
        echo "$name: installed from registry ($(node -p 'require(process.argv[1]).version' "$path/package.json"))"
      else
        echo "$name: not installed"
      fi
    done
    ;;
  *)
    sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
