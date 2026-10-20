# Conformance suite

One language-neutral suite, run against every backend (CONTRACT-GUIDE §12). It needs the database loaded with
`contracts/db/seed` (`just db-up`); golden answers live in `src/fixtures.ts`.

## Layers

| Layer | Files | Runs against |
|---|---|---|
| Schemathesis (property-based, schema + headers + status + negative data) | `schemathesis/backend.toml` | a backend |
| Schemathesis smoke of the spec itself (positive data, examples) | `schemathesis/prism-smoke.toml` | Prism |
| Vitest scenarios over HTTP | `tests/*.test.ts` | a backend; with `IMPL=mock` only the contract-shape checks run |
| Mock OAuth2 provider (Google + GitHub endpoints, PKCE S256 checked) | `mock-idp/server.mjs` | used by `auth.test.ts` |
| Compatibility table | `scripts/results-to-markdown.mjs` | reads `results/` |

Scenario files: `headers` (§4 headers, X-Request-Id, compression), `storms` (paging walks, cursors, filters, Haiyan
golden data, no nulls, 64 KB cap), `caching` (ETag/304, cross-backend ETag equality, Cache-Control classes),
`problems` (problem+json shapes and codes), `places` (search, the places-hit query for Tacloban and Naha),
`live` (SSE framing, delivery within 5 s, `Last-Event-ID` resume, heartbeat), `auth` (login redirect, PKCE,
cookie attributes, invalid state, `returnTo`, logout everywhere), `me` (CSRF on unsafe methods, saved places,
alerts, account deletion), `test-hooks` (absent unless enabled).

## Running

```sh
just db-up && just idp                 # database with the fixture, mock IdP on :9090
# start the backend with TR_TEST_HOOKS=1, TR_SITE_ORIGIN=http://localhost:8788 and the TR_OAUTH_* URLs of the mock IdP
just conformance java                  # or: BASE_URL=http://localhost:8081 IMPL=java npm --prefix contracts run conformance
just compat-table
```

| Env | Meaning |
|---|---|
| `BASE_URL`, `IMPL` | Backend under test (`java\|node\|rust\|go\|mock`). Required |
| `SITE_ORIGIN` | The backend's `TR_SITE_ORIGIN` (default `http://localhost:8788`) |
| `FORWARDED_PREFIX` | Sent as `X-Forwarded-Prefix`, as the edge proxy would (default `/api/$IMPL`) |
| `IDP_URL` | Mock IdP (default `http://localhost:9090`) |
| `OTHER_BACKENDS` | `impl=url,...` of other running backends: cross-backend cursors, ETags and sessions |
| `NO_HOOKS_BASE_URL` | A backend started without `TR_TEST_HOOKS`, to prove the hooks are absent |
| `TEST_HOOKS=0` | Skip scenarios that need the hooks |
| `SLOW=1` | Include the 25 s heartbeat scenario |
| `CLAIMED_CONTRACT` | The contract version the backend claims (from `impl.json`) |

Every `describe` is tagged with the contract version that introduced it (`[c1.0.0]`). Use `claims()` from
`src/env.ts` to skip scenarios newer than the backend's claim; they are reported as skipped ("not claimed").

## Test hooks (backends implement these; CONTRACT-GUIDE §10)

Only when `TR_TEST_HOOKS=1`, otherwise 404 `not-found`. Not CSRF-checked, absent from the public bundle
(`x-internal`), specified in `openapi/paths/test-*.yaml`.

- `POST /v1/_test/sessions {email, provider}` → 201 `{userId, expiresAt}` + `Set-Cookie: __Host-tr_session=...`
- `POST /v1/_test/live-events {type, payload}` → 201 `{seq}`; runs `SELECT live.apply_event(type, payload)`

The seed also holds a fixed session for tools that cannot call the hook (Schemathesis):
`Cookie: __Host-tr_session=fixture-session-token-ana-0000000000000` (CI and local only).

## Mock IdP

`node mock-idp/server.mjs` (or `just idp`). Point a backend at it with:

```
TR_OAUTH_GITHUB_AUTH_URL=http://localhost:9090/github/login/oauth/authorize
TR_OAUTH_GITHUB_TOKEN_URL=http://localhost:9090/github/login/oauth/access_token
TR_OAUTH_GITHUB_USERINFO_URL=http://localhost:9090/github/api/user
TR_OAUTH_GOOGLE_AUTH_URL=http://localhost:9090/google/authorize
TR_OAUTH_GOOGLE_TOKEN_URL=http://localhost:9090/google/token
TR_OAUTH_GOOGLE_USERINFO_URL=http://localhost:9090/google/userinfo
```

Authorize approves at once; the token endpoint rejects a wrong PKCE verifier, a reused code or a changed
`redirect_uri`. `POST /_mock/next-user {provider, subject, email, name}` picks the next identity;
`GET /_mock/last-authorize` and `GET /_mock/last-token-request` expose what the backend sent.
