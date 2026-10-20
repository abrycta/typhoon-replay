// HTTP helpers: header hygiene, request ids and RFC 9457 problem responses generated at the edge.

/** Same base as the backends' problems (CONTRACT-GUIDE §8). */
export const PROBLEM_BASE = "https://typhoon-replay.pages.dev/problems/";

/**
 * Edge problem codes. 413/429/404/405 reuse the contract's codes; the rest are proxy-only (kebab-case like the
 * contract's ProblemCode, which clients read tolerantly).
 */
export const EDGE_PROBLEMS = {
  "not-found": [404, "Not found"],
  "unknown-backend": [404, "Unknown backend"],
  "backend-not-deployed": [503, "Backend not deployed"],
  "method-not-allowed": [405, "Method not allowed"],
  "payload-too-large": [413, "Payload too large"],
  "rate-limited": [429, "Too many requests"],
  "backend-waking": [503, "Backend is waking up"],
  "backend-unavailable": [503, "Backend unavailable"],
  "static-mode": [503, "API in static mode"],
  "bad-gateway": [502, "Bad gateway"],
  "gateway-timeout": [504, "Gateway timeout"],
} as const satisfies Record<string, readonly [number, string]>;
export type EdgeProblemCode = keyof typeof EDGE_PROBLEMS;

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Echo a valid inbound X-Request-Id, otherwise mint a UUIDv7 (same rule as the backends, §4). */
export function requestIdFor(request: Request): string {
  const inbound = request.headers.get("X-Request-Id");
  return inbound && REQUEST_ID.test(inbound) ? inbound : uuidv7();
}

export function uuidv7(now = Date.now()): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let ts = now;
  for (let i = 5; i >= 0; i--) {
    b[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function problem(
  code: EdgeProblemCode,
  opts: { requestId: string; instance?: string; detail?: string; retryAfter?: number; headers?: HeadersInit },
): Response {
  const [status, title] = EDGE_PROBLEMS[code];
  const body: Record<string, unknown> = { type: PROBLEM_BASE + code, title, status, code, requestId: opts.requestId };
  if (opts.detail) body.detail = opts.detail;
  if (opts.instance) body.instance = opts.instance;
  const headers = new Headers(opts.headers);
  headers.set("Content-Type", "application/problem+json");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Request-Id", opts.requestId);
  if (opts.retryAfter !== undefined) headers.set("Retry-After", String(Math.max(1, Math.ceil(opts.retryAfter))));
  return new Response(JSON.stringify(body), { status, headers });
}

/** RFC 9110 §7.6.1 hop-by-hop headers, never forwarded in either direction. */
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization"];

/**
 * Request headers forwarded to a backend (allow-list). Everything else is dropped, notably every `cf-*` header,
 * client-supplied `x-forwarded-*`, analytics/tracing headers and `accept-encoding` (the runtime negotiates
 * compression with the origin itself).
 */
const FORWARD_REQUEST = [
  "accept",
  "accept-language",
  "authorization",
  "content-type",
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
  "last-event-id",
  "origin",
  "referer",
  "user-agent",
  "x-request-id",
  "x-requested-with",
];

/** Only the app's own `__Host-tr_*` cookies (the session) reach a backend; Cloudflare/analytics cookies never do. */
export const SESSION_COOKIE_PREFIX = "__Host-tr_";

export function filterCookie(header: string | null): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c.startsWith(SESSION_COOKIE_PREFIX));
  return kept.length ? kept.join("; ") : undefined;
}

export function hasSessionCookie(request: Request): boolean {
  return filterCookie(request.headers.get("Cookie")) !== undefined;
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
}

export function upstreamHeaders(request: Request, opts: { impl: string; requestId: string; dropConditional?: boolean }): Headers {
  const src = request.headers;
  const out = new Headers();
  for (const name of FORWARD_REQUEST) {
    if (opts.dropConditional && name.startsWith("if-")) continue;
    const v = src.get(name);
    if (v !== null) out.set(name, v);
  }
  const cookie = filterCookie(src.get("Cookie"));
  if (cookie) out.set("Cookie", cookie);
  const url = new URL(request.url);
  out.set("X-Request-Id", opts.requestId);
  out.set("X-Forwarded-Host", url.host);
  out.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
  out.set("X-Forwarded-Prefix", `/api/${opts.impl}`);
  const ip = src.get("CF-Connecting-IP")?.trim();
  if (ip) out.set("X-Forwarded-For", ip);
  return out;
}

/** Origin/CDN headers that describe the backend's host rather than the resource. */
const DROP_RESPONSE = ["alt-svc", "cf-ray", "cf-cache-status", "nel", "report-to", "server", "x-render-origin-server", "rndr-id"];

/** Copy response headers minus hop-by-hop and host-identifying ones. Set-Cookie is kept unchanged (same origin). */
export function downstreamHeaders(upstream: Headers): Headers {
  const out = new Headers(upstream);
  const connection = upstream.get("connection");
  const extra = connection ? connection.split(",").map((s) => s.trim().toLowerCase()) : [];
  for (const name of [...HOP_BY_HOP, ...DROP_RESPONSE, ...extra]) out.delete(name);
  return out;
}

/** Weak comparison (RFC 9110 §8.8.3.2) of an If-None-Match list against an ETag. */
export function etagMatches(ifNoneMatch: string | null, etag: string | null): boolean {
  if (!ifNoneMatch || !etag) return false;
  if (ifNoneMatch.trim() === "*") return true;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  const target = strip(etag);
  return ifNoneMatch.split(",").some((t) => strip(t) === target);
}
