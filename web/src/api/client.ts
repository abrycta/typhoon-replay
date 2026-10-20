// The only place that talks HTTP to a backend. One openapi-fetch client per backend base URL.
// Auth model lives here and only here: cookie session through the same-origin proxy, so requests
// use credentials "same-origin" and unsafe methods add the contract's CSRF header.
import createClient, { type Client, type Middleware } from "openapi-fetch";

import type { BackendId } from "@/shared/config/config";

import type { paths } from "./generated/schema";
import { recordResponse } from "./info";

const clients = new Map<string, Client<paths>>();

const started = new Map<string, number>();

const timing: Middleware = {
  onRequest({ request, id }) {
    started.set(id, performance.now());
    if (!["GET", "HEAD"].includes(request.method)) request.headers.set("X-Requested-With", "typhoon-replay");
    return request;
  },
  onResponse({ response, id }) {
    const t0 = started.get(id) ?? performance.now();
    started.delete(id);
    recordResponse({
      impl: response.headers.get("X-Backend-Impl") ?? undefined,
      implVersion: response.headers.get("X-Backend-Version") ?? undefined,
      contractVersion: response.headers.get("X-Contract-Version") ?? undefined,
      requestId: response.headers.get("X-Request-Id") ?? undefined,
      status: response.status,
      ms: Math.round(performance.now() - t0),
      at: Date.now(),
    });
    // A static host answering with its SPA page: there is no API behind this path.
    if (response.ok && (response.headers.get("Content-Type") ?? "").includes("text/html")) {
      throw new ApiError("no API at this address", 404, "not-deployed");
    }
    return response;
  },
};

export function apiClient(baseUrl: string): Client<paths> {
  let c = clients.get(baseUrl);
  if (!c) {
    c = createClient<paths>({ baseUrl, credentials: "same-origin" });
    c.use(timing);
    clients.set(baseUrl, c);
  }
  return c;
}

/** Thrown for non-2xx responses; carries the RFC 9457 problem `code` when present. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly backend?: BackendId,
  ) {
    super(message);
  }
  /** Worth retrying: gateway errors and network failures, never 4xx. */
  get retriable() {
    return this.status === 0 || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

export async function unwrap<T>(
  p: Promise<{ data?: T; error?: unknown; response: Response }>,
  backend: BackendId,
): Promise<T> {
  let r: { data?: T; error?: unknown; response: Response };
  try {
    r = await p;
  } catch (e) {
    if (e instanceof ApiError) throw new ApiError(e.message, e.status, e.code, backend);
    throw new ApiError(e instanceof Error ? e.message : "network error", 0, "network", backend);
  }
  if (!r.response.ok || r.data === undefined) {
    const problem = (r.error ?? {}) as { code?: string; title?: string };
    throw new ApiError(problem.title ?? `HTTP ${r.response.status}`, r.response.status, problem.code, backend);
  }
  return r.data;
}
