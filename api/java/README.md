# Typhoon Replay API: Java backend

Stack A from [`docs/ARCHITECTURE-RESEARCH.md`](docs/ARCHITECTURE-RESEARCH.md) §12: Spring Boot 4.1.1, Java 25,
Spring MVC on virtual threads, Spring Modulith 2.1.1, `JdbcClient` with hand-written PostGIS SQL, and controllers that
implement interfaces generated from the contract. It implements contract `2.0.0`
([`contracts/docs/CONTRACT-GUIDE.md`](../../contracts/docs/CONTRACT-GUIDE.md)); see [`impl.json`](impl.json).
Since 2.0.0 the API has no accounts: every operation is a public, anonymous read, so there is no Spring Security, no
OAuth2 client, no session store and no CSRF filter (CONTRACT-GUIDE §14).

## Run

```sh
just java-run               # Docker image on :8081 with PostGIS, migrations and seed
just conformance java       # Vitest scenarios + Schemathesis against it
just java-test              # unit, Modulith and Testcontainers tests (PostGIS 18)
just java-dev               # from source (Gradle), against the compose database
```

Configuration comes only from the environment, with the names every backend shares (CONTRACT-GUIDE §11):
`DATABASE_URL` (a `postgres://` URL, mapped onto JDBC with `prepareThreshold=0` for the Neon pooler), `TR_SITE_ORIGIN`
(default `https://typhoon.krtmtthw.dev`; the origin of absolute `Link` headers), `TR_TEST_HOOKS`, `TR_LOG_LEVEL`, `PORT`.
Java-only extras: `TR_RATE_LIMIT_PER_MINUTE` (default 600, 0 disables), `TR_MAX_STREAMS` (default 200), `TR_COMMIT`.
Profiles `local` (`http://localhost:8788`) and `pages` (`https://typhoon-replay.pages.dev`) only change the defaults.

## Layout

| Module (`dev.krtmtthw.typhoon.*`) | What |
|---|---|
| `shared` (open) | Problem details, the §4 headers (plus `nosniff`, `X-Frame-Options: DENY`), ETags, cursors, `Link`, request-body validation against the contract's JSON Schema, lenient query parsing, 405/`Allow` from the contract's paths, Bucket4j limiter, 64 KB body cap, JSON logs, `DATABASE_URL` |
| `contract` (open) | Generated interfaces and models (`build/generated/openapi`, never committed) |
| `meta` | `/healthz`, `/readyz` (Actuator readiness group + schema version), `/v1/meta`, `/v1/openapi.json` (the bundle byte for byte) |
| `storms` | Catalogue list/search, detail, best track, places a storm passed |
| `exposure` | Place search/nearest/detail, storms that hit a place (precomputed bands) or a point (on the fly) |
| `live` | Snapshot and SSE stream (`SseEmitter`, snapshot or `Last-Event-ID` resume, 15 s heartbeat, one poller only while clients are connected), live-event test hook |
`ModularityTests` verifies the boundaries, pins the module set (no `accounts`/`alerts` any more), forbids
`org.springframework.security`, `Cookie` and `HttpSession` with ArchUnit, and writes PlantUML/canvas docs to
`build/spring-modulith-docs`.

### Decisions worth knowing

- **Codegen view.** `build.gradle.kts` marks `streamLiveEvents` `x-internal` before generation (an `SseEmitter`
  cannot be expressed as the generated `ResponseEntity<String>`). Everything else is a generated interface method.
- **No accounts (contract 2.0.0).** The removed `/v1/auth/…`, `/v1/me…` and `/v1/alerts/…` routes are unknown routes
  (404 problem+json); unsafe methods on public paths get 405 with `Allow` from the contract's paths, with no CSRF
  check. Cookies are ignored and never set, so every read is the same for every caller and publicly cacheable.
- **Body validation.** The test-hook body is validated against the contract's own JSON Schema (networknt, 2020-12)
  before Jackson binds it, because Bean Validation cannot see an explicit `null`. Responses in tests are validated
  the same way (`ContractMatcher`).
- **Point hits** run in a read-only transaction with `SET LOCAL jit = off`: PostgreSQL otherwise JIT-compiles the
  plan, about 1 s of LLVM time for a 60 ms query.

## Conformance (contract 2.0.0, 2026-10-21, PostGIS 18-3.6, against the Docker image)

- Vitest scenarios: **85/85** (incl. `SLOW=1` heartbeat and a no-hooks instance).
- Schemathesis, full `backend.toml`: 4 failures, all contract-side positive-data-acceptance: the shared `Cursor`
  example is a `season-desc` cursor, rejected as `invalid-cursor` by the other sorts, and the `season` + `from`
  examples combine into a documented 400.
- Schemathesis gating run (`--exclude-checks positive_data_acceptance --request-retries 3`): **1,441/1,441 pass**.

(Contract 1.0.0 had 99 scenarios and 2,150 gating cases; the difference is the removed account operations.)

## Measurements (MacBook Air M-series, OrbStack, `--cpus=1 --memory=512m`, arm64 image, JVM + AOT cache)

| | 0.1.0 (contract 1.0.0, Spring Security + OAuth2 client) | 0.2.0 (contract 2.0.0, no security stack) |
|---|---|---|
| App start (`Started … in`), 6 / 3 runs | 1.37–1.70 s | 1.19–1.40 s |
| `/healthz` after `docker run` | 2.0–3.0 s | 1.9–2.2 s |
| RSS idle after start | 248 MB | 216–224 MB |
| RSS after 5,005 catalogue reads (VmHWM) | 282 MB (282 MB) | 255 MB (264 MB) |
| Image on disk | 670 MB | 646 MB |

Both builds measured the same day on the same seeded PostGIS 18-3.6, same JVM flags (SerialGC, `MaxRAMPercentage=60`,
compact object headers). Earlier 0.1.0 numbers: app start 0.25 CPU 23 s with the AOT cache (43 s without).

- Latency on the seed (0.1.0, warm, gzip, 1 CPU; sequential p50 / p95 · 8 concurrent p95):
  storms list 1.7 / 2.8 · 61 ms; place hits 1.7 / 2.3 · 31 ms; point hits (on the fly, 500 km) 5.6 / 6.3 · 21 ms.
  The concurrent p95 is CPU-quota throttling of the 1-CPU container.

## Deploy (Render + Neon)

1. Neon: use the **pooled** connection string as `DATABASE_URL`; migrations run from CI over the direct endpoint
   (backends never run DDL). `/readyz` stays 503 until the schema is at least `20261021000500`. 0.2.0 also runs on
   `20261021000600` (accounts dropped): deploy it first, then apply that migration.
2. Render: Docker web service, Singapore, free plan; Dockerfile `api/java/Dockerfile`, build context the repository
   root; health check path `/healthz`. Env: `DATABASE_URL`, `TR_SITE_ORIGIN=https://typhoon.krtmtthw.dev`, `TR_COMMIT`
   (or Render's `RENDER_GIT_COMMIT`). `PORT` is set by Render. Remove the old `TR_OAUTH_*` and `TR_ALLOWED_ORIGINS`
   variables, and the OAuth apps' Java callback URLs, after the 2.0.0 deploy.
