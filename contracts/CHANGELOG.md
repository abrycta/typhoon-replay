# Contract changelog

Semver of `info.version` in `openapi/openapi.yaml` (CONTRACT-GUIDE §2). Minor = additive, patch = docs/examples,
major = breaking. A major that changes an operation which stays also gets a new `/vN` URL prefix; a major that only
removes operations keeps the prefix (§2). `scripts/oasdiff-check.sh` writes the machine changelog to
`dist/changelog.md`, and accepts breaking changes only with a major bump and an entry here.

## 2.0.1 (2026-10-21)

Corrections, no change to fields, parameters, statuses or cursor rules (CONTRACT-GUIDE §15).

- `/v1/meta` ETag is `W/"c{contractVersion}-{impl}-{implVersion}-d{datasetVersion}"`, so a dataset publish
  changes it (the body carries `datasetVersion`). `/v1/openapi.json` is unchanged.
- Problem `type` URIs, the production server and the examples use the canonical host `https://typhoon.krtmtthw.dev`
  instead of `typhoon-replay.pages.dev`.
- Cursor examples are per operation (`StormCursor`, `HitCursor`, `StormPlaceCursor` replace `Cursor`), each made for
  the operation's default sort, so Schemathesis's positive-data checks accept them.
- New `npm run check-examples` (CI: contracts.yml): every example validated against its schema with formats and
  undeclared properties checked, SSE example frames against `x-sse-events`, cursor examples against the sort.

## 2.0.0 (2026-10-21)

**Breaking: accounts removed** (decision of 2026-10-21; CONTRACT-GUIDE §14). Visitor features move to static files and
the browser; the API becomes a public, read-only showcase.

- Removed operations: sign-in (`/v1/auth/providers`, `/v1/auth/{provider}/login`,
  `/v1/auth/{provider}/callback`, `/v1/auth/logout`), `/v1/me` (GET, DELETE), `/v1/me/places` and
  `/v1/me/places/{savedPlaceId}`, `/v1/me/alerts`, `/v1/alerts/unsubscribe`, and the `POST /v1/_test/sessions` hook.
- Removed the `sessionCookie` and `csrfHeader` security schemes, their schemas, parameters, headers (`Set-Cookie`,
  `Location`), responses and examples, and the problem codes `unauthenticated`, `forbidden`, `csrf`, `conflict`,
  `precondition-failed`, `unprocessable`.
- Rules: no cookies, no CSRF, every operation public; all responses except the live stream are cacheable. Lint
  rule `portable/public-read-only` enforces it.
- Database: migration `20261021000600_drop_accounts` drops `auth.*` and the `app` account tables.
- **Unchanged:** every remaining operation (probes, meta, storms, places, hits, live), with its parameters,
  responses, headers, ETags, cursors and SSE events.

**Why the URL stays `/v1`.** The guide separates the URL major (a promise that an operation under `/v1` keeps its
meaning) from the contract semver (`info.version`, what oasdiff gates). v1.0.0's rule said "a breaking change creates
`/v2`, served alongside `/v1`", which exists so callers of a *changed* operation keep working while they migrate.
2.0.0 changes no operation that survives; it only deletes some. A `/v2` copy would break every caller of the
surviving operations (the web app, the edge proxy's `/v1` routing, cached URLs) for no semantic change, and "served
alongside `/v1`" would mean keeping the account endpoints alive, which is what the decision removes. So the contract
major goes to 2 and the prefix stays `/v1`; §2 now states this rule explicitly. Removed operations answer 404
`not-found`. Backends declare `>=2.0.0 <3.0.0` in `impl.json`; `X-Contract-Version` and `/v1/meta` report `2.0.0`.

## 1.0.0 (2026-10-21)

First version: meta and probes, storm catalogue (list/search, detail, best track, places hit), places
(search, nearest, detail, storms that hit a place or point), live snapshot and SSE stream, OAuth2 sign-in
(Google, GitHub), the signed-in user, saved places, alert preferences and one-click unsubscribe.
Database schema `20261021000500`.
