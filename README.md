# Replay

Replay any typhoon that hit the Philippines or Japan since 1940, hour by hour:
track, reanalysis wind and rain fields, and the towns it affected. Live at
<https://replay.krtmtthw.dev>, in English and Japanese.

One OpenAPI 3.1 contract is served by four interchangeable backends: Spring Boot
(Java), Go, Node (Hono) and Rust (Axum). Each passes the same conformance suite,
and a same-origin proxy routes `/api/{java,go,node,rust}/` to it. The replay
itself reads precomputed data from a Hugging Face dataset and needs no backend.
Project page: <https://krtmtthw.dev/projects/replay/>.

## Running & deploying

The web app is a static site on **Cloudflare Pages** (free plan, no card).
GitHub Actions checks every push and deploys: `main` goes to production, and
each pull request gets its own preview URL.

| Path | What it is |
|---|---|
| `web/` | The frontend (Vite + React + TanStack, Akari), live at https://replay.krtmtthw.dev (see `web/README.md`) |
| `contracts/` | The shared API contract (OpenAPI 3.1), database migrations and seed, conformance suite and mocks (see `contracts/README.md`) |
| `api/{java,node,rust,go}/` | The four interchangeable backends serving that contract: Spring Boot (Java) and Go on Render, Node and Rust on Cloudflare Workers, all reached at `https://replay.krtmtthw.dev/api/<name>/` (see each backend's README) |
| `pipeline/` | Python data pipeline: IBTrACS catalogue, places and exposure, ERA5 replay frames, Hugging Face publishing |
| `edge/`, `functions/` | The same-origin edge proxy for `/api/*`, deployed as Cloudflare Pages Functions (see `edge/README.md`) |
| `docs/architecture/` | System architecture research and the decisions log |
| `compose.yaml` | Local services by profile: `db` (PostGIS + migrations + seed), `mock` (Prism), `java` |
| `justfile` | Entry point for the contract and backend workflow (`just` lists recipes) |
| `deploy.config` | App directory and the install, check, build, dev and preview commands |
| `wrangler.jsonc` | Pages project name (`typhoon-replay`) and build output directory |
| `scripts/` | `dev.sh`, `preview.sh`, `deploy.sh`, `ci.sh`, `check-size.sh`, `link-akari.sh` |
| `.github/workflows/` | `ci.yml` and `deploy.yml` (see [What happens on push](#what-happens-on-push-and-on-pull-requests)), the data jobs (see [Data pipeline](#data-pipeline-and-workflows)), and the contract, backend, live and budget checks (see [Contract, backend and operations workflows](#contract-backend-and-operations-workflows)) |

Switching the frontend framework means editing `deploy.config` and
`pages_build_output_dir` in `wrangler.jsonc`. The scripts and workflows read
both files, so they stay as they are.

### Prerequisites

- Node 24 (`.nvmrc`; run `nvm use` or `fnm use`) and npm
- [uv](https://docs.astral.sh/uv/), only for the data pipeline
- [just](https://just.systems) and Docker (with compose v2), for the contract, database and backends
- No global wrangler is needed. It is a dev dependency in the root
  `package.json` and is installed on the first run.

### Daily commands

```sh
scripts/dev.sh               # dev server with hot reload (installs deps first if needed)
scripts/dev.sh --host        # same, reachable from other devices on your LAN
scripts/dev.sh --akari-local # use the local ../akari design-system checkout

scripts/ci.sh                # what CI runs: install, typecheck, lint, test, build, size guard
scripts/preview.sh           # production build served by `wrangler pages dev` on :8788,
                             # with the same _headers as Cloudflare; no account needed

scripts/deploy.sh --preview     # upload to <branch>.typhoon-replay.pages.dev
scripts/deploy.sh --production  # upload to typhoon-replay.pages.dev (asks to confirm)
```

Each script has a `--help`. `npm run dev`, `npm run preview` and the other
`npm run` scripts in the root `package.json` call the same scripts.

### One-time setup

Do these once, in this order.

1. **Create a Cloudflare account.** Sign up at <https://dash.cloudflare.com/sign-up>
   with an email address and verify it.
2. **Create an API token.** In the Cloudflare dashboard, go to *My Profile →
   API Tokens → Create Token → Create Custom Token*.
   - Name: `typhoon-replay deploy` (any name works).
   - Permissions: *Account* · *Cloudflare Pages* · *Edit*.
   - Account Resources: *Include* · your account.
   - Click *Continue to summary → Create Token*. Copy the token now, because
     Cloudflare shows it only once.
3. **Find your account ID.** Open *Workers & Pages* in the dashboard. The
   account ID is in the right-hand sidebar. It is also the 32-character hex
   string in the dashboard URL.
4. **Add both as GitHub repository secrets.** In the GitHub repo, go to
   *Settings → Secrets and variables → Actions → New repository secret*:
   - `CLOUDFLARE_API_TOKEN`: the token from step 2
   - `CLOUDFLARE_ACCOUNT_ID`: the ID from step 3

   Until both secrets exist, the Deploy workflow skips with a notice and CI
   still runs. The Pages project `typhoon-replay` is created automatically on
   the first deploy. To create it by hand instead, either run
   `npx wrangler pages project create typhoon-replay --production-branch main`
   or use *Workers & Pages → Create → Pages → Upload assets*.
5. **Optional: deploy from your machine.** Copy `.env.deploy.example` to
   `.env.deploy` (gitignored) and fill in the same two values, or export them
   in your shell.
6. **Install Akari (`@abrycta/akari` on GitHub Packages).** The app's UI comes from it:
   - Create a classic personal access token under *GitHub → Settings →
     Developer settings → Personal access tokens → Tokens (classic) → Generate
     new token (classic)*. Select only the `read:packages` scope.
   - Export it in your shell profile as `NODE_AUTH_TOKEN=<token>`, then
     `cp web/.npmrc.example web/.npmrc` (gitignored) and run
     `npm install @abrycta/akari` in `web/`.
   - CI needs no new secret: the workflows pass `GITHUB_TOKEN` as
     `NODE_AUTH_TOKEN`, with `packages: read`. If the package is private, open
     the package's settings on GitHub (*Manage Actions access*) and give this
     repository read access.
   - To develop against the local checkout, run `scripts/link-akari.sh link`
     (and `unlink` to switch back). See the comments at the top of the script.

### What happens on push and on pull requests

- **Every push and PR** runs `ci.yml`: a clean install, typecheck, lint, unit
  tests, the production build, the size guard and the end-to-end tests. The
  verified build is kept 3 days as the `web-dist` artifact.
- **When CI finishes on `main`**, `deploy.yml` (a `workflow_run` of CI) deploys
  **main's newest commit** once its CI is green, from that run's artifact, with
  `wrangler pages deploy` to production at <https://typhoon-replay.pages.dev>;
  it never builds again, and a red CI never deploys (the run goes red). CI on
  `main` is never cancelled, so every merge ends up live; `/deploy.json` names
  the live commit and `live-check.yml` checks it against `main` every hour.
- **When CI passes on a pull request**, `deploy.yml` deploys a preview to
  `https://pr-<number>.typhoon-replay.pages.dev` and posts the URL as a PR
  comment. The comment is updated on every push. A newer push cancels the
  older preview deploy. PRs from forks are never deployed.
- Each deploy's URL is in the job summary. The page footer shows the commit SHA
  and build time, so you can check which build is live.

### Rolling back

- **Fastest:** in the Cloudflare dashboard, open *Workers & Pages →
  typhoon-replay → Deployments*. On an earlier production deployment, choose
  *⋯ → Rollback to this deployment*. This takes effect at once, with no
  rebuild.
- **From git:** `git revert` the bad commit and push to `main`. Or check out a
  known-good commit and run `scripts/deploy.sh --production`. The script warns
  that you are not on `main`, then deploys that build.

### Free-tier limits that matter

| Limit | Value | How this repo handles it |
|---|---|---|
| File size | 25 MiB per file | `scripts/check-size.sh` fails the build first |
| Files per deployment | 20,000 | Same guard; it warns above 80% |
| Builds | 500 per month | Counts builds Cloudflare runs from Git pushes. This repo builds in GitHub Actions and uploads with wrangler. |
| `_headers` rules | 100 | 17 used (`web/public/_headers`) |
| Bandwidth / requests | Unlimited for static files | n/a |
| GitHub Actions | Free on public repos; 2,000 min/month if private | A CI run takes about 4 to 5 minutes |
| Pages Functions | Share the Workers quota (100k requests/day) | Used only for `/api/*` and `/assets/*.map` (`web/public/_routes.json`); other static files never invoke a Function |

Larger data, such as the big Parquet tables, goes to Hugging Face Datasets and
is queried in the browser with DuckDB-WASM, not served from Pages.

### Caching and security headers

`web/public/_headers` is copied to the build root. It sets:

- a one-year immutable cache on `/assets/*` (content-hashed by the bundler)
  and on `/embed-data/*`;
- `must-revalidate` on the HTML, `/config.json` and the `/storm/*` share pages;
- basic security headers, including a CSP that already allows DuckDB-WASM,
  MapLibre workers, Hugging Face and OpenFreeMap.

When the app starts fetching data from a new host, add it to `connect-src`.

### Data pipeline and workflows

The Python pipeline (`pipeline/`, Python 3.12 with `uv`) builds the static data and publishes it to the
public Hugging Face dataset
[`permission-alluring/typhoon-replay`](https://huggingface.co/datasets/permission-alluring/typhoon-replay),
never to Pages. Every download goes through `typhoon.sources` (archivekit) with automatic fallback and
provenance; see `docs/architecture/DATA-RESILIENCE.md`.

```sh
cd pipeline && uv sync
uv run python -m typhoon prepare            # IBTrACS, places, JMA numbers, PAGASA names, catalogue, exposure
uv run python -m typhoon frames --list curated/replay-v1.txt   # ERA5 replay frames (about 2 min per storm)
uv run python -m typhoon dataset build --version 1             # data/build/v1/ + gates
uv run python -m typhoon publish all --version 1               # upload, verify Range/CORS, flip latest.json
uv run python -m typhoon publish rollback --to 1               # point latest.json back at v1
uv run python -m typhoon dbload --dsn "$DATABASE_URL" --tables ../data/build/tables-v1 --ibtracs-version v04r01
```

| Workflow | Trigger | What it does |
|---|---|---|
| `pipeline.yml` | PRs and pushes touching `pipeline/` | registry validation, ruff, mypy, unit tests, the Postgres loader against `postgis/postgis:18-3.6` (testcontainers), actionlint |
| `backfill.yml` | `workflow_dispatch` | prepare → a matrix of storm batches building and uploading frames → assemble, gate, upload and flip `latest.json` only if every batch passed |
| `refresh.yml` | weekly (Mon 03:17 UTC) | re-fetch IBTrACS; if it changed, frames for new or revised storms, then publish a new version |

Secrets: `ARCHIVE_READ_TOKEN` (installs the private `archivekit` through a git `insteadOf` rewrite and
reads the archive fallback) and `HF_TOKEN` (a Hugging Face write token for `permission-alluring`). Jobs
skip with a notice when either is missing. Locally the token comes from `HF_TOKEN` or the Keychain item
`huggingface-token`.

### Contract, backend and operations workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `contracts.yml` | PRs and pushes touching `contracts/`, `compose.yaml` or `justfile` | contract lint, 3.1 and 3.0 bundles, the oasdiff breaking-change gate; migrations up, down and up against PostGIS, then the seed; Schemathesis and the contract scenarios against Prism |
| `java.yml`, `go.yml`, `node.yml`, `rust.yml` | PRs and pushes touching that backend or `contracts/` | build and unit tests, then the conformance suite (Vitest scenarios and Schemathesis) against PostGIS 18 with the migrations and seed; on `main`, the deploy (Render for Java and Go, `wrangler deploy` for Node and Rust) and the live checks |
| `live.yml` | after each backend deploy, weekly (Mon 03:41 UTC) and by hand | the dataset-independent part of the conformance suite against each live backend; a failure opens an issue |
| `live-check.yml` | hourly | compares the live `/deploy.json` with `main`; stale for over 30 minutes, it fails and dispatches the deploy |
| `budget.yml` | every 8 hours | reads the free-tier meters (Render hours and bandwidth, Cloudflare requests, Neon compute, egress and storage); opens an issue at 70 %, pauses a Render service at 85 % of the free hours, and switches the edge to static mode when a meter trips |
| `api-load.yml` | after a successful `refresh.yml` or `backfill.yml` run, and by hand | migrates the API database (Neon) and loads the published data version in one transaction, behind a size guard for Neon Free's 1 GB |
