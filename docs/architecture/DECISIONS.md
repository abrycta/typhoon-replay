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

- The app is served at **https://typhoon.krtmtthw.dev** (Porkbun DNS CNAME → `typhoon-replay.pages.dev`; Cloudflare Pages custom domain, HTTPS). This is System option A on the owner's domain (option B's domain part); the API stays same-origin under `/api/{impl}/`. Alert email from the domain is a later step (sender DNS records at Porkbun).

## Update 2026-10-21: no accounts; static-first visitors; Under the hood showcase

Supersedes the account parts of the table above (System: "shared, language-neutral session table" and "alert mail"; Java: "Spring Security 7"; Node: "Arctic") and the alert-email step of the custom-domain update.

- **No account features.** No sign-in (Google/GitHub OAuth), sessions, `/v1/me`, saved places, alert preferences, alert email or unsubscribe. The API keeps only public reads: health/readiness, meta, storms, places, hits, live (snapshot + SSE stream), plus the live-event test hook.
- **Visitors are served static-first.** Visitor features come from static files (Pages, Hugging Face) and the browser, not from the API, so the site works without any backend awake.
- **The API is a showcase.** An "Under the hood" page races the same request across the backends. Reads must stay fast and identical across backends (status, headers, ETag, JSON); every response except the live stream is publicly cacheable, no cookies, no CSRF.
- **Contract 2.0.0** (breaking, removals only) is still served under `/v1`: the URL major changes only when an operation that stays changes (`contracts/docs/CONTRACT-GUIDE.md` §2, §14; `contracts/CHANGELOG.md`). Database migration `20261021000600_drop_accounts` drops `auth.*` and the `app` account tables.
- **Four backends, unchanged build order:** contract → Java → Go → Node → Rust. The frontend is built in parallel.

## Frozen showcase policy

Once a backend is built (Java now; Go, Node and Rust as they land) it is **pinned and only receives security fixes**, so the "Under the hood" race always compares the same code.

- **Pinned:** every dependency at an exact version with a committed lockfile (Gradle version catalog + `gradle.lockfile`s in strict mode; npm exact versions + `package-lock.json`; `Cargo.lock`; `go.mod` + `go.sum`), and every toolchain (Java 25 / Node 24 base images by digest, Gradle distribution by checksum, `rust-toolchain.toml`, the `go` directive).
- **Security fixes:** Renovate (`renovate.json`) disables routine updates for `api/**` and opens vulnerability-only PRs (GitHub advisories / OSV), grouped per backend, plus base-image digest bumps for CVE patches. They auto-merge only when that backend's CI is green: its own tests **and** the conformance suite against its image (Renovate waits for every status check; branch protection on `main` should also require them, e.g. java.yml's "Build and test" and "Conformance"). `web/`, `pipeline/` and the rest keep Renovate's normal update policy.
- **Unfreezing** for a deliberate upgrade: change the pins, regenerate the lockfile, re-measure startup/RSS, open a PR labelled `unfreeze`; the same tests and conformance gate it. Details per backend in `api/<lang>/README.md` (or `docs/`).

## Noted for later

- Earth Engine is optional: the spike found NCAR ERA5 on AWS about 21× cheaper per storm window than ARCO-ERA5.
