# Java backend: open questions

As of 2026-10-21. "Architect" means the owner of `contracts/`. "Spike" means a measurement to make before implementation.

## For the system architect (cross-backend, affects all four)

1. **Render free hours.** 750 instance hours per **workspace** per month cannot keep four backends warm (one always-on service uses about 744 h). Options: one workspace per backend (check whether Render's terms allow several free workspaces per person), accept cold starts on three backends, or rotate a single "warm" backend. Do keep-alive pings from the Worker breach Render's terms?
2. **SMTP is blocked** on Render free (ports 25/465/587). Should the contract assume an HTTPS email API (Brevo or Resend) for all backends? Which provider, and who owns the sending domain and DNS (SPF/DKIM)?
3. **Session table schema.** I recommend opaque server-side sessions in a contract-owned table, keyed by the SHA-256 of the cookie value, and **not** Spring Session's schema (Java-serialized `BYTEA`). Please confirm the cookie name, `Path`, `SameSite`, expiry and sliding policy, and the table columns.
4. **CSRF scheme names.** Please adopt `XSRF-TOKEN` cookie plus `X-XSRF-TOKEN` header (Spring Security's `csrf.spa()` default) for all backends.
5. **OAuth2 callback URLs.** Is there one Google/GitHub OAuth app shared by all backends (`/api/<lang>/login/oauth2/code/{provider}`) or one per backend? GitHub OAuth Apps allow one callback URL (sub-paths allowed; re-check the GitHub docs).
6. **Ingestion ownership.** Who triggers ingestion: a Worker cron rotating across backends, or a single designated backend? I propose a language-neutral `job_locks` table (ShedLock-compatible columns: `name, lock_until, locked_at, locked_by`) and an HMAC-signed `POST /api/<lang>/internal/ingest`. Is the internal endpoint part of the public OpenAPI file or a separate internal spec?
7. **Live revision / SSE fan-out.** LISTEN/NOTIFY is unavailable through Neon's pooler. Is the proposed `live_revision` polling (only while SSE clients are connected) acceptable? What event names, `id` semantics and heartbeat interval does the contract fix?
8. **Neon budget.** 100 CU-hours and 1 GB per project are shared by four backends plus ingestion. Per big-data-ideas.md, per-place hourly exposure is "hundreds of millions of rows". Will Neon hold only aggregated exposure (per storm × place) with the hourly detail kept in Parquet? 1 GB is the binding limit.
9. **OpenAPI 3.1 subset.** openapi-generator still labels 3.1 as beta and handles `oneOf`/`anyOf`/`type: [x, "null"]` poorly. Can the contract avoid null unions and untagged unions in shared models?
10. **Rate-limit headers.** IETF `RateLimit`/`RateLimit-Policy` or `X-RateLimit-*`? Should global limits live in the Worker, with backends doing only per-instance limits?
11. **ProblemDetail `type` URIs** and extension members (for example `errors[]` for validation, `traceId`).
12. **Migrations runner.** Does CI apply `contracts/db/migrations` over Neon's **direct** endpoint (Flyway takes advisory locks)? Which tool owns the history table (Flyway, sqitch, dbmate)? The Java tests will run the same files through Flyway, so the naming must be Flyway-compatible (`V001__name.sql`).
13. **PostGIS version / image tag** pinned for Compose and Testcontainers (for example `postgis/postgis:17-3.5`), and the PostGIS version Neon provides.

## Spike measurements (Java-specific)

14. **Real cold start on Render free (0.1 CPU)** for: plain JVM, JVM + AOT cache, and native. Estimates are 20–45 s, 10–25 s and 1–3 s of app time on top of Render's spin-up of about one minute. They are extrapolated from M2 Pro numbers and have not been measured.
15. **Steady RSS under light load** (target below 420 MB with `MaxRAMPercentage=60`, SerialGC, compact object headers). Do Spring Security, the OAuth2 client and Modulith push the JVM over 512 MB during startup or a burst?
16. **Native build time and peak RAM** on the 4 vCPU / 16 GB GitHub runner (estimated as several minutes and 6–10 GB). Which reflection hints do the generated models and the custom session store need?
17. **AOT cache training run without Neon.** Confirm the `spring.context.exit=onRefresh` training run works with DataSource initialization disabled, and that the cache still helps the real start (classpath and JDK must match).
18. **Does an open SSE connection keep Render free awake** (count as inbound traffic), and does Render's proxy drop SSE streams that have a 25 s heartbeat?
19. **Neon cold resume plus Hikari:** latency of the first query after scale-to-zero, and whether `minimumIdle=0` with `keepaliveTime=0` really lets Neon suspend while the JVM stays up.

## Unverified facts used in the research

20. Spring Boot 4.2 GA date (expected around Nov 2026; 4.2.0-M2 exists).
21. The October 2026 Java CPU release (25.0.5?) was due 2026-10-20; not checked.
22. Resend: whether a card is needed at sign-up. Alternative SMTP ports (Resend 2587/2465, Brevo 2525) are not confirmed on the providers' current pages.
23. That ShedLock's JDBC provider can map onto custom column names matching a language-neutral `job_locks` table (`JdbcTemplateLockProvider.Configuration` supports a custom table and column names in recent versions; verify for 7.10).
24. Bucket4j 8.21 compatibility with Spring Boot 4.1 / Jackson 3 (core has no Spring dependency, so it is expected to be fine).
25. Spring Modulith 2.1.1 ↔ Boot 4.1 pairing (taken from the release cadence; check the version-mapping page).
26. A free OTLP backend (for example Grafana Cloud free) and its card requirement, if tracing is shown in the demo.
27. CRaC on Render: assumed unavailable (needs checkpoint capabilities); not tested.

## For the user (decisions)

28. Portfolio framing: do you want the README to openly compare against MyBatis (your daily tool) as "why `JdbcClient` here"? I recommend yes.
29. Package root / group id (for example `dev.<handle>.typhoon`) and the licence for the repository.
30. Should the Java backend be the "always-warm" one if only one backend can stay awake (question 1)? As the home implementation, it is the natural choice.
