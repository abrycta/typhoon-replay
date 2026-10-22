// The only place that talks HTTP to a backend. Requests go through the same-origin edge proxy
// (/api/{impl}/..., edge/README.md); every answer is classified with the edge's problem codes.
import type { paths } from "./generated/schema";

/** A contract path with its parameters filled in, e.g. "/v1/storms/2013306N07162", or "/healthz". */
export type ApiPath = string;
/** The contract's GET paths (templates), for typing the request catalogue. */
export type ContractPath = keyof paths;

export type ResultKind =
  /** 2xx JSON from a backend. */
  | "ok"
  /** The backend is asleep or starting (edge `backend-waking`, gateway 502/503/504): worth retrying. */
  | "waking"
  /** Too many requests from this address (429 / `rate-limited`): not a sleeping backend; try again after Retry-After. */
  | "rate-limited"
  /** No backend behind this route (edge `backend-not-deployed` / `unknown-backend`, or a static host's HTML). */
  | "not-deployed"
  /** The backend is paused until next month to stay within its free hosting hours (edge `backend-paused`). */
  | "paused"
  /** Anything else: a 4xx/5xx problem, a network failure, an unexpected body. Not retried. */
  | "error";

export interface ApiResult {
  kind: ResultKind;
  method: "GET";
  url: string;
  status: number;
  /** Round-trip time of this request in milliseconds. */
  ms: number;
  /** X-Backend-Impl: which implementation answered (passed through the edge). */
  impl?: string;
  /** X-Edge-Cache: HIT | MISS | STALE | BYPASS. */
  edgeCache?: string;
  /** Age (seconds) of an answer served from the edge cache. */
  ageS?: number;
  /** X-Edge-Bypass, for a request sent with `bypassCache`: origin | limited | static-mode. */
  bypass?: string;
  /** Retry-After in seconds, when sent. */
  retryAfterS?: number;
  /** RFC 9457 `code` of a problem response. */
  problemCode?: string;
  /** Parsed JSON body (problem bodies included), undefined for non-JSON. */
  body?: unknown;
  detail?: string;
  /** True when no complete answer arrived within the request's timeout (`detail` is then {@link TIMEOUT_DETAIL}). */
  timedOut?: boolean;
}

/**
 * Per-request deadline. The edge always answers within about 8 s (its origin timeout), even for a sleeping
 * backend, so anything slower is a stalled connection (a mobile hand-off, a proxy), not a slow backend.
 */
export const REQUEST_TIMEOUT_MS = 15_000;
/** `detail` (and the lane's reason) of a request that hit its deadline. */
export const TIMEOUT_DETAIL = "timed out";

const WAKING_CODES = new Set(["backend-waking", "backend-unavailable", "bad-gateway", "gateway-timeout"]);
const NOT_DEPLOYED_CODES = new Set(["backend-not-deployed", "unknown-backend"]);

function retryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, Math.round((at - Date.now()) / 1000)) : undefined;
}

/** Classify a response (exported for tests). */
export function classify(status: number, contentType: string, body: unknown): { kind: ResultKind; problemCode?: string } {
  const code = typeof (body as { code?: unknown } | undefined)?.code === "string" ? (body as { code: string }).code : undefined;
  const problemCode = status >= 400 ? code : undefined;
  if (problemCode && NOT_DEPLOYED_CODES.has(problemCode)) return { kind: "not-deployed", problemCode };
  if (problemCode === "backend-paused") return { kind: "paused", problemCode };
  if (problemCode === "rate-limited" || status === 429) return { kind: "rate-limited", problemCode };
  if (problemCode && WAKING_CODES.has(problemCode)) return { kind: "waking", problemCode };
  if (problemCode === "static-mode") return { kind: "error", problemCode };
  // A static host answering /api/* with its SPA page: there is no API behind this address.
  if (contentType.includes("text/html") && (status === 200 || status === 404)) return { kind: "not-deployed", problemCode };
  if (status === 502 || status === 503 || status === 504) return { kind: "waking", problemCode };
  if (status >= 200 && status < 300 && contentType.includes("json")) return { kind: "ok" };
  return { kind: "error", problemCode };
}

export interface SendOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Fetch priority hint (the wake-up ping uses "low"). */
  priority?: "high" | "low" | "auto";
  /** Deadline for the whole request, body included (default {@link REQUEST_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Ask the edge to skip its cache and reach the backend (budgeted at the edge; edge/README.md "Cache bypass"). */
  bypassCache?: boolean;
}

/**
 * GET `path` from the backend at `baseUrl` (e.g. "/api/java"). Never throws, except when `opts.signal` aborts.
 * A request with no complete answer within `timeoutMs` is aborted and returned as an `error` with `timedOut`.
 */
export async function sendRequest(baseUrl: string, path: ApiPath, opts: SendOptions = {}): Promise<ApiResult> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const f = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const outer = opts.signal;
  if (outer?.aborted) throw outer.reason ?? new DOMException("Aborted", "AbortError");
  // One controller per request, aborted by the caller's signal or by the deadline.
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort(outer?.reason);
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(new DOMException(TIMEOUT_DETAIL, "TimeoutError"));
  }, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const fail = (e: unknown): ApiResult => {
    if (outer?.aborted) throw e;
    if (timedOut) return { kind: "error", method: "GET", url, status: 0, ms: elapsed(), detail: TIMEOUT_DETAIL, timedOut: true };
    return { kind: "error", method: "GET", url, status: 0, ms: elapsed(), detail: e instanceof Error ? e.message : "network error" };
  };
  try {
    let res: Response;
    try {
      res = await f(url, { method: "GET", headers: { Accept: "application/json", ...(opts.bypassCache ? { "X-Edge-Bypass": "origin" } : {}) }, credentials: "omit", cache: "no-store", signal: ctrl.signal, priority: opts.priority } as RequestInit);
    } catch (e) {
      return fail(e);
    }
    const contentType = res.headers.get("Content-Type") ?? "";
    let body: unknown;
    let detail: string | undefined;
    if (contentType.includes("json")) {
      try {
        body = await res.json();
      } catch (e) {
        if (ctrl.signal.aborted) return fail(e);
        detail = "invalid JSON";
      }
    } else {
      await res.text().catch(() => "");
      if (ctrl.signal.aborted) return fail(ctrl.signal.reason);
    }
    const ms = elapsed();
    const { kind, problemCode } = classify(res.status, contentType, body);
    const out: ApiResult = { kind: detail ? "error" : kind, method: "GET", url, status: res.status, ms };
    const impl = res.headers.get("X-Backend-Impl");
    const edgeCache = res.headers.get("X-Edge-Cache");
    const ra = retryAfter(res.headers.get("Retry-After"));
    if (impl) out.impl = impl;
    if (edgeCache) out.edgeCache = edgeCache;
    const age = Number(res.headers.get("Age") ?? "");
    if (res.headers.has("Age") && Number.isFinite(age)) out.ageS = age;
    const bypass = res.headers.get("X-Edge-Bypass");
    if (bypass) out.bypass = bypass;
    if (ra !== undefined) out.retryAfterS = ra;
    if (problemCode) out.problemCode = problemCode;
    if (body !== undefined) out.body = body;
    if (detail) out.detail = detail;
    else if (kind === "error" && !res.ok) out.detail = (body as { title?: string } | undefined)?.title ?? `HTTP ${res.status}`;
    return out;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}
