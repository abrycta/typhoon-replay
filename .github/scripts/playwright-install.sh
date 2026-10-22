#!/usr/bin/env bash
# Installs Playwright's OS packages and (on a browser-cache miss) its Chromium, bounded so a stalled apt mirror or
# download fails in minutes with a clear error instead of using up the job.
#
# Usage: playwright-install.sh <playwright version> <cache-hit: true|false>
# The workflow caches ~/.cache/ms-playwright (the browser) and ~/.cache/playwright-debs (the .deb files apt fetched
# last time) keyed on the Playwright version. On a cache hit apt installs from those .deb files, so it only fetches
# the package index (seconds), and the browser is already in place.
#
# Each install gets 150 s per attempt and one retry. The retry first switches apt to archive.ubuntu.com (the runner's
# Azure mirror is the one that has been stalling). apt runs inside `sudo timeout`, so a timed-out attempt really
# stops apt and frees its lock before the retry.
set -euo pipefail

version=${1:?Playwright version}
cache_hit=${2:-false}
debs="$HOME/.cache/playwright-debs"
pw=(npx --yes "playwright@$version")

# apt: no Microsoft source (it has answered 403 or hung), short network timeouts, keep the .deb files for the cache.
sudo rm -f /etc/apt/sources.list.d/microsoft-prod.list /etc/apt/sources.list.d/microsoft-prod.sources
printf '%s\n' 'Acquire::http::Timeout "30";' 'Acquire::https::Timeout "30";' 'Acquire::Retries "3";' \
  'DPkg::Lock::Timeout "60";' 'APT::Keep-Downloaded-Packages "true";' 'Binary::apt::APT::Keep-Downloaded-Packages "true";' |
  sudo tee /etc/apt/apt.conf.d/99ci-playwright >/dev/null

use_main_ubuntu_mirror() {
  if [ -f /etc/apt/apt-mirrors.txt ]; then
    printf 'http://archive.ubuntu.com/ubuntu/\tpriority:1\nhttp://azure.archive.ubuntu.com/ubuntu/\tpriority:2\n' |
      sudo tee /etc/apt/apt-mirrors.txt >/dev/null
  fi
  sudo sed -i 's#http://azure\.archive\.ubuntu\.com/ubuntu#http://archive.ubuntu.com/ubuntu#g' \
    /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true
  echo "Retrying with archive.ubuntu.com as the first mirror."
}

# bounded <what> <as: root|user> <command...>
bounded() {
  local what=$1 as=$2 i
  shift 2
  for i in 1 2; do
    if [ "$as" = root ]; then
      sudo env "PATH=$PATH" timeout -k 10 150 "$@" && return 0
      sudo dpkg --configure -a || true # finish anything a killed attempt left half-installed
    else
      timeout -k 10 150 "$@" && return 0
    fi
    echo "::warning::$what failed or stalled (attempt $i of 2)"
    [ "$as" = root ] && [ "$i" = 1 ] && use_main_ubuntu_mirror
  done
  echo "::error title=Playwright install::$what failed twice (2.5 min per attempt); see the log above"
  return 1
}

if compgen -G "$debs/*.deb" >/dev/null; then
  echo "Reusing $(find "$debs" -name '*.deb' | wc -l) cached .deb files."
  sudo cp "$debs"/*.deb /var/cache/apt/archives/
fi
start=$SECONDS
bounded "OS packages (apt)" root "${pw[@]}" install-deps chromium
echo "OS packages installed in $((SECONDS - start)) s."
mkdir -p "$debs"
cp /var/cache/apt/archives/*.deb "$debs"/ 2>/dev/null || true

if [ "$cache_hit" = true ]; then
  echo "Playwright $version browser restored from cache: no download."
else
  start=$SECONDS
  bounded "Browser download" user "${pw[@]}" install chromium
  echo "Browser downloaded in $((SECONDS - start)) s."
fi
