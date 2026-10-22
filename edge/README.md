# Edge proxy

The same-origin proxy from `docs/architecture/DECISIONS.md` (System A): a Cloudflare Pages Function that routes
`https://replay.krtmtthw.dev/api/{impl}/*` to that backend's Render service.

| File | Role |
|---|---|
| `functions/api/[[path]].ts` | The Pages Function (catch-all for `/api/*`). Thin: calls `handleProxy`. |
| `edge/src/proxy.ts` | Routing, rewrite, cold-start handling, SSE, static mode, body cap. |
| `edge/src/cache.ts` | Edge cache on `caches.default` (freshness, SWR, stale-if-error, 304s). |
| `edge/src/http.ts` | Header hygiene, request ids, RFC 9457 problems. |
| `edge/src/ratelimit.ts` | Per-IP token bucket (or a rate limiting binding, if one is ever bound). |
| `edge/src/env.ts` | Settings from the environment. |
| `web/public/_routes.json` | `include: ["/api/*"]`: static assets never invoke a Function. Vite copies it into `web/dist`. |

**Placement.** `wrangler pages deploy web/dist` and `wrangler pages dev web/dist` compile the `functions/`
directory of the directory they run in, which is the repo root (scripts and `deploy.yml` run wrangler there).
`_routes.json` must be in the build output, hence `web/public/`. `npm run preview` (`scripts/preview.sh`) serves
the build together with the Function.

## Routing

**Adding a backend** (one entry each, docs/architecture/DECISIONS.md "Hosting the Go, Node and Rust backends"): put
its origin in `BACKEND_ORIGINS` in `wrangler.jsonc`. A backend that runs as a Worker also gets a service binding,
`{"binding": "API_{IMPL}", "service": "replay-api-{impl}"}` under `services`; the proxy then sends requests for that
origin through the binding (`upstreamFetch` in `edge/src/proxy.ts`) instead of the network. Deploy the Worker
before adding its binding.


- `/api/{impl}/v1/...`, `/api/{impl}/healthz` and `/api/{impl}/readyz` go to `{origin}/v1/...`, `/healthz` and `/readyz`.
  The method, body, query string and the safe request headers are kept. Any other path is a 404, so the proxy
  can't be used to reach other hosts or paths.
- Origins come from `BACKEND_ORIGINS`, a JSON map such as `{"java":"https://typhoon-replay-java.onrender.com"}`.
  Only `http(s)` URLs for `java|node|rust|go` are used, and each is cut down to its origin.
  - An impl outside that list gets a 404 `unknown-backend`.
  - A known impl with no origin gets a 503 `backend-not-deployed`.
- Request headers are allow-listed:
  - forwarded: `Accept`, `Accept-Language`, `Authorization`, `Content-Type`, the `If-*` headers, `Last-Event-ID`,
    `Origin`, `Referer`, `User-Agent`, `X-Request-Id` and `X-Requested-With`;
  - the client's `Accept-Encoding` is not forwarded: the proxy always sends its own `Accept-Encoding: br, gzip`
    (see "Compression" below);
  - `Cookie` is forwarded with only the `__Host-tr_*` cookies, so `__cf_bm`, analytics and other cookies never
    reach a backend;
  - the proxy sets `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-For` (from `CF-Connecting-IP`) and
    `X-Forwarded-Prefix: /api/{impl}` (the contract uses this for `Link` headers and OAuth `redirect_uri`);
  - with the `EDGE_SECRET` Pages secret set, the proxy adds `X-Edge-Secret`. A backend with the same `TR_EDGE_SECRET`
    then trusts `X-Forwarded-For` for its own per-IP limit; without it, the backend keys on the connecting address,
    because on the proxy's subrequest Cloudflare (in front of Render) sets `CF-Connecting-IP` to the Worker, not the
    visitor, and anyone can send `X-Forwarded-For` straight to the Render URL. A client's own `X-Edge-Secret` is dropped.
- Response headers:
  - `Set-Cookie` passes through unchanged (same origin, so `__Host-` cookies work);
  - redirects are not followed, so OAuth 302s reach the browser;
  - hop-by-hop headers and origin-host headers (`Server`, `Alt-Svc`, `cf-ray`, …) are dropped;
  - every response gets `X-Edge-Cache: HIT|MISS|STALE|BYPASS`, `X-Edge-Route: {impl}`, `Server-Timing: edge;dur=…`
    and `X-Request-Id`. The backend's `X-Backend-Impl` passes through, and a stale answer adds `X-Edge-Stale`.
