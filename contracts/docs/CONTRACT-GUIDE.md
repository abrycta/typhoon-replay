# Typhoon Replay API: contract guide (v1)

> **DRAFT, awaiting the user's approval.** Written 2026-10-21. Nothing here is final until approved. After approval, `contracts/openapi/` becomes the single source of truth, and this guide only explains the rules the spec can't express.
> Background and the reasons for each rule: [`docs/architecture/SYSTEM-ARCHITECTURE-RESEARCH.md`](../../docs/architecture/SYSTEM-ARCHITECTURE-RESEARCH.md). Open decisions: [`docs/architecture/OPEN-QUESTIONS.md`](../../docs/architecture/OPEN-QUESTIONS.md).

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 0. Principles

1. **One contract, four implementations.** The Java, Node/TypeScript, Rust and Go backends MUST be interchangeable behind the same frontend: same paths, status codes, headers, JSON shapes, error codes, cursors, ETags and SSE events. Bytes may differ (key order, whitespace, float formatting); semantics may not.
2. **Contract-first.** `contracts/openapi/openapi.yaml` (OpenAPI 3.1.0, portable subset, §1) is the source of truth. A backend that generates its spec from code MUST pass `oasdiff breaking` against the contract in both directions.
3. **The schema belongs to the contract.** Database DDL lives in `contracts/db/migrations` (dbmate). Backends MUST NOT run migrations or any DDL.
4. **No background work in backends.** Live ingestion, alert matching and email sending run in the shared pipeline job. Backends only serve requests and fan out SSE.
5. **Tolerant reader.** Clients (the web app, conformance tests) MUST ignore unknown JSON fields and unknown SSE event types. Additive changes are minor versions.

## 1. Spec conventions (enforced by `redocly lint`)

- OpenAPI **3.1.0**, portable subset:
  - no `type` arrays and no `null`;
  - no `$dynamicRef`, `if/then/else`, `patternProperties`, `unevaluatedProperties` or webhooks;
  - `oneOf` only with a `discriminator`.
- **Optional fields are omitted, never `null`.** Backends MUST NOT emit `null`.
- JSON property names are `camelCase`; enum values are `kebab-case`; path segments are `kebab-case` plurals.
- Every operation has an `operationId` (`verbNoun`, e.g. `listStorms`), a tag, at least one example, and documented `4xx` responses using the shared problem responses.
- Bundles: `dist/openapi.json` (3.1, canonical, served at `GET /v1/openapi.json`) and `dist/openapi.3.0.json` (down-converted for generators only).

## 2. Base path, routing and versioning

- The public base as seen by the browser is `https://typhoon-replay.pages.dev/api/{impl}/v1`, with `{impl} ∈ java | node | rust | go`. The edge proxy strips `/api/{impl}`, so **backends serve `/v1/...`, `/healthz` and `/readyz` at their own root**.
- `/v1` is the major version. A breaking change creates `/v2`, served alongside `/v1` until every backend has moved.
- `info.version` is the contract semver. Each backend declares the contract range it implements in `api/<lang>/impl.json` and reports it at runtime (§4).

## 3. Data conventions

| Thing | Rule |
|---|---|
| Timestamps | RFC 3339, UTC, `Z` suffix, whole seconds: `2013-11-08T00:00:00Z` |
| Coordinates | GeoJSON order `[lon, lat]`, WGS 84, at most 4 decimal places. Longitudes normalised to (-180, 180] |
| Geometry | GeoJSON objects (RFC 7946) where geometry is returned; `application/geo+json` only for explicit `.../track` FeatureCollections |
| Units in names | `windKt` (knots), `pressureHpa`, `distanceKm` (1 dp), `radiusKm`, `rainMm` |
| Storm id | IBTrACS SID, e.g. `2013306N07162` (`^[0-9]{7}[NS][0-9]{5}$`) |
| Place id | `PH-` + 10-digit PSGC, or `JP-` + 5-digit JIS municipality code |
| Names | `name` (international), `localNames: {ph?: "Yolanda", ja?: "台風第30号"}` when known |
| Integers vs decimals | Counts are integers; measurements are JSON numbers. Clients MUST NOT rely on the trailing-zero format |
| Strings | UTF-8; Japanese names unescaped |

