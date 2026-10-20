# Mocking the API (no backend)

## Prism (HTTP)

`just mock` bundles the contract and serves `dist/openapi.json` with Prism on `http://localhost:4010`
(compose profile `mock`). Prism answers with the named examples (Haiyan, Tacloban, Naha, ...), validates requests
against the spec, and sets `X-Backend-Impl: mock`.

- Pick an example: `Prefer: example=naha` (e.g. on `GET /v1/places/{placeId}/storms`).
- Force a status: `Prefer: code=404`.
- Random data from the schemas instead of examples: run Prism with `-d`.

Prism does not stream SSE (`GET /v1/live/stream` returns the example frames in one response), and it does not
implement behaviour (paging, ETags). That is what the conformance suite checks against real backends.

## MSW in web/ (note for the web agent; no web code lives here)

`web/` runs in mock mode with MSW handlers generated from the same bundle, so the frontend and backends can't drift:

1. Types: `openapi-typescript ../contracts/dist/openapi.json -o src/api/schema.d.ts` (run from `web/`).
2. HTTP handlers: generate one MSW `http.*` handler per operation from `dist/openapi.json`, returning that
   operation's first named example and status, e.g. with `msw-auto-mock` or a ~60-line script that walks
   `paths` → `responses` → `content.*.examples`. Keep the output under `web/src/mocks/` and regenerate it in the web
   build when the bundle changes.
3. SSE: MSW `sse()` for `/v1/live/stream`. Send `retry: 10000`, then an `event: snapshot` from the `LiveSnapshot`
   example (`components/examples/LiveSnapshot.yaml`), then `storm-upserted` / `storm-removed` frames on a timer,
   with increasing `id`s. Frame format: `components/examples/LiveStreamFrames.yaml`; event → schema map:
   `x-sse-events` on `streamLiveEvents`.
4. Point the client at the mock with the base `/api/mock/v1`, and show the "Served by" badge from the
   `X-Backend-Impl` response header (`mock`), as for the real backends.
