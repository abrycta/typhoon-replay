// The Worker's environment: the names every backend shares (CONTRACT-GUIDE §11, DECISIONS "Worker conventions").
export interface Env {
  /** Neon pooled URL (a Worker secret). */
  DATABASE_URL?: string;
  /** Optional SQL-over-HTTP endpoint; local runs and CI use Neon's open-source proxy (http://localhost:4444/sql). */
  NEON_HTTP_URL?: string;
  /** Browser-visible origin for Link headers, e.g. https://replay.krtmtthw.dev. */
  TR_SITE_ORIGIN?: string;
  /** "1" enables POST /v1/_test/live-events. */
  TR_TEST_HOOKS?: string;
  /** "0" turns the per-IP limit off (CI); any other value keeps the RATE_LIMITER binding's limit. */
  TR_RATE_LIMIT_PER_MINUTE?: string;
  /** Shared with the edge proxy: proves X-Forwarded-For (a Worker secret). */
  TR_EDGE_SECRET?: string;
  /** Git commit of the deployed build (wrangler deploy --var TR_COMMIT:sha). */
  TR_COMMIT?: string;
  /** Workers rate limiting binding (namespace 1002, 600 per 60 s). */
  RATE_LIMITER?: RateLimit;
}