## 4. Headers every response MUST carry

| Header | Value |
|---|---|
| `X-Backend-Impl` | `java` / `node` / `rust` / `go` |
| `X-Backend-Version` | the backend's semver |
| `X-Contract-Version` | the contract version it implements, e.g. `1.0.0` |
| `X-Request-Id` | echo the inbound `X-Request-Id` if it is 1–64 chars of `[A-Za-z0-9._-]`; otherwise a new UUIDv7 |
| `Content-Type` | `application/json; charset=utf-8`, `application/problem+json`, `application/geo+json` or `text/event-stream` |
| `Cache-Control` | always present (§6) |
| `Vary` | `Accept-Encoding` on all responses; also `Cookie` on responses that depend on the session |

- Responses over 1 KB MUST be compressed when the client accepts it: gzip MUST be supported, br SHOULD be.
- CORS: browsers reach the API same-origin through the proxy, so backends MUST NOT send `Access-Control-Allow-Credentials`. They MAY allow `*` for anonymous `GET`s, for third-party API users.

## 5. Pagination

- Query parameters `limit` (1–200, default 50) and `cursor` (opaque).
- Response: `{ "items": [...], "nextCursor": "..." }`; `nextCursor` is omitted on the last page. A `Link: <absolute-url>; rel="next"` header MUST accompany `nextCursor`, built from the **browser-visible** base, which is taken from `X-Forwarded-Prefix` set by the proxy.
- **Interchangeable cursors.** The cursor is `base64url(no padding)` of the UTF-8 JSON array `[1, "<sortKey>", <keysetValue...>, "<lastId>"]`. Example: `[1,"closest",12.4,"2013306N07162"]`.
  - Every backend MUST accept cursors produced by any other backend.
  - An invalid or foreign-sort cursor returns 400 `invalid-cursor`.
- Sort orders are fixed per endpoint and listed in the spec. Ties break by id ascending.

## 6. Caching and conditional requests

| Resource class | Cache-Control | ETag |
|---|---|---|
| Catalogue reads (storms, places, hits, search) | `public, max-age=300, stale-while-revalidate=86400` | `W/"d{datasetVersion}-{resourceKey}"` |
| `/v1/meta`, `/v1/openapi.json` | `public, max-age=60` | `W/"c{contractVersion}-{impl}-{implVersion}"` |
| Live snapshot `GET /v1/live/storms` | `no-cache` | `W/"s{latestSeq}"` |
| Anything under `/v1/me`, auth endpoints | `private, no-store` | none |
| Errors | `no-store`, except 404 on catalogue (`public, max-age=60`) | none |
| `/healthz`, `/readyz` | `no-store` | none |

- `datasetVersion` is the integer in the newest `catalog.dataset_version` row. `resourceKey` is a canonical string of the path plus the sorted query parameters that affect the result. **ETags are derived from data, never from response bytes**, so all four backends emit the same ETag for the same resource.
- `If-None-Match` matching a weak ETag (weak comparison) MUST return `304` with the same `ETag` and `Cache-Control` and no body.
- Unsafe methods on user resources MAY use `If-Match`; a mismatch returns 412 `precondition-failed`.

## 7. Live stream (SSE)

