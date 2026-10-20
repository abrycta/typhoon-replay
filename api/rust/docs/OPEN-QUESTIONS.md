# Rust backend: open questions

Collected 2026-10-21 while researching `ARCHITECTURE-RESEARCH.md`. Each item says who owns it and what the Rust side assumes until it's answered.

## For the system architect / `contracts/`

1. **Sessions vs signed tokens.** Rust prefers **server-side sessions in a shared table**: an opaque 256-bit token in the cookie, with its SHA-256 stored. Needed in the contract:
   - cookie name and attributes (`__Host-tr_session`, Lax, HttpOnly, Secure);
   - table columns (`id_hash bytea PK, user_id, created_at, expires_at, last_seen_at, user_agent?`);
   - sliding-expiry rule and `last_seen_at` write throttle;
   - token encoding (base64url, 43 chars).
   Assumption: any backend can read a session another backend created.
2. **OAuth callback ownership.** Do Google and GitHub need four registered redirect URIs (`/api/<lang>/auth/{provider}/callback`)? Or does the edge route a single `/api/auth/*` to one backend? Where does pre-login state live: an encrypted cookie (each backend needs the same key format) or an `oauth_flow` table? Rust assumes per-backend callbacks plus a per-backend encrypted cookie.
3. **Migration runner and file naming.** Which tool applies `contracts/migrations` (dbmate, Flyway, Atlas, plain psql)? If files follow `<version>_<name>.sql`, Rust tests can use `#[sqlx::test(migrations = …)]` directly. Otherwise Rust needs a small helper to apply them.
4. **Who ingests the live feeds?** If all four backends ingest, the work is duplicated. The Rust proposal is an idempotent `POST /internal/ingest` with `pg_try_advisory_xact_lock`, triggered by one external cron (Cloudflare Cron Trigger or GitHub Actions). Which backend(s) it calls, and whether a cron call that wakes all four Render services fits the hour budget, is open.
5. **Live update propagation across backends.** The Rust proposal polls a one-row `live_version` table every 60 s, and only while SSE clients are connected. `LISTEN/NOTIFY` is unusable through the Neon pooler and is lost on suspend. Does the contract define SSE event names, `id` semantics (`Last-Event-ID` = version?), and a snapshot vs delta payload?
6. **Rate-limit headers.** Which header set goes in the contract: IETF `RateLimit` + `RateLimit-Policy`, or `X-RateLimit-*`? What quotas apply per class (anonymous, signed-in, auth endpoints)? How does the edge prove `CF-Connecting-IP` is trustworthy (a shared secret header)?
7. **CSRF rule.** Is it an Origin / `Sec-Fetch-Site` check on unsafe methods, a required custom header, or both? It must be testable by the conformance suite.
8. **ETag semantics.** Strong or weak? Derived from a dataset version, from a content hash, or both? Is `Cache-Control` per endpoint class defined in the contract?
9. **Problem-type registry.** What are the `type` URIs and the extension members (e.g. `traceId`, `errors[]` for validation)?
10. **Neon storage.** Free is **1 GB/project**. 580k storm-hours fits. The per-place exposure tables ("hundreds of millions of rows" in `big-data-ideas.md`) don't. Which subset lives in Postgres and which stays in Parquet/DuckDB-WASM?
11. **One Neon project for four backends.** That's **100 CU-h/month**, about 400 h at 0.25 CU, shared by all four backends' traffic and the ingest cron. Is that enough, or does each backend get its own project (the shared schema is then duplicated)?

## Hosting (verify by hand)

12. **Render instance-hour budget.** 750 h/workspace/month (Render free docs) across four backends works only if they sleep most of the time. Does a long-lived SSE connection count as "inbound traffic" that keeps a service awake (and burns hours)? Should SSE have a maximum stream lifetime (e.g. 10 min, after which the client reconnects)?
13. **Render bandwidth.** The Hobby workspace includes **5 GB/month** since 2026-08-01, and without a card, services spin down until next month when it runs out. Is the Cloudflare edge cache expected to absorb most reads? Do four backends in one Render workspace share the 5 GB? (They do if they're in one workspace.)
14. **Render deploy from GHCR on the free plan.** The docs show an "Existing Image" option. Confirm that free instances can deploy a public GHCR image via a deploy hook with no card, so release builds never use Render's 500 build-min/month.
15. **Email provider.** Resend free: 3,000/month and 100/day; SMTPS on 2465 avoids Render's blocked 465/587. Can you sign up with no card (the pricing page doesn't say)? Do you need a verified sending domain (needs DNS)? Fallback: Brevo (300/day, no card), but its non-blocked SMTP port is unverified, so you might use its HTTP API instead.
16. **OTLP backend.** Which free, no-card trace backend (Grafana Cloud free, Honeycomb free, or none)? Assumption: OTel is off by default, with JSON logs to Render's log stream.

## Rust-specific spikes (half a day each)

17. **typify on the real contract.** Does typify 0.8 handle the contract's 3.1 constructs (`type: [x, "null"]`, `oneOf` with `discriminator`, `$ref` siblings, `examples`)? If not, fall back to openapi-generator `rust-axum` (Stack B) or try `oas3-gen`.
18. **SQLx 0.9 + PostGIS macros.** Confirm `query_as!` infers nullability correctly for `ST_AsGeoJSON(...)::json` and `ST_Distance(...)::float8` under 0.9's changed Postgres nullability inference. Do we need `as "col!"` overrides?
19. **Search performance on Neon 0.25 CU.** Measure `ST_DWithin` on geography with GiST over about 580k storm-hours (radius 50–300 km), cold cache vs warm. Is a precomputed per-place exposure table always used for named places, and live `ST_DWithin` only for arbitrary points?
20. **Footprint numbers.** Measure image size, idle RSS, p50/p95 latency at 0.1 CPU, and wake-to-first-byte on Render, so the README quotes measured numbers instead of the estimates in §9.
21. **Crate skew to re-check before implementation:**
    - `oauth2` 5.0 (reqwest 0.12 feature) vs reqwest 0.13;
    - `testcontainers-modules` 0.15 (testcontainers 0.27);
    - `geozero` (sqlx 0.8), which we avoid;
    - `tower-http` 0.6 vs 0.7 alongside axum 0.8.9.
    Also check whether axum 0.9 has shipped.
