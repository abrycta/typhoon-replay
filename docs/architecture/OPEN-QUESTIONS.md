# Open questions: system and contract architecture

As of 2026-10-21. Each item says who decides or how to verify it. See [SYSTEM-ARCHITECTURE-RESEARCH.md](SYSTEM-ARCHITECTURE-RESEARCH.md) and [CONTRACT-GUIDE.md](../../contracts/docs/CONTRACT-GUIDE.md).

## A. Decisions for the user

1. **Approve the contract draft** (`contracts/docs/CONTRACT-GUIDE.md`): the endpoint outline, the omit-never-null rule, path-based `/api/{impl}/v1` routing, and cookie sessions.
2. **Buy a domain?** About US$10–15/year, and it needs a payment method.
   - It fixes alert-email deliverability (Resend with a verified domain) and gives professional URLs.
   - Without it: Brevo single sender (likely spam-foldered) or Gmail SMTP with an app password from the GitHub Actions mailer.
   - The same-origin proxy stays either way.
3. **Ingestion owner.** Recommended: one shared Python job in GitHub Actions. Alternative: cron calls `POST /v1/_jobs/*` on a rotating backend (more showcase, costs about 50–100 Render hours/month).
4. **Option C:** let the Node/TS backend run on Cloudflare Workers + Hyperdrive (always warm, frees Render hours, but a different runtime and SSE model)? Ask the Node agent.
5. **Cross-impl edge-cache fallback** (serve a cold backend's request from another impl's cached response, honestly labelled): on or off for the demo?
6. **`just` vs Make** as the single entry point.
7. **Frames hosting:** Pages vs a Hugging Face dataset (SPIKE.md: about 5.7 GB WebP for all storms; Pages' total-size limit is unverified).
8. **Alerts scope for v1:** email only, and which trigger (forecast track within N km of a saved place, or observed wind ≥ X kt)?

## B. To verify by hand or with a quick experiment

**Render**
1. Does an open SSE stream count as "inbound traffic" for the 15-minute spin-down?
2. Is there a hard request/stream timeout on free web services?
3. Do free web services deploy prebuilt images from GHCR, and do those builds count against the 500 build minutes?
4. The free RAM/CPU (512 MB / 0.1 CPU). The 5 GB outbound bandwidth is confirmed (new plans 2026-04-23, legacy auto-migration 2026-08-01). Still unverified: whether the Render API exposes bandwidth usage for the 70% guardrail, and whether bandwidth is counted at the HTTP or TLS/TCP level (this affects the SSE heartbeat cost).
5. Whether multiple free services in one workspace is within the terms (no stated limit found).

**Neon**
6. Do idle (non-LISTEN) pooled connections block scale-to-zero? The docs don't define "inactivity"; check `compute_tools/src/monitor.rs` or test it by watching suspend with backends idle-connected.
7. The actual `max_connections` at 0.25 CU (104 vs 112): run `SHOW max_connections`.
8. The PostGIS version Neon offers on PG 17/18, so the local `postgis/postgis` image tag matches.
9. Do table renames during a pipeline swap re-plan prepared statements correctly through the transaction-mode pooler (protocol-level prepared statements)? Test with all four drivers (JDBC/pgjdbc, node-postgres or postgres.js, sqlx/tokio-postgres, pgx).

**Cloudflare**
10. With `_routes.json` limited to `/api/*`, are static-asset requests truly free of the 100k/day Workers quota? The docs only say excluded routes incur no Functions invocation charge.
11. SSE passthrough in a Pages Function: confirm no buffering, and that a 30-minute stream doesn't trip any limit. A 20 s heartbeat is planned.
12. Pages Functions project layout: `functions/` sits at the Pages project root (this repo's root, since `wrangler.jsonc` lives there). Agree ownership with the web agent; maybe `infra/edge` with a build step.

**OAuth**
13. Google OAuth consent screen for a `*.pages.dev` origin: can a non-sensitive-scope (openid/email/profile) app go to production without domain verification? `pages.dev` is a public suffix, but the user doesn't "own" it in Search Console.
14. GitHub per-URI wildcard toggle: confirm the UI when the app is created; we want exact match.
15. The mock IdP for CI (e.g. navikt `mock-oauth2-server`): can it imitate GitHub's non-OIDC endpoints (`/login/oauth/access_token`, `api.github.com/user`)? If not, add a tiny stub to `contracts/conformance/`.

**Tooling**
16. oasdiff: depth of 3.1 support for the portable subset, and of 3.2 (`itemSchema`).
17. Spectral 3.2 status (none announced). Redocly's "basic" 3.2 support: does its lint understand `itemSchema`?
18. Server generators on the 3.1 portable subset (each language agent confirms): openapi-generator `spring` (3.1 "beta"), oapi-codegen v2.8 ("initial" 3.1) or ogen, the Rust options (openapi-generator `rust-axum` / oas3-gen / code-first + oasdiff gate).
19. Schemathesis SSE validation (4.11+): does it work with the 3.1 `x-sse-events` approach, or only with 3.2 `itemSchema`? If only 3.2, consider publishing a 3.2 bundle just for Schemathesis.
20. Hurl SSE support (none found). It only matters if Hurl is picked over Vitest.
21. Microcks SSE mocking: none found. Only relevant if Prism + MSW proves insufficient.

**Email**
22. Brevo free: single-sender verification rules, API access on Free, the daily cap (300), and the branding footer.
23. Can GitHub-hosted runners reach `smtp.gmail.com:587`, and does the Gmail ToS allow this use?

**Data sizing**
24. Real row counts and sizes for `storm_place_hit` at a 500 km radius, which drives the Neon 1 GB fit. The pipeline agent should measure it on a sample season.

## C. Risks to watch

- **Render's 5 GB/month outbound bandwidth** is shared and silent. When it is exceeded, all four backends are down until the 1st of the month. Add a monthly bandwidth check (Render API) to the nightly job.
- **Cold starts of about 60 s,** and longer for the JVM. Mitigations: edge cache, static fallback index, the "waking up" UX.
- **Expand/contract migrations:** four independently deployed backends read the same schema, so a careless rename breaks the laggards. CI should run the conformance suite of *every* backend against each new migration.
- **Generator 3.1 gaps** may push one backend toward code-first. Allowed, but only behind the two-way oasdiff gate.
