# Node backend: open questions

Each entry says who decides it ("architect" = `contracts/` owner) and my default if nobody does.

## For the system architect (affects all four backends)

1. **Render's 750 free instance-hours are shared per workspace.**
   - Four always-on backends would need about 2,920 h/month.
   - Options:
     - one Render workspace (account) per backend, if the terms allow it;
     - accept sleep, so each backend wakes on demand with a ~60 s cold start;
     - keep only the "default" backend warm.
   - *Default:* accept sleep and show a "waking the Node backend…" state in the UI.
2. **Who ingests the live feeds?**
   - Every backend sharing one ingestion lock or lease, or one designated ingestor?
   - Is the trigger the Worker cron (5 per account on free) or GitHub Actions `schedule`?
   - *Default:* each backend implements it behind `POST /internal/jobs/ingest-live`; a transaction-scoped advisory lock plus idempotent upserts make duplicates harmless; one Worker cron round-robins or calls only the active backend.
3. **The live event id and revision model.** I assume a monotonic `live_revisions.revision` (bigint) that doubles as the SSE `id:` for `Last-Event-ID` replay. The contract should define the event names, payloads and the replay window.
4. **Session table shape and cookie.**
   - Proposed tables: `sessions(id = sha256(token) bytea/text PK, user_id, created_at, expires_at, last_seen_at, user_agent?)`.
   - Proposed cookie: name `__Host-tr_session`, `SameSite=Lax`.
   - Still to decide:
     - the sliding-expiry rule (for example, a 30-day TTL refreshed when less than 15 days remain);
     - whether all four backends write `last_seen_at`.
   - I prefer server-side sessions over signed tokens (see ARCHITECTURE-RESEARCH §6).
5. **OAuth redirect URIs.** One callback per backend (`/api/{lang}/auth/{provider}/callback`), or one canonical path that the Worker routes to the backend that started the flow? Google and GitHub OAuth apps need every URI registered, and GitHub OAuth Apps allow only **one** callback URL per app. So either four GitHub apps, a GitHub App (which allows multiple), or a canonical path. *Default:* a canonical `/api/auth/{provider}/callback` that the Worker routes by a `tr_impl` value in the `state` cookie.
6. **Trusting the client IP.** The Worker should add `CF-Connecting-IP` plus a shared-secret header (for example `X-Edge-Auth`). Backends trust the IP only when the secret matches. Should rate limits be global (in the Worker) or per backend?
7. **Rate-limit header format.** IETF `RateLimit` / `RateLimit-Policy` (draft) or the legacy `X-RateLimit-*`? Do 429 responses use problem+json with a `retryAfter` extension?
8. **ETag strategy.** A dataset-version ETag (cheap 304 without a DB query) or a body hash? Should all backends produce **byte-identical** ETags for the same resource, so the edge cache is shared?
9. **Migration runner.** Who applies `contracts/migrations` to Neon, and with which tool (a language-neutral one such as dbmate, Atlas or plain `psql` in CI)? Node assumes it never runs DDL in production. Migrations should use Neon's **direct** endpoint, not the pooler.
10. **Postgres and PostGIS versions.** Pin the local and Testcontainers image (`postgis/postgis:17-3.6` or `18-3.6`) to Neon's project version.
11. **E-mail provider for production.** Render free blocks SMTP ports 25/465/587, so all four backends need an HTTPS mail API.
    - Resend (3,000/month, 100/day) needs a verified **domain**. Does the project own one?
    - Brevo (300/day) might allow single-sender verification; this is unverified.
    - Also decide the sender address and the unsubscribe/one-click-unsubscribe requirement.
12. **Health endpoints.** `/healthz` must not touch the DB (Render's health checks would keep Neon awake and burn the 100 CU-hours). Is `/readyz` with a DB check in the contract, and outside `/api/<lang>`?
13. **Observability backend.** Is there a free, no-card OTLP target that all four backends export to, or logs only? Not researched here.

## Node-specific, to verify during the spike

14. **fastify-openapi-glue and OpenAPI 3.1 edge cases.** It says it supports v3 and links to a 2020-12 guide. Test with our actual contract:
    - `type: [..., "null"]`, `const`, `oneOf` with discriminator, `$ref` siblings;
    - whether fast-json-stringify serialises those constructs correctly.
15. **@fastify/sse is 0.x.**
    - Load-test reconnect and `Last-Event-ID` replay through the Cloudflare Worker proxy, and check that nothing buffers `text/event-stream`.
    - Keep the hand-rolled fallback ready.
16. **Does an open SSE stream keep a Render free service awake?** Render counts "inbound traffic"; long-lived outbound streams are undocumented. Measure it.
17. **Cold-start budget at 0.1 CPU.** Measure:
    - process start;
    - Ajv compilation of the bundled spec;
    - the first query after Neon resumes.
    Decide between tsdown bundling all dependencies and keeping them external.
18. **RSS on 512 MB.** Measure idle and loaded RSS with 50 SSE clients and a large exposure search, then tune `--max-old-space-size` and the pool size.
19. **TypeScript 6.0 vs 7.0.** typescript-eslint 8.72 caps TS below 6.1. Revisit when it supports TS 7 (expected with the TS 7.1 programmatic API).
20. **kysely-codegen against PostGIS types.** Confirm how `geography`/`geometry` columns come out (probably `unknown` or `string`) and add a type override in its config.
21. **Distroless tag.** `gcr.io/distroless/nodejs24-debian13` is listed in the README; check that a `:nonroot` variant exists for nodejs24-debian13 before relying on it.
22. **Active-storm feed sources.** Which feeds (JTWC, JMA, PAGASA, GDACS), their formats, terms and polling etiquette. Shared with the other backends; probably the architect's or a data agent's job.
23. **Bilingual e-mail templates.** EN only, or EN/JA (and Filipino)? This affects the template approach.
