import { describe, expect, it } from "vitest";

import { bodyKey, matchStates, normaliseBody } from "./compare";
import { type ApiResult, classify, sendRequest } from "./request";
import { retryDecision, sendUntilAwake, WAKE_CAP_MS } from "./wake";

const res = (kind: ApiResult["kind"], extra: Partial<ApiResult> = {}): ApiResult => ({ kind, method: "GET", url: "/api/x/v1/meta", status: kind === "ok" ? 200 : 503, ms: 5, ...extra });

describe("race comparison", () => {
  it("ignores key order, number formatting, timestamp formatting and implementation fields", () => {
    const java = { items: [{ storm: { sid: "2013306N07162", startedAt: "2013-11-03T00:00:00Z", peakWindKt: 170 }, closestApproachKm: 35.0, hoursWithinRadius: 10 }], radiusKm: 100, nextCursor: "abc" };
    const node = { radiusKm: 100, items: [{ hoursWithinRadius: 10, closestApproachKm: 35.000000000001, storm: { peakWindKt: 170.0, startedAt: "2013-11-03T00:00:00.000Z", sid: "2013306N07162" } }] };
    expect(bodyKey(java)).toBe(bodyKey(node));
  });

  it("drops /v1/meta's identity and process start, but keeps a storm's startedAt", () => {
    const meta = (impl: string, startedAt: string) => ({ impl, implVersion: "0.1.0", commit: impl, startedAt, contractVersion: "2.0.0", datasetVersion: 1, schemaVersion: "3" });
    expect(bodyKey(meta("java", "2026-10-20T00:00:00Z"))).toBe(bodyKey(meta("rust", "2026-10-21T08:00:00Z")));
    expect(normaliseBody({ sid: "a", startedAt: "2013-11-03T00:00:00Z" })).toEqual({ sid: "a", startedAt: "2013-11-03T00:00:00Z" });
    expect(bodyKey({ sid: "a", startedAt: "2013-11-03T00:00:00Z" })).not.toBe(bodyKey({ sid: "a", startedAt: "2013-11-04T00:00:00Z" }));
  });

  it("still sees real differences: values, order of list items, missing items", () => {
    expect(bodyKey({ items: [1, 2] })).not.toBe(bodyKey({ items: [2, 1] }));
    expect(bodyKey({ km: 35 })).not.toBe(bodyKey({ km: 36 }));
    expect(bodyKey({ items: [{ a: 1 }] })).not.toBe(bodyKey({ items: [] }));
    // null and absent are the same (tolerant reader: optional fields may be omitted or null).
    expect(bodyKey({ a: 1, b: null })).toBe(bodyKey({ a: 1 }));
  });

  it("marks each answered lane same / differs / alone", () => {
    expect(matchStates({ java: { a: 1 } })).toEqual({ java: "alone" });
    expect(matchStates({ java: { a: 1 }, node: { a: 1.0 }, rust: { a: 2 } })).toEqual({ java: "same", node: "same", rust: "differs" });
    expect(matchStates({})).toEqual({});
  });
});

