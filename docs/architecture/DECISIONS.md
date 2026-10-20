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

## Noted for later

- Earth Engine is optional: the spike found NCAR ERA5 on AWS about 21× cheaper per storm window than ARCO-ERA5.