`GET /v1/live/stream`, `Accept: text/event-stream`. Anonymous. Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`, plus §4. No compression.

- **Framing:** standard SSE (`event:`, `id:`, `data:` as a single line of JSON, blank line).
- **First frame:** `retry: 10000`, then an `event: snapshot` whose `id` is the latest `live_event.seq`.
- **Resume:** if `Last-Event-ID` (header or `?lastEventId=`) is within the retained window (7 days), send the missed events in `seq` order and *no* snapshot. Otherwise send a snapshot. `seq` comes from the shared `live.live_event` table, so resume works across backends.
- **Heartbeat:** a comment line `:\n\n` at least every 20 s (the client treats 45 s of silence as a dead stream).
- **Delivery:** a new `live_event` row MUST reach connected clients within 5 s (polling `seq > last` every ≤ 3 s while ≥ 1 client is connected is acceptable). Backends MUST NOT hold an idle DB connection when no client is connected.
- **Limits:** a backend MAY cap concurrent streams (≥ 50). When over the cap it returns 503 `stream-capacity` with `Retry-After`.

| `event:` | `data` schema | Meaning |
|---|---|---|
| `snapshot` | `LiveSnapshot { asOf, storms: ActiveStorm[] }` | Full current state |
| `storm-upserted` | `ActiveStorm { sid?, liveId, name, localNames?, agency, observedAt, position:[lon,lat], windKt?, pressureHpa?, movement?, forecast?: ForecastPoint[], advisoryUrl? }` | A new advisory |
| `storm-removed` | `{ liveId, reason: "dissipated" \| "left-area" \| "merged" }` | Remove from map |

Unknown event names MUST be ignored by clients. New event types are a minor contract change. The spec lists the event map under `x-sse-events` on the operation, and conformance validates every `data` against it. When OpenAPI 3.2 tooling matures, this moves to `itemSchema`.

## 8. Errors: RFC 9457 problem details

Every 4xx/5xx response (except 304) MUST be `application/problem+json`:

```json
{
  "type": "https://typhoon-replay.pages.dev/problems/validation",
  "title": "Request validation failed",
  "status": 400,
  "detail": "limit must be between 1 and 200",
  "instance": "/v1/storms?limit=500",
  "code": "validation",
  "requestId": "01J…",
  "errors": [{ "pointer": "#/query/limit", "detail": "must be <= 200" }]
}
```

- `code` is stable and machine-readable. `type` = the base URL + `code`. `title` is fixed per `code`. `detail` is free text: tests MUST NOT assert on it.
- **Codes:**

  | Status | Codes |
  |---|---|
  | 400 | `validation`, `invalid-cursor` |
  | 401 | `unauthenticated` |
  | 403 | `forbidden`, `csrf` |
  | 404 | `not-found` |
  | 405 | `method-not-allowed` |
  | 406 | `not-acceptable` |
  | 409 | `conflict` |
  | 412 | `precondition-failed` |
  | 413 | `payload-too-large` |
  | 415 | `unsupported-media-type` |
  | 422 | `unprocessable` |
  | 429 | `rate-limited` (with `Retry-After`) |
  | 500 | `internal` (no stack traces, no SQL) |
  | 503 | `not-ready`, `stream-capacity` |

- Unknown routes under `/v1` return 404 problem+json, not a framework HTML page.

## 9. Auth

- **Providers:** Google and GitHub, OAuth2 authorization code + PKCE S256 + `state`. Provider endpoints and client credentials come from env (`TR_OAUTH_{GOOGLE,GITHUB}_{CLIENT_ID,CLIENT_SECRET,AUTH_URL,TOKEN_URL,USERINFO_URL}`), so tests can point them at the mock IdP.
- **Flow state:** `state`, the PKCE verifier, the provider and `returnTo` are stored in `auth.oauth_state` (10-minute TTL, single use), never in process memory. Any backend can complete a flow any backend started.
- **`returnTo`:** MUST be a same-origin relative path starting with `/` and not `//`; otherwise use `/`.
- **Session:**
  - 32 random bytes from a CSPRNG, base64url;
  - stored only as `sha256` in `auth.session`;
  - cookie `__Host-tr_session=<token>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`;
  - sliding 30-day expiry; `last_seen_at` is updated at most every 5 min.
