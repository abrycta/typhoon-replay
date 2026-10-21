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
  /** The backend is asleep or starting (edge `backend-waking`, gateway 502/503/504, 429): worth retrying. */
  | "waking"
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
  /** Retry-After in seconds, when sent. */
  retryAfterS?: number;
  /** RFC 9457 `code` of a problem response. */
  problemCode?: string;
  /** Parsed JSON body (problem bodies included), undefined for non-JSON. */
  body?: unknown;
  detail?: string;
}

const WAKING_CODES = new Set(["backend-waking", "backend-unavailable", "bad-gateway", "gateway-timeout", "rate-limited"]);
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
  if (problemCode && WAKING_CODES.has(problemCode)) return { kind: "waking", problemCode };
  if (problemCode === "static-mode") return { kind: "error", problemCode };
  // A static host answering /api/* with its SPA page: there is no API behind this address.
  if (contentType.includes("text/html") && (status === 200 || status === 404)) return { kind: "not-deployed", problemCode };
  if (status === 502 || status === 503 || status === 504 || status === 429) return { kind: "waking", problemCode };
  if (status >= 200 && status < 300 && contentType.includes("json")) return { kind: "ok" };
  return { kind: "error", problemCode };
}

export interface SendOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Fetch priority hint (the wake-up ping uses "low"). */
  priority?: "high" | "low" | "auto";
}

/** GET `path` from the backend at `baseUrl` (e.g. "/api/java"). Never throws, except when aborted. */
export async function sendRequest(baseUrl: string, path: ApiPath, opts: SendOptions = {}): Promise<ApiResult> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const f = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const t0 = performance.now();
  let res: Response;
  try {
    res = await f(url, { method: "GET", headers: { Accept: "application/json" }, credentials: "omit", cache: "no-store", signal: opts.signal, priority: opts.priority } as RequestInit);
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    return { kind: "error", method: "GET", url, status: 0, ms: Math.round(performance.now() - t0), detail: e instanceof Error ? e.message : "network error" };
  }
  const contentType = res.headers.get("Content-Type") ?? "";
  let body: unknown;
  let detail: string | undefined;
  if (contentType.includes("json")) {
    try {
      body = await res.json();
    } catch {
      detail = "invalid JSON";
    }
  } else {
    await res.text().catch(() => "");
  }
  const ms = Math.round(performance.now() - t0);
  const { kind, problemCode } = classify(res.status, contentType, body);
  const out: ApiResult = { kind: detail ? "error" : kind, method: "GET", url, status: res.status, ms };
  const impl = res.headers.get("X-Backend-Impl");
  const edgeCache = res.headers.get("X-Edge-Cache");
  const ra = retryAfter(res.headers.get("Retry-After"));
  if (impl) out.impl = impl;
  if (edgeCache) out.edgeCache = edgeCache;
  if (ra !== undefined) out.retryAfterS = ra;
  if (problemCode) out.problemCode = problemCode;
  if (body !== undefined) out.body = body;
  if (detail) out.detail = detail;
  else if (kind === "error" && !res.ok) out.detail = (body as { title?: string } | undefined)?.title ?? `HTTP ${res.status}`;
  return out;
}
