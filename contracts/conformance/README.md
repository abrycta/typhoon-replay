# Conformance suite

One language-neutral suite, run against every backend (CONTRACT-GUIDE §12). It needs the database loaded with
`contracts/db/seed` (`just db-up`); golden answers live in `src/fixtures.ts`.

## Layers

| Layer | Files | Runs against |
|---|---|---|
| Schemathesis (property-based, schema + headers + status + negative data) | `schemathesis/backend.toml` | a backend |
| Schemathesis smoke of the spec itself (positive data, examples) | `schemathesis/prism-smoke.toml` | Prism |
| Vitest scenarios over HTTP | `tests/*.test.ts` | a backend; with `IMPL=mock` only the contract-shape checks run |
| Compatibility table | `scripts/results-to-markdown.mjs` | reads `results/` |

Scenario files: `headers` (§4 headers, X-Request-Id, compression), `storms` (paging walks, cursors, filters, Haiyan
golden data, no nulls, 64 KB cap), `caching` (ETag/304, cross-backend ETag equality, Cache-Control classes),
`problems` (problem+json shapes and codes; the v1 account routes answer 404 and unsafe methods 405, with no CSRF
headers needed), `places` (search, the places-hit query for Tacloban and Naha), `live` (SSE framing, delivery within
5 s, `Last-Event-ID` resume, heartbeat), `test-hooks` (absent unless enabled). `caching` also proves cookies are
ignored and never set. Contract 2.0.0 removed the auth, session, CSRF and saved-place scenarios with the account
operations (CONTRACT-GUIDE §14).

## Running

```sh
just db-up                             # database with the fixture
# start the backend with TR_TEST_HOOKS=1 and TR_SITE_ORIGIN=http://localhost:8788
just conformance java                  # or: BASE_URL=http://localhost:8081 IMPL=java npm --prefix contracts run conformance
just compat-table
```

| Env | Meaning |
|---|---|
| `BASE_URL`, `IMPL` | Backend under test (`java\|node\|rust\|go\|mock`). Required |
| `SITE_ORIGIN` | The backend's `TR_SITE_ORIGIN` (default `http://localhost:8788`) |
| `FORWARDED_PREFIX` | Sent as `X-Forwarded-Prefix`, as the edge proxy would (default `/api/$IMPL`) |
| `OTHER_BACKENDS` | `impl=url,...` of other running backends: cross-backend cursors and ETags |
| `NO_HOOKS_BASE_URL` | A backend started without `TR_TEST_HOOKS`, to prove the hooks are absent |
| `TEST_HOOKS=0` | Skip scenarios that need the hooks |
| `SLOW=1` | Include the 25 s heartbeat scenario |
| `CLAIMED_CONTRACT` | The contract version the backend claims (from `impl.json`) |

Every `describe` (or `it`) is tagged with the contract version that introduced it (`[c1.0.0]`, `[c2.0.0]`). Use
`claims()` from `src/env.ts` to skip scenarios newer than the backend's claim; they are reported as skipped
("not claimed"). Scenarios that survived the 2.0.0 major keep their `[c1.0.0]` tag; removed ones were deleted.

## Test hooks (backends implement these; CONTRACT-GUIDE §10)

Only when `TR_TEST_HOOKS=1`, otherwise 404 `not-found`. Absent from the public bundle (`x-internal`), specified in
`openapi/paths/test-*.yaml`.

- `POST /v1/_test/live-events {type, payload}` → 201 `{seq}`; runs `SELECT live.apply_event(type, payload)`