- **Storage:** sessions live in the contract-owned table `auth.session` (`token_hash bytea PK, user_id, data jsonb, created_at, last_seen_at, expires_at, revoked_at, created_by_impl, user_agent`). Backends MUST use a custom store against this table. Framework session serialisation (Spring Session JDBC, gob, etc.) MUST NOT be used. `data` holds only neutral JSON attributes. Provider access/refresh tokens are never stored.
- **Callback URIs:** one GitHub OAuth app and one Google client, each registering exact-match URIs `https://typhoon-replay.pages.dev/api/{impl}/v1/auth/{provider}/callback` (wildcard matching off). Backends build `redirect_uri` from `TR_SITE_ORIGIN` + `X-Forwarded-Prefix`, never from the Render host.
- **Lookup:** valid when `revoked_at IS NULL AND expires_at > now()`. An invalid or missing session on a protected endpoint returns 401 `unauthenticated`. The cookie is cleared only by logout.
- **CSRF**, for `POST`/`PUT`/`PATCH`/`DELETE`: the `Origin` header MUST equal the configured site origin (`TR_SITE_ORIGIN`), and the request MUST carry `X-Requested-With: typhoon-replay`. Otherwise 403 `csrf`.
- **Logout:** sets `revoked_at` and clears the cookie (same attributes, `Max-Age=0`). It is effective on all backends immediately.
- **Account deletion** (`DELETE /v1/me`): deletes the user, their identities, sessions, saved places and subscriptions.

## 10. Endpoints (v1 outline)

Anonymous unless marked 🔒 (needs a session). All are paths under `/v1`.

**Meta**
- `GET /meta`: `{impl, implVersion, contractVersion, schemaVersion, datasetVersion, commit, startedAt}`
- `GET /openapi.json`: the contract bundle, identical across backends
- `GET /healthz` (process only) and `GET /readyz` (DB reachable, schema ≥ `minSchemaVersion`): both at the backend root, outside `/v1`

**Storms (catalogue)**
- `GET /storms?season=&seasonFrom=&seasonTo=&q=&country=PH|JP&minWindKt=&sort=season-desc|peak-wind-desc|name&cursor=&limit=`
- `GET /storms/{sid}`: summary, peak intensity, landfalls, local names, data sources
- `GET /storms/{sid}/track`: GeoJSON FeatureCollection of hourly (interpolated) and 3/6-hourly (observed) points; `?resolution=observed|hourly`
- `GET /storms/{sid}/places?country=&maxDistanceKm=&sort=closest|peak-wind&cursor=&limit=`: places affected by this storm

**Places and "typhoons that hit my town"**
- `GET /places/search?q=&country=&limit=`: name search (Latin, Filipino, Japanese)
- `GET /places/nearest?lat=&lon=`: the place containing or nearest to a point
- `GET /places/{placeId}`: properties + simplified geometry
- `GET /places/{placeId}/storms?radiusKm=50..500&minWindKt=&from=&to=&sort=closest|peak-wind-desc|date-desc&cursor=&limit=`: the headline query. Each item: `{storm summary, closestApproachKm, closestApproachAt, maxWindKtWithinRadius, hoursWithinRadius}`
- `GET /hits?lat=&lon=&radiusKm=&...`: the same for an arbitrary point (geodesic distance on `geography`)

**Live**
- `GET /live/storms`: `LiveSnapshot`
- `GET /live/stream`: SSE (§7)

**Auth**
- `GET /auth/providers`: `[{id:"google",name:"Google"},{id:"github",name:"GitHub"}]`
- `GET /auth/{provider}/login?returnTo=`: 302 to the provider
- `GET /auth/{provider}/callback?code=&state=`: 302 to `returnTo`; on failure, 302 to `/signin?error=<code>`
- `POST /auth/logout` 🔒: 204

