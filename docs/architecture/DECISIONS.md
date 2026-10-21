# Architecture decisions

Decided 2026-10-21 by Kurt, after the research in this folder, `contracts/docs/`, `web/docs/` and `api/<language>/docs/`.

| Area | Decision | Research |
|---|---|---|
| System | **Option A: one origin, four engines.** Cloudflare Pages app plus a same-origin proxy function routing `/api/{impl}/*` to four Render services that sleep when idle; one shared Neon PostGIS database; shared, language-neutral session table; ingestion, alert mail and migrations run in GitHub Actions. Edge caching of public reads is required. | `SYSTEM-ARCHITECTURE-RESEARCH.md` §0, §9 |
| Frontend | **Stack A: static-first SPA.** Vite 8, React 19, TanStack Router + Query, client generated from the contract, MapLibre 6 with a custom WebGL2 wind layer, Akari design system. Mock mode with no backend. | `web/docs/ARCHITECTURE-RESEARCH.md` §9 |
| Java | **Stack A: Spring Modulith.** Spring Boot 4.1, Java 25, MVC with virtual threads, JdbcClient with PostGIS SQL, generated interfaces, Spring Security 7, AOT cache. | `api/java/docs/ARCHITECTURE-RESEARCH.md` §12 |
| Node | **Stack A: Fastify contract-first.** Node 24, Fastify 5, routes wired from the spec, Kysely, Arctic, @fastify/sse. | `api/node/docs/ARCHITECTURE-RESEARCH.md` §9 |
| Rust | **Stack A: contract-first Axum.** Axum 0.8, typify contract crate, SQLx 0.9. | `api/rust/docs/ARCHITECTURE-RESEARCH.md` §10 |
| Go | **Stack A: standard library + oapi-codegen.** Go 1.27 net/http, oapi-codegen strict server, kin-openapi validation, pgx + sqlc. | `api/go/docs/ARCHITECTURE-RESEARCH.md` §9, §11 |
| Build order | **Contract first, then Java, then Go, Node, Rust.** The frontend is built in parallel against the mock server. | — |
| Contract | **OpenAPI 3.1, portable subset** (no nulls, no type arrays; SSE described with `x-sse-events`). Revisit 3.2 when tooling catches up. | `contracts/docs/CONTRACT-GUIDE.md` |
| Storm frames | **Hugging Face dataset** (range requests, CORS), kept off the app origin. | `web/docs/ARCHITECTURE-RESEARCH.md`, `SPIKE.md` |
| Languages (v1) | **English + Japanese.** PAGASA local names shown beside international names. | — |

## Update 2026-10-21: custom domain

- The app is served at **https://replay.krtmtthw.dev** (Porkbun DNS CNAME → `typhoon-replay.pages.dev`; Cloudflare Pages custom domain, HTTPS). Renamed from Typhoon Replay and moved from `typhoon.krtmtthw.dev` later the same day, with no redirect from the old host (contract 2.0.2). This is System option A on the owner's domain (option B's domain part); the API stays same-origin under `/api/{impl}/`. Alert email from the domain is a later step (sender DNS records at Porkbun).

## Update 2026-10-21: no accounts; static-first visitors; Under the hood showcase

Supersedes the account parts of the table above (System: "shared, language-neutral session table" and "alert mail"; Java: "Spring Security 7"; Node: "Arctic") and the alert-email step of the custom-domain update.

- **No account features.** No sign-in (Google/GitHub OAuth), sessions, `/v1/me`, saved places, alert preferences, alert email or unsubscribe. The API keeps only public reads: health/readiness, meta, storms, places, hits, live (snapshot + SSE stream), plus the live-event test hook.
- **Visitors are served static-first.** Visitor features come from static files (Pages, Hugging Face) and the browser, not from the API, so the site works without any backend awake.
- **The API is a showcase.** An "Under the hood" page races the same request across the backends. Reads must stay fast and identical across backends (status, headers, ETag, JSON); every response except the live stream is publicly cacheable, no cookies, no CSRF.
- **Contract 2.0.0** (breaking, removals only) is still served under `/v1`: the URL major changes only when an operation that stays changes (`contracts/docs/CONTRACT-GUIDE.md` §2, §14; `contracts/CHANGELOG.md`). Database migration `20261021000600_drop_accounts` drops `auth.*` and the `app` account tables.
- **Four backends, unchanged build order:** contract → Java → Go → Node → Rust. The frontend is built in parallel.