- Request bodies over 64 KB get a 413 `payload-too-large`, whether the size is declared or streamed.

Problems generated at the edge use the contract's shape and `type` base. Where a contract code fits, they reuse
it (`not-found`, `method-not-allowed`, `payload-too-large`, `rate-limited`). The proxy-only codes are
`unknown-backend`, `backend-not-deployed`, `backend-waking`, `backend-unavailable`, `backend-paused`, `static-mode`, `bad-gateway`
and `gateway-timeout`. They are kebab-case, like the contract's codes. Clients read them as a tolerant reader.

## Edge cache

A request is a cache candidate when all of these hold:
- it is a `GET` or `HEAD` under `/v1/`;
- it isn't the SSE stream, `/v1/me…`, `/v1/auth/…` or `/v1/alerts/…`;
- it carries no `__Host-tr_*` session cookie and no `Authorization` header.

All other requests are `BYPASS`: they are neither looked up nor stored.

A response is stored only when all of these hold:
- its status is 200, 203, 404 or 410;
- its `Cache-Control` has `public` and a positive `max-age` or `s-maxage`, and no `private`, `no-store` or `no-cache`;
- it has no `Set-Cookie`;
- its `Vary` lists only `Accept-Encoding` or `Accept`;
- it isn't an event stream.

Under the contract's table (CONTRACT-GUIDE §6), that covers catalogue reads, `/v1/meta`, `/v1/openapi.json` and
catalogue 404s. The live snapshot (`no-cache`), `/me`, auth, errors and health never qualify.

**Key.** The key is the full URL with its query parameters sorted, plus a hash of the normalised `Accept`
(lower case, no whitespace, absent read as `*/*`; the one request header a `Vary` may name) and `KEY_VERSION`
(`edge/src/cache.ts`, now `4`). `Accept-Language` is not part of the key: no backend varies on it, and keying on it
split the cache per browser language. Query parameters with
different values never share an entry. Bumping `KEY_VERSION` orphans every stored entry on the next deploy: that is
the purge.

**Compression.** Render bills the bytes it sends, so the proxy asks for them compressed:
- every upstream request carries `Accept-Encoding: br, gzip` (the Java backend gzips JSON over 1 KB, and Render's own
  Cloudflare front gzips the rest). Production Workers already negotiated gzip without it, but `wrangler pages dev`
  (workerd) sends none, so the header is explicit;
- a body that is passed through untouched keeps its encoding (Cloudflare re-encodes it for each client, identity
  included);
- an entry is stored **decoded** (its `Content-Encoding` and `Content-Length` are dropped when it is stored), so no
  cache implementation can serve gzip bytes twice or without their header. Cloudflare compresses cached answers for
  the client again.

