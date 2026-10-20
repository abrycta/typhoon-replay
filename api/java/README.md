# Typhoon Replay API: Java backend

Stack A from [`docs/ARCHITECTURE-RESEARCH.md`](docs/ARCHITECTURE-RESEARCH.md) §12: Spring Boot 4.1.1, Java 25,
Spring MVC on virtual threads, Spring Modulith 2.1.1, `JdbcClient` with hand-written PostGIS SQL, Spring Security 7.1,
and controllers that implement interfaces generated from the contract. It implements contract `1.0.0`
([`contracts/docs/CONTRACT-GUIDE.md`](../../contracts/docs/CONTRACT-GUIDE.md)); see [`impl.json`](impl.json).

## Run

```sh
just java-run               # Docker image on :8081 with PostGIS, migrations, seed and the mock IdP
just conformance java       # Vitest scenarios + Schemathesis against it
just java-test              # unit, Modulith and Testcontainers tests (PostGIS 18)
just java-dev               # from source (Gradle), against the compose database
```

Configuration comes only from the environment, with the names every backend shares (CONTRACT-GUIDE §11):
`DATABASE_URL` (a `postgres://` URL, mapped onto JDBC with `prepareThreshold=0` for the Neon pooler), `TR_SITE_ORIGIN`
(default `https://typhoon.krtmtthw.dev`), `TR_TEST_HOOKS`, `TR_OAUTH_{GITHUB,GOOGLE}_{CLIENT_ID,CLIENT_SECRET,AUTH_URL,TOKEN_URL,USERINFO_URL}`,
`TR_LOG_LEVEL`, `PORT`. Java-only extras: `TR_ALLOWED_ORIGINS` (more origins for the CSRF check),
`TR_RATE_LIMIT_PER_MINUTE` (default 600, 0 disables), `TR_MAX_STREAMS` (default 200), `TR_COMMIT`.
Profiles `local` (`http://localhost:8788`) and `pages` (`https://typhoon-replay.pages.dev`) only change the defaults.

## Layout

| Module (`dev.krtmtthw.typhoon.*`) | What |
|---|---|
| `shared` (open) | Problem details, the §4 headers, ETags, cursors, `Link`, request-body validation against the contract's JSON Schema, lenient query parsing, 405/`Allow` from the contract's paths, Bucket4j limiter, 64 KB body cap, JSON logs, `DATABASE_URL` |
| `contract` (open) | Generated interfaces and models (`build/generated/openapi`, never committed) |
| `meta` | `/healthz`, `/readyz` (Actuator readiness group + schema version), `/v1/meta`, `/v1/openapi.json` (the bundle byte for byte) |
| `storms` | Catalogue list/search, detail, best track, places a storm passed |
| `exposure` | Place search/nearest/detail, storms that hit a place (precomputed bands) or a point (on the fly) |
| `live` | Snapshot and SSE stream (`SseEmitter`, snapshot or `Last-Event-ID` resume, 15 s heartbeat, one poller only while clients are connected), live-event test hook |
| `accounts` | `oauth2Login` with state in `auth.oauth_state`, sessions in `auth.session` (custom store, SHA-256 of a 32-byte token, `__Host-tr_session`), header CSRF, `/v1/me`, saved places, session test hook |
| `alerts` | Alert preferences and one-click unsubscribe |

`ModularityTests` verifies the boundaries and writes PlantUML/canvas docs to `build/spring-modulith-docs`.

### Decisions worth knowing

- **Codegen view.** `build.gradle.kts` marks three operations `x-internal` before generation: `streamLiveEvents`
  (an `SseEmitter` cannot be expressed as the generated `ResponseEntity<String>`) and `startLogin`/`completeLogin`
  (served by Spring Security's filters). Everything else is a generated interface method.
- **CSRF.** The contract's rule (`Origin` + `X-Requested-With: typhoon-replay`) replaces `csrf.spa()`, so the four
  backends accept the same requests; only the contract's unsafe operations are checked.
- **Body validation.** Request bodies are validated against the contract's own JSON Schema (networknt, 2020-12)
  before Jackson binds them, because Bean Validation cannot see an explicit `null` or duplicates in a `uniqueItems`
  array. Responses in tests are validated the same way (`ContractMatcher`).
- **Cross-backend OAuth.** `auth.oauth_state` has no `redirect_uri` column, so the token request rebuilds it from
  `created_by_impl` (`TR_SITE_ORIGIN/api/{impl}/v1/auth/{provider}/callback`).
- **Point hits** run in a read-only transaction with `SET LOCAL jit = off`: PostgreSQL otherwise JIT-compiles the
  plan, about 1 s of LLVM time for a 60 ms query.

## Conformance (2026-10-21, PostGIS 18-3.6, against the Docker image)

- Vitest scenarios: **99/99** (incl. `SLOW=1` heartbeat, a no-hooks instance and a second instance as `OTHER_BACKENDS`).
- Schemathesis, full `backend.toml`: 1,270 cases, 8 failures, all contract-side:
  6 × positive-data-acceptance (the shared `Cursor` example is a `season-desc` cursor and is rejected as
  `invalid-cursor` elsewhere; `season` + `from` examples combine into a documented 400; business-rule 422s on
  `POST /me/places` and `PUT /me/alerts`), and the OAuth callback documents no 400 (over-long `state` gets the
  contract's 302 to `/signin?error=invalid-state`).
- Schemathesis gating run (`--exclude-checks positive_data_acceptance --exclude-operation-id completeLogin`):
  **2,150/2,150 pass**.

## Measurements (MacBook Air M-series, OrbStack, `--memory=512m`, arm64 image)

| | JVM | JVM + AOT cache |
|---|---|---|
| App start, 1 CPU | 2.9–3.4 s | 1.3–1.7 s |
| `/healthz` after `docker run`, 1 CPU | 3.4–4.0 s | 1.8–2.2 s |
| App start, 0.25 CPU | 43 s | 23 s |

- RSS after warm-up (≈5,000 requests): **≈300 MB** (VmHWM 312 MB) with SerialGC, `MaxRAMPercentage=60`, compact object headers.
- Latency on the seed (warm, gzip, 1 CPU; sequential p50 / p95 · 8 concurrent p95):
  storms list 1.7 / 2.8 · 61 ms; place hits 1.7 / 2.3 · 31 ms; point hits (on the fly, 500 km) 5.6 / 6.3 · 21 ms.
  The concurrent p95 is CPU-quota throttling of the 1-CPU container.
- Image: 670 MB on disk (171 MB compressed), of which the AOT cache is 82 MB.

## Deploy (Render + Neon)

1. Neon: use the **pooled** connection string as `DATABASE_URL`; migrations run from CI over the direct endpoint
   (backends never run DDL). `/readyz` stays 503 until the schema is at least `20261021000500`.
2. Render: Docker web service, Singapore, free plan; Dockerfile `api/java/Dockerfile`, build context the repository
   root; health check path `/healthz`. Env: `DATABASE_URL`, `TR_SITE_ORIGIN=https://typhoon.krtmtthw.dev`, the
   `TR_OAUTH_*_CLIENT_ID/SECRET` (provider URLs default to the real Google/GitHub endpoints), `TR_COMMIT`
   (or Render's `RENDER_GIT_COMMIT`). `PORT` is set by Render.
3. OAuth apps: register `https://typhoon.krtmtthw.dev/api/java/v1/auth/{github,google}/callback`.