**Me**
- `GET /me` 🔒: `{id, displayName, email, avatarUrl?, providers[], createdAt}`
- `DELETE /me` 🔒: 204
- `GET /me/places` 🔒 and `POST /me/places` 🔒 `{placeId | {lat,lon,label}, label?}`: max 20 per user, 409 `conflict` on a duplicate
- `PATCH /me/places/{id}` 🔒 and `DELETE /me/places/{id}` 🔒
- `GET /me/alerts` 🔒 and `PUT /me/alerts` 🔒 `{enabled, radiusKm, minWindKt, placeIds[]}`
- `GET /alerts/unsubscribe?token=`: anonymous; the token is a random value stored in `app.alert_subscription`; returns a small HTML confirmation page (the only non-JSON success response)

**Test hooks** (only when `TR_TEST_HOOKS=1`; otherwise MUST return 404)
- `POST /_test/sessions {email, provider}` → sets the session cookie
- `POST /_test/live-events {type, payload}` → inserts a `live_event` row

## 11. Operational rules

- Configuration comes only from env, with the same names in every backend: `DATABASE_URL` (pooled), `TR_SITE_ORIGIN`, `TR_TEST_HOOKS`, `TR_OAUTH_*`, `TR_LOG_LEVEL`, `PORT`.
- Logs: one JSON object per line with `ts, level, msg, requestId, impl, method, path, status, durMs`. Never log cookies, tokens or OAuth codes.
- Readiness: answer `/healthz` within 1 s of the port opening. Fail `/readyz` (503 `not-ready`) until the DB is reachable and the schema version is ≥ the minimum.
- DB use: through the Neon pooler (transaction mode). No session-level state (`SET`, `LISTEN`, session advisory locks, SQL `PREPARE`). Statement timeout 5 s. Pool max ≤ 5 per backend. Any coordination uses lease rows (`ops.job_lease`) or `SELECT … FOR UPDATE SKIP LOCKED` inside one transaction.
- No background work: no in-process schedulers, ingestion or mail sending. These belong to the shared pipeline job (live ingestion, `app.alert_outbox` with a unique `dedupe_key`, an HTTPS email API). Optional `POST /v1/_jobs/{name}` endpoints exist only if the user picks the rotating-backend job option (see OPEN-QUESTIONS).
- Rate limits: the proxy enforces per-IP limits. Backends MAY add their own, and MUST use 429 `rate-limited` + `Retry-After` if they do.
- Request body limit 64 KB → 413 `payload-too-large`.
- Response size budget (Render free egress is 5 GB/month for all four backends): JSON responses MUST stay ≤ 64 KB uncompressed at the maximum `limit`. Tracks are served at observed (3/6-hourly) resolution only. Hourly data, frames and polygons beyond the simplified geometry come from the static stores (Pages / Hugging Face), never from the API.

## 12. Conformance expectations

A backend is "v1-conformant at contract X.Y" when, against the fixture database (`contracts/db/fixtures`), all of these pass in CI:

1. **Schemathesis** with the contract bundle: no 5xx, and every response matches its documented status, content type, headers and schema; invalid input is rejected with 4xx problem+json.
2. **Scenario suite** (Vitest): golden results for the fixture places and storms; pagination walks; cross-backend cursor reuse; ETag/304; required headers; error `code`s; CSRF and `returnTo` rules.
3. **SSE suite:** snapshot first, heartbeat ≤ 20 s, resume via `Last-Event-ID`, delivery ≤ 5 s, schema-valid events, 503 on capacity.
4. **Auth suite** (mock IdP): login redirect parameters (state, S256 challenge); callback cookie attributes; a session usable on every other backend; logout revokes everywhere; test hooks absent when disabled.
5. **Differential check:** canonicalised responses equal across all four backends for the read-only scenario set.

Results are published per backend and contract version on the compatibility table (`/compat`). Tests tagged with a contract version newer than the backend's claim are reported as "not claimed", not as failed.
