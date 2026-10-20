# Typhoon Replay frontend: open questions

These are questions the frontend cannot settle by itself. Each one names who decides and gives the default the research assumes, so work can start before it is answered.
See [ARCHITECTURE-RESEARCH.md](./ARCHITECTURE-RESEARCH.md) for the reasoning.

## For the system architect (contract and system)

1. **Auth model.**
   - Choices:
     - a cookie session (BFF) via a same-origin `/api/<backend>/*` proxy, as RFC 10017 recommends
     - bearer tokens with PKCE in the SPA
   - If cookies: is a session valid across all four backends (shared store or signing key), or does switching backend sign the user out?
   - CSRF mechanism (a header name, if any).
   - *Default:* cookie session via the proxy; switching backend keeps the session only if the backends share it.
2. **Same-origin proxy.**
   - Is a thin Cloudflare Pages Function / Worker acceptable? It is the only Cloudflare-specific piece, and it uses the 100k requests/day quota.
   - Who owns it: frontend or platform?
   - On hosts without a proxy (GitHub Pages), are the account features disabled?
   - *Default:* yes, frontend-owned, about 30 lines, pass-through including SSE.
3. **OpenAPI version.**
   - 3.1, or 3.2 for `itemSchema` on SSE? None of the TS generators document 3.2 yet.
   - *Default:* 3.1, with SSE event payloads as named component schemas.
4. **Health and info endpoints.**
   - The frontend needs a cheap unauthenticated `GET /health` and ideally `GET /info` returning `{ implementation: "rust", version, contractVersion }`.
   - Is the contract version checked by the frontend? It would warn on a mismatch.
5. **Error format.** RFC 9457 `application/problem+json` across all four backends? The adapter needs one shape.
6. **Pagination, sorting and filtering conventions** for storm search and "hit my town" (cursor or offset), so the adapter is written once.
7. **Identifiers.** Storm id = IBTrACS SID (`2013306N07162`)? Place id = PSGC code (PH) and JIS municipality code (JP)? These ids appear in URLs, so they must be stable.
8. **SSE contract.** Event names, a heartbeat interval, `retry:` value, `Last-Event-ID` semantics (replay missed events or not), and the source and refresh rate of live-tracker data.
9. **CORS policy** per backend, if direct (non-proxied) calls are allowed for the public REST API and mock mode.
10. **Mock data.** Who maintains the realistic fixtures (Haiyan, Rai, Hagibis), and do they live in `contracts/` (shared with backend tests) or in `web/`?
11. **Backend images for CI.** Does each backend publish a container (GHCR) the frontend's Playwright matrix can start as `services:`, or does the e2e run against deployed Render URLs (slow and flaky because of cold starts)?

## For the data pipeline owner

12. **Frame host and format.**
    - Host: a Hugging Face dataset (range plus CORS confirmed) or a separate Pages project (no range support, 20k-file cap, total-size acceptance unverified).
    - Format: `.tyf.gz`, WebP sprites, or both. The frontend loader supports all three behind a manifest, but one default keeps tests smaller.
    - Is segmenting long storms (≤ 7 days per file) still needed if the host supports range requests?
13. **Hugging Face limits.** Rate limits for anonymous `resolve` traffic, and whether a public dataset suits being a live CDN for a web app. Not verified.
14. **Static fallbacks.** Will the pipeline emit the per-province "storms that hit here" shards, the storm index with manifests, and OG PNGs?
15. **Track interpolation.** Will the pipeline emit hourly interpolated track points with provenance flags (observed fix vs interpolated, agency, averaging period), or should `src/data` interpolate?
16. **Names.** Will the storm index carry PAGASA local names (the crosswalk seed exists) and JMA 台風第N号 numbering? A source for the JMA numbering is not yet identified.
17. **Admin boundaries.** Which PH (PSGC ADM1–3) and JP (prefecture, municipality) boundary sources, simplified to vector tiles or GeoJSON, and their licences/attribution?

## For the owner

18. **Choose the stack:** A (static-first SPA, recommended), B (React Router 8 prerender, real storm HTML) or C (TanStack Start).
19. **SEO ambition.** Meta-only storm shells (A) or full prerendered summaries (B)?
20. **i18n library.** Lingui v6 (recommended) or keep Akari's `<T en ja>` for everything. Is Filipino in scope for v1? It does not fit Akari's two-language `<T>`.
21. **Public mock mode.** Expose `?backend=mock` on the live site as a demo (clearly labelled)?
22. **Keep-warm pings.** Accept cold starts as a feature to explain, or ping one backend to keep it warm? Render's terms on keep-alive pinging were not checked.
23. **Error tracking.** Sentry Developer or GlitchTip? Cloudflare Web Analytics needs a CSP entry.
24. **DuckDB-WASM "Explore (SQL)" page.** In or out of v1? It needs the wasm from jsDelivr (over Pages' 25 MiB file limit) plus a CSP change.
25. **Akari requirements.**
    - Akari's `maplibre-gl` peer is `>=3`; the app would use v6 (WebGL2, ESM-only). Confirm the Akari maps helpers and any map components are tested on v6.
    - Does Akari need a slider component that follows the APG pattern with `aria-valuetext`, or does the app build its own?

## Unverified facts to check during the spike

- Satori + resvg time per OG image (no benchmark found).
- React Router 8 build time for 3,076 prerendered paths against Pages' 20-minute build limit (Stack B only).
- An SSE pass-through on a free-plan Pages Function: does 10 ms of CPU suffice for long streams?
- Byte-exact lossless WebP decode through `createImageBitmap` and the WebGL upload in Chromium, Firefox and WebKit.
- `@sakitam-gis/maplibre-wind` on MapLibre v6. This only matters if hand-writing the particle layer is dropped.
- Sentry free tier figures (the pricing page may be cached), and whether Better Stack's free tier needs a card.
