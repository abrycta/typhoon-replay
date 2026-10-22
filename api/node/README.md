# Replay API: Node backend

The contract (`contracts/`, 2.0.2) in TypeScript, run as the Cloudflare Worker `replay-api-node` on the free plan.
Deployed at `https://replay-api-node.krtmtthw.workers.dev` (with `TR_EDGE_SECRET` set, `/v1/*` there answers only
requests carrying the edge's `X-Edge-Secret`; the probes stay open), and behind the site at `https://replay.krtmtthw.dev/api/node/`
(the edge proxy reaches it through the `API_NODE` service binding). See [`impl.json`](impl.json).

## Stack, and why it is not the researched one

[`docs/ARCHITECTURE-RESEARCH.md`](docs/ARCHITECTURE-RESEARCH.md) picked Fastify 5 on Render. Hosting moved to Workers
(DECISIONS.md, "Update 2026-10-22"), and Fastify cannot boot there: Ajv and fast-json-stringify compile validators and
serialisers with `new Function`, and Workers refuse it (`EvalError: Code generation from strings disallowed`). So this
backend keeps the research's contract-first idea and moves the code generation to build time.

| | |
|---|---|
| Runtime | Cloudflare Workers (workerd), no `nodejs_compat`; Node 24 for the tooling |
| Router | **Hono 4.13**: Web-standard `Request`/`Response`, built for Workers, no runtime code generation |
| Contract-first | `scripts/generate.mjs` reads `contracts/dist/openapi.json` and writes `src/generated/`: **openapi-typescript** types for every parameter and schema; the **operation table** (method, path, parameters) that the routes are registered from; **Ajv standalone validators**, compiled to plain JavaScript at build time, one per operation; and the bundle itself, served byte for byte. A handler map `satisfies Record<OperationId, Handler>`, so a missing operation fails the typecheck |
| SQL | **Kysely 0.29 as a compiler only** (`DummyDriver`): typed table names and composable, parameterised filters; PostGIS expressions as `sql` fragments. Compiled statements go to Neon over HTTP |
| Database | Neon serverless SQL over HTTP (`src/platform/neon.ts`): each request is one `POST https://{host}/sql` batch, read-only, `SET LOCAL statement_timeout = 5000` first and the dataset-version query in the same batch, so a catalogue read is one round trip |
| Rate limit | the Workers rate limiting binding `RATE_LIMITER` (namespace 1002, 600 per 60 s, per client IP) |

**Trade-offs.** No Fastify plugins (SSE, ETag, rate limit, compression): each is a few lines on the Fetch API instead.
Validation messages are Ajv's, but the error pointers (`#/query/limit`) follow the contract. A Worker has no
long-lived state, so the dataset version is read with every query rather than cached, and a 304 still costs the
database round trip. The live stream ends after 90 s (below).

## Layout

```
src/index.ts          Worker entry
src/app.ts            Hono app: routes from the operation table, the shared pipeline (headers, limit, problems, logs)
src/platform/         contract HTTP rules: §4 headers and Cache-Control (http.ts), problems, parameter binding and
                      validation (params.ts), ETags, cursors, query parsing, rate limit, the Neon HTTP client
src/catalog/          storms, places and hits (read models), Kysely schema and shared SQL (sql.ts)
src/live/             snapshot, SSE stream, test hook
src/meta/             /healthz, /readyz, /v1/meta, /v1/openapi.json
scripts/generate.mjs  contract → src/generated/ (gitignored; run by build, dev and CI)
scripts/serve-local.sh  wrangler dev against a local database through the Neon HTTP proxy
```

How it differs from the Java reference:
- **Live stream.** A Worker invocation may make 50 subrequests on the free plan, and each poll is one. A stream polls
  every 2 s (inside the 5 s delivery rule), sends a heartbeat every 15 s, and ends after 90 s; `EventSource` reconnects
  with `Last-Event-ID` and resumes without a snapshot (CONTRACT-GUIDE §7). Each stream is its own invocation, so there
  is no shared stream cap.
- **Compression.** Bodies over 1 KB get `Content-Encoding: gzip` and the Workers runtime encodes them.
- **Bandwidth guards** are the contract's: catalogue reads are `public, max-age=300, stale-while-revalidate=86400` with
  dataset ETags (the edge proxy caches them; the contract fixes the header, so there is no separate `s-maxage`), page
  sizes are capped by the validators (100, search 50), tracks are best-track only, and a response over the 64 KB
  budget is logged as a warning.

## Build and run locally

Needs Node 24 and Docker.

```sh
npm --prefix ../../contracts ci && npm --prefix ../../contracts run bundle
npm ci && npm run build                      # generate, typecheck, bundle (build/index.js)
just db-up                                   # PostGIS + migrations + seed (repo root)
docker run -d --name neon-proxy -p 4444:4444 \
  -e PG_CONNECTION_STRING=postgres://tr:tr@host.docker.internal:5432/typhoon \
  ghcr.io/timowilhelm/local-neon-http-proxy@sha256:cd2ae14edf2feafbc3330492de5c80506f77274c3bd013154cdef697bdeb768a
scripts/serve-local.sh 8087 1                # hooks on; a second instance: scripts/serve-local.sh 8088 0
BASE_URL=http://localhost:8087 IMPL=node NO_HOOKS_BASE_URL=http://localhost:8088 npm --prefix ../../contracts run conformance
```

## Deploy

CI deploys on every push to `main` after conformance passes (`.github/workflows/node.yml`: `wrangler deploy --var
TR_COMMIT:<sha>`, then the deployed-instance scenarios). The Worker's secrets are set once, outside the repo:

```sh
security find-generic-password -s neon-database-url -w | tr -d '\n' | npx wrangler secret put DATABASE_URL
security find-generic-password -s typhoon-edge-secret -w | tr -d '\n' | npx wrangler secret put TR_EDGE_SECRET
```

Free-plan budget: 100k requests/day shared with Pages Functions and the other Workers, 10 ms CPU per invocation (check
`cpuTimeP50` in Workers analytics after a deploy), 50 subrequests per invocation.

## Frozen showcase

Pinned per `docs/architecture/DECISIONS.md` ("Frozen showcase policy"): exact versions in `package.json` with
`package-lock.json` (`.npmrc` `save-exact`, `engine-strict`), Node 24 from `.nvmrc`, the Workers runtime by
`compatibility_date` and the wrangler version. Renovate opens only security fixes for `api/**`.