## Update 2026-10-21: dataset file sizes (whole-catalogue backfill)

The first whole-catalogue build (2,058 storms with frames) failed its dataset check: `v2/frames-index.json` was 30 MB, over the 25 MiB per-file cap (Cloudflare Pages). It held, per storm, the track hash and the full frame record (time, centre, per-frame `series`, every frame file's path, size and sha256, ~14 kB), which `summary.json` already carries for the app. Only the pipeline reads it (to reuse frames whose track did not change, and in the check).

- **Frames index sharded by season**: `v<N>/frames-index/<season>.json` (largest ~0.5 MB; ~29 MB in all). `index.json` names the shards with `framesIndexShards: "v<N>/frames-index/{season}.json"` instead of `framesIndex`. The pipeline still reads v1's single `frames-index.json`, so building on the published v1 works. Kept as data rather than re-derived from 2,058 `summary.json` files: reuse then costs ~70 requests, not ~2,000. The web app never fetches it.
- **File checksums moved out of `manifest.json`** into `v<N>/files.json` (manifest names it in `fileList`): with every frame file listed the manifest was 5.2 MB (1.5 MB gzip), and the app fetches it on every page for the footer. The pipeline and `publish` read either form.
- **Every version holds every storm folder.** The build used to drop an unchanged storm's folder and point its `path` at an earlier version, but the app reads `v<N>/storms/<sid>/` (web/docs/DATA-LAYOUT.md), so those storms would have 404ed after the flip. Unchanged files are deduplicated by the Hub, so this costs upload commits, not storage.
- **Budgets in the dataset check:** 25 MiB for any file (hosting cap); 2.5 MB raw for `index.json` (the browse catalogue, ~185 kB gzip); **1 MB raw for every other file fetched before a page can draw**: `manifest.json`, `places/index.json`, each storm's `summary.json` and `track.json`. JSON gzips about 8×, so 1 MB is ~125 kB transferred and well under 50 ms to parse on a mid-range phone; today the largest is a 105 kB `track.json`.
- **Backfill `reuse_run` input:** a publish that fails after its frames job succeeded can be redone from that run's artifacts (the prepared catalogue and the `frames.json` files, kept 7 days) without rebuilding frames. The data-quality gates, the dataset check and the upload verification still run.

## Update 2026-10-22: hosting the Go, Node and Rust backends (free tiers only)

System option A planned four Render services that sleep. Render's free plan gives **750 instance hours per
workspace per month, shared by every free service**; running out suspends all of them (the live Java backend
included) until the next month, and outbound bandwidth is 5 GB/month shared (an overage bills the card on file).
Four Render services could need up to 4 × 744 h. So only Java and Go use Render; Node and Rust run on Cloudflare
Workers, which consume no Render hours.

| Backend | Hosting | Database access | Why |
|---|---|---|---|
| Java | Render free web service (unchanged) | JDBC, Neon pooled URL | Already live |
| Go | **Render free web service, sleeps after 15 min** | Neon serverless SQL over HTTP (`api/go/internal/neon`) | Measured on Workers first (TinyGo 0.43 → wasm, workers-go): it passed conformance, but starting a Go instance cost **15–55 ms CPU at p50** per request against the free plan's 10 ms ("a Worker that consistently hits the limit has its execution terminated"). A shared instance per isolate does not help: requests land on fresh isolates. Native Go on Render has no such limit and keeps the recorded stack (Go 1.27, net/http, oapi-codegen). |
| Node | **Cloudflare Worker** `replay-api-node` (workers.dev + service binding from the edge) | Neon serverless HTTP | Fastify 5 cannot run on Workers: its boot generates code from strings (`EvalError: Code generation from strings disallowed`, measured with `nodejs_compat`). The Node backend takes the closest contract-first stack that fits (decided by its build, recorded in `api/node/`). |
| Rust | **Cloudflare Worker** `replay-api-rust` (workers-rs, wasm) | Neon serverless HTTP via the Workers fetch API | Axum 0.8 routers run on workers-rs; SQLx needs Tokio sockets, which Workers lack, so queries go over Neon's HTTP endpoint. |

**Node stack** (2026-10-22, recorded in `api/node/README.md`): Hono 4.13 on Workers; openapi-typescript types and Ajv
validators generated from the contract at build time (standalone code, so nothing is compiled from strings at runtime);
Kysely 0.29 only to compile SQL. Trade-off: no Fastify plugin ecosystem, and SSE streams end after 90 s (subrequest cap).

**Neon over HTTP, not Hyperdrive** (for the Workers backends and Go): one HTTPS request per transaction
(`POST https://{host}/sql`, read-only batch with `SET LOCAL statement_timeout = 5000`), no connection held between
requests. Hyperdrive (free: 100k queries/day) keeps a pool of origin connections, and open connections stop Neon's
compute from scaling to zero; an always-on 0.25 CU compute is ~186 CU-h/month against the free 100. CI runs the same
protocol against PostGIS through Neon's open-source proxy (`ghcr.io/timowilhelm/local-neon-http-proxy`, by digest).

**Edge routing.** One entry per backend, additive: its origin in `BACKEND_ORIGINS` (Pages vars in `wrangler.jsonc`),
plus, for a Worker, a service binding `API_{IMPL}` to `replay-api-{impl}` (Pages `services`). The proxy sends that
origin's requests through the binding (`edge/src/proxy.ts`, `upstreamFetch`): no public hop, and no same-account
`workers.dev` fetch restriction. Caching, stale-if-error, compression and the per-IP limit stay at the edge for every
backend.

**Worker conventions** (Node, Rust): name `replay-api-{impl}` on `https://replay-api-{impl}.krtmtthw.workers.dev`;
secrets `DATABASE_URL` (Neon pooled URL) and `TR_EDGE_SECRET` set with `wrangler secret put`, never in files;
vars `TR_SITE_ORIGIN`, `TR_TEST_HOOKS` ("0" in production), `TR_RATE_LIMIT_PER_MINUTE`, `TR_COMMIT`; optional
`NEON_HTTP_URL` for local runs; a rate limiting binding `RATE_LIMITER` (free; namespace ids 1002 node, 1003 rust);
Workers Logs on. Check CPU per request after deploying (Workers analytics `cpuTimeP50`): the free plan allows 10 ms.

**Budget.** Render hours, estimated from CPU samples: Java ran ~6.3 h in its first ~44 h live, a busy development
period. Two sleeping services at that rate are ~2 × 105 h ≈ 210 h/month (28 % of 750); worst case, both awake
around the clock, is 2 × 744 = 1,488 h, which would suspend both around day 15. Guards: edge caching (catalogue
answers pinned to the dataset version), `stale-if-error`, no keep-alive pingers, and `.github/workflows/budget.yml`,
a daily read of Render hours and bandwidth, Cloudflare requests (100k/day shared by Workers and Pages Functions) and
Neon usage that opens an issue when a meter passes 70 % or is projected past 100 %. Neon's usage needs a
`NEON_API_KEY` secret and `NEON_PROJECT_ID` variable (not set yet).

## Frozen showcase policy

Once a backend is built (Java now; Go, Node and Rust as they land) it is **pinned and only receives security fixes**, so the "Under the hood" race always compares the same code.

- **Pinned:** every dependency at an exact version with a committed lockfile (Gradle version catalog + `gradle.lockfile`s in strict mode; npm exact versions + `package-lock.json`; `Cargo.lock`; `go.mod` + `go.sum`), and every toolchain (Java 25 / Node 24 base images by digest, Gradle distribution by checksum, `rust-toolchain.toml`, the `go` directive).
- **Security fixes:** Renovate (`renovate.json`) disables routine updates for `api/**` and opens vulnerability-only PRs (GitHub advisories / OSV), grouped per backend, plus base-image digest bumps for CVE patches. They auto-merge only when that backend's CI is green: its own tests **and** the conformance suite against its image (Renovate waits for every status check; branch protection on `main` should also require them, e.g. java.yml's "Build and test" and "Conformance"). `web/`, `pipeline/` and the rest keep Renovate's normal update policy.
- **Unfreezing** for a deliberate upgrade: change the pins, regenerate the lockfile, re-measure startup/RSS, open a PR labelled `unfreeze`; the same tests and conformance gate it. Details per backend in `api/<lang>/README.md` (or `docs/`).

## Noted for later

- Earth Engine is optional: the spike found NCAR ERA5 on AWS about 21× cheaper per storm window than ARCO-ERA5.
