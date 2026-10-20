# Go backend: open questions

These are open questions for the system architect (contracts/) and for the user. They come from the Go research of 2026-10-21. Most affect all four backends. Items marked **(Go)** are Go-specific.

## Contract and edge

1. **Does the OpenAPI 3.1 contract use constructs that Go generators handle poorly?** Examples are multi-type unions (`type: [string, number]` → `any` in oapi-codegen), `oneOf` without a discriminator, and `$ref` siblings. I suggest the contract avoid them where it can, or the Go side will need an Overlay. **(Go)** A day-1 spike will run oapi-codegen v2.8.0 and kin-openapi v0.151.0 on the real file.
2. **Does the Cloudflare Worker strip `/api/go` before forwarding?** And what is the contract's `servers` URL? This decides how the kin-openapi validator matches paths, and whether cookies use `Path=/api`.
3. **Who runs live-feed ingestion and alert fan-out?** If all four backends do it, that's four times the Neon CU-hours, four sets of feed requests and duplicate-email risk. Options:
   - (a) one shared ingestion job in the pipeline (GitHub Actions cron) writes to Neon, and the backends only read and push SSE;
   - (b) one designated backend;
   - (c) every backend, made idempotent with an `alert_deliveries` unique key.

   I prefer (a) for ingestion. Alerts should be (a), or (c) with the idempotency table defined in the shared migrations.
4. **Standards the conformance suite will assert byte-for-byte:**
   - problem `type` URIs and extension members (e.g. `errors[]` for validation);
   - rate-limit header flavour (`RateLimit`/`RateLimit-Policy` IETF draft vs `X-RateLimit-*`);
   - ETag strong vs weak, and how it's derived (body hash vs data version);
   - `Cache-Control` values per route;
   - cursor pagination shape (`next` cursor in body vs `Link` header);
   - SSE event names, `id:` semantics, `Last-Event-ID` replay depth and heartbeat interval.
5. **Is a realtime signal needed beyond polling?** Neon's pooled endpoint doesn't support `LISTEN/NOTIFY`. A direct connection holding `LISTEN` would likely keep the compute from suspending and burn the 100 CU-h/month free budget (0.25 CU × 744 h = 186 CU-h). The proposal is to poll only while at least one SSE client is connected. Please confirm this is acceptable latency (~60 s).

## Hosting budget

6. **Render free hours are per workspace (750 h/month).** Four always-on backends would need about 2,976 h. Options:
   - accept sleeping backends with a ~1 min cold start; the edge could show "waking the Go backend…";
   - split the services across separate Render accounts/workspaces (check the ToS);
   - keep only one backend warm.

   Also, should Render's health check path hit the DB? It shouldn't, because that would wake Neon. Should any keep-alive pinger exist at all?
7. **Neon budget across four backends plus ingestion:** do they share one Neon project (100 CU-h, 1 GB storage)? The ~580k storm-hours, plus the exposure tables and the PostGIS indexes, must fit in 1 GB. Someone should measure this.

## Accounts

8. **Session table shape** (needs the architect's sign-off):
   - columns: `token_hash bytea PK`, `user_id`, `created_at`, `expires_at`, `last_seen_at`, `user_agent?`, and maybe `data jsonb`;
   - idle vs absolute timeout;
   - whether the hash is SHA-256 of a 32-byte random token;
   - the cookie name, `Path` and `SameSite`.

   I recommend server-side sessions over signed tokens, for cross-backend continuity and simple revocation. **(Go)** The Go side will write a small session package over this table rather than use scs's gob-encoded `sessions` table.
9. **Account linking:** if the same verified email arrives from Google and GitHub, is it one user or two? All four backends must agree, so it belongs in the contract.
10. **OAuth app registration:** should there be one Google client and one GitHub OAuth app with a redirect URI per backend (`/api/{lang}/auth/{provider}/callback`), or one shared callback? GitHub apps created after 2026-08-03 need exact-match callbacks unless wildcard matching is enabled per URL. And who owns the client secrets in Render env vars?
11. **Email sender:** confirm Resend (free: 3,000/month, 100/day; SMTP on port 2587 works from Render free, which blocks 25/465/587) and a verified sending domain. Could the 100/day cap be hit by a big typhoon alerting many users? If so, the plan is a digest or batching.

## Go-specific

12. **(Go)** Should generated code (`internal/api`, `internal/db`) be committed? I recommend committing it, so `docker build` and `go build` need no generators, with a CI freshness check. The alternative is generating in the Docker build, which needs `contracts/` in the build context.
13. **(Go)** Is OpenTelemetry export wanted in prod, and to which free backend? (Grafana Cloud free has not been verified here.) Otherwise it stays opt-in via env.
14. **(Go)** Should the image build use Render's Dockerfile build or ko + GHCR? The Dockerfile is the default. ko would add a registry push and a GHCR token in Render.
15. **(Go)** Pin the PostGIS image tag once for Compose, testcontainers and conformance CI (e.g. a `postgis/postgis:<pg>-<postgis>` tag matching Neon's Postgres major version). What Postgres major will the Neon project use?
