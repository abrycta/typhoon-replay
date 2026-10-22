// Query allow-list (audit D3/A3). The backends drop query parameters the contract does not define
// (CONTRACT-GUIDE §5), so `?junk=1`, `?junk=2`, … would each be a fresh edge-cache miss sent to the origin. Reads keep
// only the parameters the contract defines for their path, before the cache key and the upstream URL are built.
// edge/test/query.test.ts checks this table against contracts/openapi.

/** Query parameters per contract path (`{x}` is one path segment). Paths not listed take no query parameters. */
export const CONTRACT_QUERY: Record<string, readonly string[]> = {
  "/v1/storms": ["q", "season", "from", "to", "basin", "country", "minWindKt", "sort", "cursor", "limit"],
  "/v1/storms/{sid}/places": ["radiusKm", "country", "cursor", "limit"],
  "/v1/places/search": ["q", "country", "limit"],
  "/v1/places/nearest": ["lat", "lon"],
  "/v1/places/{placeId}/storms": ["radiusKm", "minWindKt", "from", "to", "sort", "cursor", "limit"],
  "/v1/hits": ["lat", "lon", "radiusKm", "minWindKt", "from", "to", "sort", "cursor", "limit"],
  "/v1/live/stream": ["lastEventId"],
};

const TEMPLATES = Object.keys(CONTRACT_QUERY).map((t) => ({
  allowed: new Set(CONTRACT_QUERY[t]),
  re: new RegExp(`^${t.replace(/\{[^}]+\}/g, "[^/]+")}$`),
}));

/** The parameters the contract allows on a backend path (without the /api/{impl} prefix). */
export function allowedQuery(path: string): ReadonlySet<string> {
  return TEMPLATES.find((t) => t.re.test(path))?.allowed ?? new Set();
}

/**
 * The request with every query parameter the contract does not define for its path removed (all values of the
 * allowed ones kept, in order). Only GET and HEAD are rewritten; a request with nothing to drop is returned as is.
 */
export function contractQuery(request: Request): Request {
  if (request.method !== "GET" && request.method !== "HEAD") return request;
  const url = new URL(request.url);
  if (!url.search) return request;
  const path = url.pathname.replace(/^\/api\/[^/]+/, "");
  const allowed = allowedQuery(path);
  const kept = [...url.searchParams].filter(([name]) => allowed.has(name));
  if (kept.length === [...url.searchParams].length) return request;
  url.search = new URLSearchParams(kept).toString();
  return new Request(url.toString(), request);
}
