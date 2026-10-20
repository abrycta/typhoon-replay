// Test harness: a fake origin behind global fetch, fresh site hosts per test (so caches.default never leaks
// between tests), and helpers to call the proxy the way Pages does.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, vi } from "vitest";

import { cacheKey, store } from "../src/cache";
import { __resetEnvMemo, type Env } from "../src/env";
import { handleProxy } from "../src/proxy";
import { __resetProxyState } from "../src/proxy";
import { __resetBuckets } from "../src/ratelimit";

export const ORIGIN = "https://java.origin.test";
export type Handler = (req: Request) => Response | Promise<Response>;

export interface Harness {
  site: string;
  calls: Request[];
  env: Env;
  setOrigin(h: Handler): void;
  call(path: string, init?: RequestInit, envOverride?: Partial<Env>): Promise<{ res: Response; settle: () => Promise<void> }>;
  seed(path: string, body: unknown, headers: Record<string, string>, ageS: number, reqHeaders?: Record<string, string>): Promise<void>;
}

let n = 0;

export function harness(): Harness {
  __resetEnvMemo();
  __resetBuckets();
  __resetProxyState();
  const site = `https://site-${++n}-${crypto.randomUUID().slice(0, 8)}.test`;
  const calls: Request[] = [];
  let handler: Handler = () => json({ ok: true });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (!req.url.startsWith(ORIGIN + "/")) throw new Error(`unexpected upstream ${req.url}`);
    calls.push(req);
    if (req.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return handler(req);
  });
  const env: Env = { BACKEND_ORIGINS: JSON.stringify({ java: ORIGIN }) };
  return {
    site,
    calls,
    env,
    setOrigin: (h) => (handler = h),
    async call(path, init = {}, envOverride = {}) {
      const ctx = createExecutionContext();
      const headers = new Headers(init.headers);
      if (!headers.has("CF-Connecting-IP")) headers.set("CF-Connecting-IP", "203.0.113.7");
      const res = await handleProxy(new Request(site + path, { ...init, headers }), { ...env, ...envOverride }, ctx);
      return { res, settle: () => waitOnExecutionContext(ctx) };
    },
    async seed(path, body, headers, ageS, reqHeaders = {}) {
      const key = cacheKey(new Request(site + path, { headers: reqHeaders }));
      const res = json(body, { headers });
      await store(caches.default, key, res, 7 * 86_400, Date.now() - ageS * 1000);
    },
  };
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export const CATALOGUE = {
  "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
  ETag: 'W/"d7-abc"',
  Vary: "Accept-Encoding",
  "X-Backend-Impl": "java",
};

/** Resolve after `ms`, or reject as fetch does when the request's signal aborts. */
export function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

export async function problemOf(res: Response): Promise<{ code: string; status: number; requestId: string; type: string }> {
  expect(res.headers.get("Content-Type")).toBe("application/problem+json");
  return res.json();
}
