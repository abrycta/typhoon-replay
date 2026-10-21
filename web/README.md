# web/

The Replay app (https://replay.krtmtthw.dev): **Stack A, a static-first SPA** (`docs/architecture/DECISIONS.md`). Vite 8, React 19, TypeScript strict, TanStack Router (file routes, typed search params as URL state) and Query, the Akari design system (`@abrycta/akari`), Lingui (EN/JA), MapLibre 6 with a hand-written WebGL2 field and particle layer.

## Run

```sh
cp .npmrc.example .npmrc; export NODE_AUTH_TOKEN=$(gh auth token)   # @abrycta/akari from GitHub Packages
npm ci
npm run dev          # http://localhost:5173 (fixtures served at /fixtures/ with Range support)
npm run build        # dist/ + storm share shells + sitemap
npm run test         # Vitest (units)
npm run e2e          # Playwright against `vite preview` of dist/ (build first)
npm run size         # JS/CSS per route, gzip
```

From the repo root, `scripts/ci.sh` runs install, typecheck, lint, unit tests, build, the Pages size guard and the e2e suite (commands in `deploy.config`).

## Layout

```
src/
  app/          providers, router, shell (header, footer), error pages
  routes/       thin TanStack file routes: /, /storms, /storm/$sid, /compare, /town, /about, /under-the-hood
  features/     replay, compare, storm-search, dataset-info, town-history, storm-places (static only)
                under-the-hood (the only feature that uses the API)
  api/          the only code that talks to a backend: requests through the edge proxy classified
                by its problem codes, the wake/retry policy, response comparison; contract types
  data/         static dataset: pointer/manifest/index/summary/track loaders, TYF frame
                loader in a Comlink worker (range windows or streaming), track interpolation,
                place index + in-browser place search, per-place exposure shards
  shared/       config, i18n (Lingui catalogues), domain types, colour/time/unit helpers, UI wrappers
```

`eslint-plugin-boundaries` enforces: only `src/api` talks to a backend, and only the `under-the-hood` feature may import it (via `@/api`); app, routes and every other feature cannot, so no visitor page calls `/api/*` (an e2e test crawls them to check). `src/data` never imports `src/api`; features never import each other. Bare `fetch` is banned outside `api/` and `data/`.

## Data and backends

- **Data** is read from `config.json` → `data.baseUrl` (the Hugging Face dataset), falling back to the bundled fixture in `fixtures/` (16 real IBTrACS storms; ERA5 frames for 72 h of Haiyan). Layout and the assumptions the pipeline should confirm: [docs/DATA-LAYOUT.md](docs/DATA-LAYOUT.md). Regenerate the fixture with `npm run fixtures -- --data <spike data/processed>`.
- **Visitor pages are static-only.** "My town" searches `places/search.json` in the browser (loaded on the town page only) and reads storms near a place from that place's shard; the storm page's affected places come from `summary.json`. Nothing global selects a backend.
- **Backends** come from `config.json` → `backends` (`/api/{java,node,rust,go}` behind the same-origin proxy) and are used only by `/under-the-hood`: a race of one question on all four (edge `backend-waking` retried with backoff honouring `Retry-After` for up to 3 minutes; `backend-not-deployed` not retried), an endpoint explorer, and the conformance table. Opening that page sends one idle-priority `/healthz` to Java to start waking it.
- **API types**: `npm run gen:api` regenerates `src/api/generated/` from `contracts/dist/openapi.json` (`-- --check` fails on drift).

## Conformance figures

The Under the hood page's conformance table is `src/features/under-the-hood/conformance.json`, imported at build time (no runtime fetch). Today it is edited by hand from the Java CI run (99/99 scenario tests, 2,150/2,150 Schemathesis cases, p95 storms list 2.8 ms locally, cold start ≈100 s on Render free). The plan for CI:

1. Each backend's workflow uploads a `conformance-<impl>.json` artifact on `main` with the same per-backend shape (`scenarios`, `generated`, `p95StormsListMs`, `coldStartS`, `status: "measured"`).
2. A small job merges the latest artifact of every backend into this file, sets `updatedAt`, and opens a PR (or commits to `main` when only numbers changed), so the next deploy carries the figures.
3. A backend without an artifact keeps `status: "next"` and shows "next" / "—".

## Replay

- Field colours come from Akari's sequential scale, baked into a 256-entry lookup texture; each layer has a fixed domain for every storm (wind 0–40 m/s, gust 0–60 m/s, rain 0–30 mm/h on a square-root ramp, pressure 950–1015 hPa).
- Hourly frames are blended in the shader; the storm-following window fades out over its outer 1.5°.
- Particles follow the webgl-wind technique (RGBA8 state, manual bilinear sampling). They are off by default when the system asks for reduced motion, and the home page does not autoplay then.
- Best-track intensity (JTWC 1-min, JMA 10-min, with interpolation provenance) sits beside the field, which is labelled "reanalysis context" with the live field-to-best-track ratio.
- The timeline table is the text alternative; the scrubber is a native range input with `aria-valuetext`. Keys: Space/K, ←/→ (1 h), PageUp/PageDown (6 h), Home/End.

## Performance budget

Measured on the production build (`npm run size`; `node scripts/measure-lcp.mjs` against `vite preview`, 4× CPU slowdown, 150 ms RTT, 9 Mbit/s, 412 px):

| | Budget | Measured |
|---|---|---|
| Initial JS (every route), gzip | ≤ 200 kB | 193 kB |
| Initial JS + route chunk, gzip | ≤ 215 kB | 193–210 kB |
| Critical CSS, gzip | ≤ 40 kB | 33 kB (fonts load non-blocking) |
| Map chunk (MapLibre + layer), lazy | n/a | 294 kB + 145 kB worker |
| LCP home / storms | ≤ 2.5 s | ~1.9 s / ~2.0 s |
| LCP storm page | ≤ 2.5 s | ~3.3 s (see below) |
| First field frame, storm page | ≤ 3 s target | ~6.2 s |

The storm page waits for config → dataset pointer → summary before its heading renders, and `vite preview` serves uncompressed JS; on Pages (brotli) and with the Hugging Face host answering the pointer directly, both numbers should drop, but this has not been measured on the deployed site yet.
