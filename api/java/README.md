# Replay API: Java backend

Stack A from [`docs/ARCHITECTURE-RESEARCH.md`](docs/ARCHITECTURE-RESEARCH.md) §12: Spring Boot 4.1.2, Java 25,
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
(default `https://replay.krtmtthw.dev`; the origin of absolute `Link` headers), `TR_TEST_HOOKS`, `TR_LOG_LEVEL`, `PORT`.
Java-only extras: `TR_RATE_LIMIT_PER_MINUTE` (default 600, 0 disables), `TR_MAX_STREAMS` (default 200), `TR_COMMIT`,
`TR_EDGE_SECRET` (shared with the edge proxy's `EDGE_SECRET`: only requests carrying it in `X-Edge-Secret` have their
`X-Forwarded-For` trusted, so the per-IP limiter keys on the visitor; anything else is keyed on the connecting address.
When it is set, `/v1/*` without it gets a small 403, so the public Render URL serves only the edge; `/healthz` and
`/readyz` stay open), `TR_MAX_STREAMS_PER_CLIENT` (default 10 live streams per client address, 429 above it; 0 disables).
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

Current figures come from `java.yml` on `main` and are shown, with a link to the run, in the conformance table on
[Under the hood](https://replay.krtmtthw.dev/under-the-hood). The figures below are from one local run on
2026-10-21, kept as a record; later contract changes added scenarios and generated cases.

- Vitest scenarios: **85/85** (incl. `SLOW=1` heartbeat and a no-hooks instance).
- Schemathesis, full `backend.toml`: 4 failures, all contract-side positive-data-acceptance: the shared `Cursor`
  example is a `season-desc` cursor, rejected as `invalid-cursor` by the other sorts, and the `season` + `from`
  examples combine into a documented 400. Contract 2.0.1 gives each operation a cursor example for its own sort;
  generated cursors and `season` + `from` from the coverage and fuzzing phases still can't be ruled out by a schema.
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

On Render free (0.1 CPU), until 2026-10-21 the AOT cache was never used: Render's build host has enough RAM that
`MaxRAMPercentage=60` gave the training run a heap over 32 GB, which turns compressed oops off, and the 512 MB
runtime rejected the cache ("The saved state of UseCompressedOops … is different", "Unable to map shared spaces").
App start was 55–78 s. The training run now uses `-XX:MaxRAM=512m`. Reproduced locally with the same jar (time to
context refresh at `MaxRAM=512m`): cache trained at 96 GB rejected, 4.9 s; no cache 4.8 s; cache trained at 512 MB
2.4 s.

- Latency on the seed (0.1.0, warm, gzip, 1 CPU; sequential p50 / p95 · 8 concurrent p95):
  storms list 1.7 / 2.8 · 61 ms; place hits 1.7 / 2.3 · 31 ms; point hits (on the fly, 500 km) 5.6 / 6.3 · 21 ms.
  The concurrent p95 is CPU-quota throttling of the 1-CPU container.

## Frozen showcase policy

Once built, this backend is frozen (docs/architecture/DECISIONS.md, "Frozen showcase policy"): it only changes for
security fixes, so the "Under the hood" race always compares the same code.

- **What is pinned.** Every Maven dependency and Gradle plugin at an exact version (`gradle/libs.versions.toml`, Boot
  BOM), resolved only from the committed lockfiles (`gradle.lockfile`, `buildscript-gradle.lockfile`,
  `settings-gradle.lockfile`, `LockMode.STRICT`); the Gradle distribution by SHA-256; the JDK 25 / JRE 25 and Node 24
  base images by digest in the `Dockerfile`; the CI actions by commit SHA.
- **How security fixes arrive.** Renovate (`renovate.json` at the repo root) opens no routine updates for `api/**`.
  It opens vulnerability PRs only (GitHub advisories / OSV), grouped as "java backend security", plus base-image
  digest bumps for CVE patches, and auto-merges them when `java.yml` is green: Gradle tests (Modulith, ArchUnit,
  Testcontainers) **and** the conformance suite against the built image. Nothing merges without conformance.
- **Unfreezing for a deliberate upgrade.** Edit `libs.versions.toml` (or the Boot version), run
  `./gradlew resolveAndLockAll --write-locks`, refresh the image digests, re-measure startup/RSS above, and open a PR
  labelled `unfreeze`; the same CI (tests + conformance) gates it.

## Deploy (Render + Neon)

1. Neon: use the **pooled** connection string as `DATABASE_URL`; migrations run from CI over the direct endpoint
   (backends never run DDL). `/readyz` stays 503 until the schema is at least `20261021000500`. 0.2.0 also runs on
   `20261021000600` (accounts dropped): deploy it first, then apply that migration.
2. Render: Docker web service, Singapore, free plan; Dockerfile `api/java/Dockerfile`, build context the repository
   root; health check path `/healthz`. Env: `DATABASE_URL`, `TR_SITE_ORIGIN=https://replay.krtmtthw.dev`, `TR_COMMIT`
   (or Render's `RENDER_GIT_COMMIT`). `PORT` is set by Render. Remove the old `TR_OAUTH_*` and `TR_ALLOWED_ORIGINS`
   variables, and the OAuth apps' Java callback URLs, after the 2.0.0 deploy.
3. Deploys: Render's auto-deploy is off. `java.yml` deploys a push to `main` through the Render API
   (`scripts/render-deploy.mjs`) only after the tests and conformance pass, then runs the live checks (`live.yml`).