describe("retry policy", () => {
  it("waking: retries, honouring Retry-After, else backing off", () => {
    expect(retryDecision(res("waking", { retryAfterS: 20 }), 0, 0)).toEqual({ action: "retry", delayMs: 20_000 });
    expect(retryDecision(res("waking"), 0, 0)).toEqual({ action: "retry", delayMs: 2000 });
    expect(retryDecision(res("waking"), 0, 2)).toEqual({ action: "retry", delayMs: 4500 });
    // Retry-After 0 still waits a little; very long waits are clamped.
    expect(retryDecision(res("waking", { retryAfterS: 0 }), 0, 0)).toEqual({ action: "retry", delayMs: 1000 });
    expect(retryDecision(res("waking", { retryAfterS: 3600 }), 0, 0)).toEqual({ action: "retry", delayMs: 20_000 });
  });

  it("not deployed: stops at once, no retries", () => {
    expect(retryDecision(res("not-deployed"), 0, 0)).toEqual({ action: "stop", outcome: "not-deployed", reason: "not deployed" });
  });

  it("errors stop; the cap turns endless waking into an error", () => {
    expect(retryDecision(res("error", { status: 500, detail: "Internal" }), 0, 0)).toMatchObject({ action: "stop", outcome: "error", reason: "Internal" });
    expect(retryDecision(res("waking", { retryAfterS: 20 }), WAKE_CAP_MS - 10_000, 5)).toEqual({ action: "stop", outcome: "error", reason: "did not wake up in time" });
    expect(retryDecision(res("ok"), WAKE_CAP_MS * 2, 9)).toEqual({ action: "done" });
  });

  it("sendUntilAwake follows waking -> ok and reports the wake-up", async () => {
    const answers = [res("waking", { retryAfterS: 1 }), res("waking", { retryAfterS: 1 }), res("ok", { body: { ok: 1 }, ms: 80 })];
    let clock = 0;
    const slept: number[] = [];
    const progress: number[] = [];
    const out = await sendUntilAwake(async () => answers.shift()!, {
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
      onProgress: (p) => progress.push(p.attempt),
    });
    expect(out).toMatchObject({ outcome: "ok", attempts: 3, woke: true, totalMs: 2000 });
    expect(out.last.ms).toBe(80);
    expect(slept).toEqual([1000, 1000]);
    expect(progress).toEqual([1, 2]);
  });

  it("sendUntilAwake gives up at the cap, and never retries not-deployed", async () => {
    let clock = 0;
    let calls = 0;
    const capped = await sendUntilAwake(
      async () => {
        calls++;
        return res("waking", { retryAfterS: 20 });
      },
      { now: () => clock, sleep: async (ms) => void (clock += ms) },
    );
    expect(capped).toMatchObject({ outcome: "error", reason: "did not wake up in time", woke: true });
    expect(calls).toBe(10); // 9 waits of 20 s fit in 3 minutes
    calls = 0;
    const nd = await sendUntilAwake(async () => {
      calls++;
      return res("not-deployed");
    });
    expect(nd).toMatchObject({ outcome: "not-deployed", attempts: 1, woke: false });
    expect(calls).toBe(1);
  });
});

describe("response classification", () => {
  const problem = (code: string) => ({ type: "x", title: "t", status: 503, code });
  it("reads the edge's problem codes", () => {
    expect(classify(503, "application/problem+json", problem("backend-waking")).kind).toBe("waking");
    expect(classify(503, "application/problem+json", problem("backend-not-deployed")).kind).toBe("not-deployed");
    expect(classify(404, "application/problem+json", problem("unknown-backend")).kind).toBe("not-deployed");
    expect(classify(503, "application/problem+json", problem("static-mode")).kind).toBe("error");
    expect(classify(503, "application/problem+json", problem("backend-paused")).kind).toBe("paused");
    expect(retryDecision({ kind: "paused", status: 503 }, 0, 0)).toMatchObject({ action: "stop", outcome: "paused" });
    expect(classify(502, "text/plain", undefined).kind).toBe("waking");
    expect(classify(404, "application/problem+json", problem("not-found")).kind).toBe("error");
    expect(classify(200, "application/json", {}).kind).toBe("ok");
    // A static host's SPA page where the proxy should be.
    expect(classify(200, "text/html; charset=utf-8", undefined).kind).toBe("not-deployed");
  });

  it("sendRequest captures status, timing, Retry-After and the edge headers", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ type: "x", title: "Waking", status: 503, code: "backend-waking" }), {
        status: 503,
        headers: { "Content-Type": "application/problem+json", "Retry-After": "20", "X-Edge-Cache": "MISS", "X-Backend-Impl": "java" },
      })) as typeof fetch;
    const r = await sendRequest("/api/java/", "/v1/meta", { fetchImpl: f });
    expect(r).toMatchObject({ kind: "waking", url: "/api/java/v1/meta", status: 503, retryAfterS: 20, edgeCache: "MISS", impl: "java", problemCode: "backend-waking" });
    const down = await sendRequest("/api/go", "/v1/meta", { fetchImpl: (async () => Promise.reject(new TypeError("offline"))) as typeof fetch });
    expect(down).toMatchObject({ kind: "error", status: 0, detail: "offline" });
  });
});
