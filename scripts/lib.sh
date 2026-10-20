# shellcheck shell=bash
# Shared helpers for scripts/*.sh. Source it; don't run it.
#
# Project-specific settings live outside the scripts, so another project can
# copy scripts/ unchanged:
#   deploy.config   app directory and install/check/build/dev commands
#   wrangler.jsonc  Pages project name and build output directory
#   .nvmrc          Node version

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRODUCTION_BRANCH="${PRODUCTION_BRANCH:-main}"
# Local checkout of the design system, used by --akari-local / link-akari.sh.
AKARI_DIR="${AKARI_DIR:-$REPO_ROOT/../akari}"

# shellcheck source=deploy.config
source "$REPO_ROOT/deploy.config"
APP_DIR="$REPO_ROOT/$APP_DIR"

if [[ -t 1 ]]; then
  _c_bold=$'\033[1m' _c_red=$'\033[31m' _c_yellow=$'\033[33m' _c_green=$'\033[32m' _c_off=$'\033[0m'
else
  _c_bold='' _c_red='' _c_yellow='' _c_green='' _c_off=''
fi

info() { printf '%s==>%s %s\n' "$_c_bold" "$_c_off" "$*"; }
ok()   { printf '%s ok%s %s\n' "$_c_green" "$_c_off" "$*"; }
warn() { printf '%swarn:%s %s\n' "$_c_yellow" "$_c_off" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$_c_red" "$_c_off" "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# Run a deploy.config command string inside APP_DIR.
app_run() { (cd "$APP_DIR" && bash -c "$1"); }

# Read a top-level key from wrangler.jsonc (comments stripped, then JSON-parsed).
wrangler_config() {
  node -e '
    const src = require("fs").readFileSync(process.argv[1], "utf8");
    const json = src.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => s ?? "");
    process.stdout.write(String(JSON.parse(json)[process.argv[2]] ?? ""));
  ' "$REPO_ROOT/wrangler.jsonc" "$1"
}

# Fail unless the active Node major version matches .nvmrc.
check_node() {
  have node || die "node not found. Install Node $(cat "$REPO_ROOT/.nvmrc") (e.g. 'nvm install' or 'fnm use')."
  have npm || die "npm not found (it ships with Node)."
  local want have_v
  want="$(tr -d ' v\n' <"$REPO_ROOT/.nvmrc")"
  have_v="$(node -p 'process.versions.node')"
  if [[ "${have_v%%.*}" != "${want%%.*}" ]]; then
    die "Node $have_v is active but .nvmrc wants $want. Run 'nvm use' (or 'fnm use') in $REPO_ROOT."
  fi
  ok "node $have_v, npm $(npm -v)"
}

# Set PAGES_PROJECT and DIST_DIR (absolute) for callers; needs node.
# shellcheck disable=SC2034
load_pages_config() {
  PAGES_PROJECT="$(wrangler_config name)"
  DIST_DIR="$(cd "$REPO_ROOT" && node -p 'require("path").resolve(process.argv[1])' "$(wrangler_config pages_build_output_dir)")"
  [[ -n "$PAGES_PROJECT" ]] || die "wrangler.jsonc has no name"
}

# Install root tooling (wrangler) and app dependencies when missing or stale.
ensure_deps() {
  local dir marker
  for dir in "$REPO_ROOT" "$APP_DIR"; do
    marker="$dir/node_modules/.package-lock.json"
    [[ -f "$dir/package-lock.json" ]] || continue
    if [[ ! -f "$marker" || "$dir/package-lock.json" -nt "$marker" ]]; then
      info "Installing dependencies in ${dir#"$REPO_ROOT"/}"
      if [[ "$dir" == "$APP_DIR" ]]; then app_run "$APP_INSTALL"; else (cd "$dir" && npm ci); fi
    fi
  done
  ok "dependencies up to date"
}

# True if the repo-local wrangler (root devDependency) can run.
have_wrangler() { [[ -x "$REPO_ROOT/node_modules/.bin/wrangler" ]]; }
wrangler() { (cd "$REPO_ROOT" && WRANGLER_SEND_METRICS=false ./node_modules/.bin/wrangler "$@"); }

# Create the Pages project on first use (needs CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID, and load_pages_config). Same as doing it by hand:
#   npx wrangler pages project create <name> --production-branch main
ensure_pages_project() {
  # `project list --json` prints an array of objects; match the name in any field.
  if wrangler pages project list --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const rows = JSON.parse(s);
        process.exit(rows.some((r) => Object.values(r).includes(process.argv[1])) ? 0 : 1);
      } catch { process.exit(1); }
    });
  ' "$PAGES_PROJECT"; then
    ok "Pages project '$PAGES_PROJECT' exists"
  else
    info "Creating Pages project '$PAGES_PROJECT' (production branch: $PRODUCTION_BRANCH)"
    wrangler pages project create "$PAGES_PROJECT" --production-branch "$PRODUCTION_BRANCH"
  fi
}

# Load KEY=VALUE lines for the named keys from a dotenv-style file, without
# executing it. Variables already set in the environment win.
load_env_file() {
  local file="$1"; shift
  [[ -f "$file" ]] || return 0
  local key line value
  for key in "$@"; do
    [[ -n "${!key:-}" ]] && continue
    line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" | tail -n 1 || true)"
    [[ -z "$line" ]] && continue
    value="${line#*=}"
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    export "$key=$value"
  done
}