**Dataset pin.** A catalogue body changes only with the dataset version: its ETag `W/"d{n}-{resourceKey}"` comes
from data, never from bytes (CONTRACT-GUIDE §6), which is why a revalidation may answer 304. Each time the origin
answers with such an ETag (a 200 or a revalidation's 304; `/v1/meta`'s `…-d{n}"` counts too), the proxy records `n`
as that backend's dataset version at this data centre (a small entry under `/api/{impl}/__edge/dataset`, which no
backend path can reach). A catalogue 200 past its `max-age` whose version matches a record younger than
`DATASET_PIN_S` (300 s, the contract's own `max-age`) is a `HIT`. So one origin answer every 5 minutes keeps every
cached storm list, search and storm page fresh, instead of one revalidation per URL. After a publish, the first
answer with `d{n+1}` unpins every older entry, which then follows the normal rules below; the bound on staleness
is unchanged. `/v1/meta`, 404/410s and health are never pinned.

**Dataset changes.** Catalogue ETags carry the dataset version (`W/"d{n}-…"`), so a revalidation after a publish gets
a full 200. Two cases need more:
- 404 and 410 are kept at most 60 s (`NEGATIVE_MAX_AGE_S`) and never served stale, so a storm that a new dataset
  adds shows up within a minute even while the backend sleeps.
- Before contract 2.0.1, `/v1/meta`'s ETag (`W/"c{contract}-{impl}-{implVersion}"`) ignored `datasetVersion`, so a
  conditional revalidation could get a 304 and keep the old body. 2.0.1 adds `-d{datasetVersion}`; the proxy still
  revalidates `/v1/meta` with a plain GET (a few hundred bytes) for backends that predate it.

| State | Condition (age since stored) | Behaviour |
|---|---|---|
| `HIT` | `< max-age`, or a catalogue entry under the dataset pin | Served from the edge; the origin isn't contacted. A matching `If-None-Match` gets a 304 at the edge. |
| `STALE` (`X-Edge-Stale: revalidating`) | `< max-age + stale-while-revalidate` | Served at once. A background conditional request (`If-None-Match: <cached ETag>`) refreshes the entry: a 304 costs almost no egress. A cold backend never blocks the visitor. |
| `MISS` or `STALE` (`X-Edge-Stale: if-error`) | `< max-age + stale-if-error` (the origin's value, or `STALE_IF_ERROR_S`, 7 days by default) | The origin gets `STALE_TIMEOUT_MS` (1.5 s). If it answers, the entry is refreshed (`MISS`). On an error, a 5xx or a timeout, the stale copy is served and the request finishes in the background (which also wakes the backend). |
| `MISS` | no entry | Fetched without the client's validators so that a full copy can be stored. A matching `If-None-Match` still gets a 304 from the edge. |

**Free-plan behaviour (verified against Cloudflare's docs, 2026-10).**
- The Cache API works in Pages Functions on `*.pages.dev` and on custom domains, and costs nothing extra.
- It is **per data centre**: entries are not replicated, and `cache.put` bypasses tiered cache. Visitors at the same
  PoP (Manila, Tokyo) share entries.
- It implements neither `stale-while-revalidate` nor `stale-if-error`, and `match()` would answer 304 by itself for
  conditional requests. That is why this proxy:
  - stores each entry with an edge TTL of `fresh + max(swr, sie)`;
  - records the store time and the origin's `Cache-Control` (restored on the way out, with `Age`);
  - looks entries up with a header-less key request.
- Entries can be evicted early; correctness never depends on them.
- `waitUntil` work (revalidation, wake-ups) is cut 30 s after the response. That is shorter than a Render cold
  start, but the request reaches Render, and that is what wakes the service.

## Cold starts

Render's free services (Java and Go) sleep after 15 minutes idle. Java's measured cold start is about 100 s; Go's is not
measured yet. The measured figures live in `web/src/features/under-the-hood/conformance.json` (`coldStartS`), which
the Tech page shows. Node and Rust run as Cloudflare Workers and never sleep.
- A `GET` that misses the cache and gets no response headers within `ORIGIN_TIMEOUT_MS` (8 s) returns a 503
  `backend-waking` with `Retry-After: 20`. The request keeps running under `waitUntil`, which wakes the backend and
  fills the cache when it finishes within 30 s.
- `/healthz` and `/readyz` wait at most 2.5 s. They then return the same 503, abort, and send a separate background
  `GET /healthz` to wake the backend (at most one per impl every 15 s per isolate).
- The SPA (`web/src/api/backends.ts`) aborts its own probe at 3 s. It treats 502/503/504 as "waking" and retries
  with backoff for up to 90 s. It treats `backend-not-deployed`, `unknown-backend` and `static-mode` as final ("down").
- Unsafe methods are never cut short with "waking", because the write might still happen. They wait up to 100 s
  (then 504 `gateway-timeout`).
- Render's own HTML 502/503/504 pages become a 503 `backend-unavailable` problem, except its page for a suspended
  service ("suspended" in the body), which becomes a 503 `backend-paused` with `Retry-After` until the next UTC
  month: the Render hours guard (`scripts/budget-check.mjs`) suspended it. The Tech page shows "paused this month".
- A backend that is up while its database is not (Neon resuming from scale-to-zero) answers 503 `not-ready` with
  `Retry-After`. On a cacheable miss the edge returns its own 503 `backend-waking` with that `Retry-After`, and retries
  once in the background 5 s later to fill the cache. A stale copy, when there is one, is served instead (stale-if-error).

## SSE

`/api/{impl}/v1/live/stream` is never cached:
- `Last-Event-ID` is forwarded;
- the upstream body stream goes straight into the response (no `TransformStream`, no buffering), so frames arrive
  as written;
- `X-Accel-Buffering: no` is kept.

The test suite checks this: the first frame is read while the origin still holds the stream open.

**CPU time.** Workers bill CPU time, not wall time. Cloudflare's limits page says time spent waiting on `fetch()`
doesn't count toward CPU time, and HTTP-triggered Workers have no hard duration limit. A body passed through
untouched is piped by the runtime without running JavaScript. A stream therefore costs the proxy about a
millisecond of CPU to set up and nothing per frame. It can stay open as long as the client and origin keep it
(20 s heartbeats). Each connection and each reconnect counts as one request against the 100k/day quota.

## Rate limiting

- Pages Functions can't declare the Workers Rate Limiting binding. The Pages bindings list (KV, Durable Objects, R2,
  D1, Vectorize, AI, services, queues, Hyperdrive, Analytics Engine, vars, secrets) doesn't include it.
- The proxy therefore uses an **in-memory token bucket per isolate**, keyed by `CF-Connecting-IP`. The defaults are
  `RATE_LIMIT_BURST` = 60 and `RATE_LIMIT_PER_MINUTE` = 120.
- The bucket is **best-effort**: each isolate and each PoP counts separately, and isolates are recycled. It stops a
  single client looping on the API; it does not stop a distributed one.
- Over the limit, the proxy answers 429 `rate-limited` with `Retry-After`.
- If a `RATE_LIMITER` binding ever becomes available (for example through a service binding to a small Worker), it
  takes over automatically.

## Static mode (manual emergency switch)

`STATIC_MODE=true` stops all origin traffic:
- cached entries of any age are served (`X-Edge-Stale: static-mode` when past `max-age`);
- everything else, including health, SSE and writes, gets a 503 `static-mode` with `Retry-After: 3600`.

**Decision (2026-10-21, OPEN-QUESTIONS A.9):** the backends stay live, and Render bandwidth is kept down by compression
and the edge cache (dataset pin) instead. There is no scheduled bandwidth job, and nothing flips this switch
automatically. It stays as a manual emergency switch, for example if a scraper gets past the rate limit. To use it:
1. **Env var (no new resource).** Set `"STATIC_MODE": "true"` in `wrangler.jsonc` and push to `main`; `deploy.yml`
   redeploys Pages. Set it back the same way. The var must be committed, because every deploy from `main` resets the
   Pages vars to `wrangler.jsonc`.
2. **KV flag (not set up).** The proxy also reads the key `static_mode` from an optional KV binding `EDGE_FLAGS`, at
   most once a minute per isolate (`cacheTtl` 60). Binding one would create a Cloudflare resource, so it is not used.

## Configuration

Defaults are committed in `wrangler.jsonc` under `vars`:

| Var | Default | Meaning |
|---|---|---|
| `BACKEND_ORIGINS` | `{"java":"https://typhoon-replay-java.onrender.com"}` | impl → origin (add node/rust/go as they deploy) |
| `STATIC_MODE` | `false` | manual emergency switch: cached answers only |
| `ORIGIN_TIMEOUT_MS` | `8000` | wait before 503 `backend-waking` on a miss |
| `STALE_TIMEOUT_MS` | `1500` | wait before serving a stale-if-error copy |
| `STALE_IF_ERROR_S` | `604800` | edge stale-if-error window when the origin sends none |
| `RATE_LIMIT_PER_MINUTE` / `RATE_LIMIT_BURST` | `120` / `60` | per-IP token bucket |

Optional bindings: `EDGE_FLAGS` (KV, static-mode flag) and `RATE_LIMITER`. Optional secret: `EDGE_SECRET`
(`wrangler pages secret put EDGE_SECRET --project-name typhoon-replay`), the same value as each backend's `TR_EDGE_SECRET`.

## Tests

```sh
npm run test:edge   # tsc -p edge + Vitest inside workerd (@cloudflare/vitest-plugin), ≤ 2 workers
```

The tests run in the real Workers runtime (Miniflare), with `caches.default`. The backend is a fake origin
installed over `fetch`. They cover:
- routing and rewrite, the origin map, header hygiene;
- cache HIT, MISS and STALE in both modes, 304s, cookies and private responses never cached, Vary keys, the dataset
  pin, and the upstream `Accept-Encoding`;
- cold-start 503 plus wake, incremental SSE, rate limiting, static mode, unknown impls and oversized bodies.

`scripts/ci.sh` runs them after the web checks.

Manual check against real backends:

```sh
npm run preview   # build + wrangler pages dev on :8788, with the Function
curl -si localhost:8788/api/java/v1/storms | grep -i x-edge-cache   # MISS, then HIT
```
