// The API layer against the contract-typed MSW handlers (the same ones mock mode uses in the browser).
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { __resetBackends, displayHealth, initBackends, probeBackend, SLEEP_AFTER_MS } from "./backends";
import { ApiError } from "./client";
import { handlers } from "./mocks/handlers";
import { placeSearchQuery, placeStormsQuery, stormPlacesQuery } from "./queries";

const server = setupServer(...handlers);
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// "java" pointed at the mock base, so the node test never needs the browser service worker.
beforeEach(() => {
  __resetBackends();
  initBackends(
    [
      { id: "java", label: "Java", baseUrl: "http://localhost/api/mock" },
      { id: "go", label: "Go", baseUrl: "http://localhost/api/go" },
    ],
    "java",
  );
});

const run = <T,>(q: { queryFn?: unknown }) => (q.queryFn as (ctx: unknown) => Promise<T>)({} as never);

describe("API queries (mock handlers built from the contract examples)", () => {
  it("searches places and maps DTOs to domain types", async () => {
    const places = await run<{ id: string; name: string; centroid: number[] }[]>(placeSearchQuery("java", "tacloban"));
    expect(places.map((p) => p.id)).toEqual(["PH-0831600000"]);
    expect(places[0]!.centroid).toHaveLength(2);
    const naha = await run<{ nameJa?: string }[]>(placeSearchQuery("java", "那覇"));
    expect(naha[0]!.nameJa).toBe("那覇市");
  });

  it("lists storms that hit a place, closest first", async () => {
    const hits = await run<{ storm: { sid: string }; closestApproachKm: number }[]>(placeStormsQuery("java", "PH-0831600000", 100));
    expect(hits[0]!.storm.sid).toBe("2013306N07162");
    const km = hits.map((h) => h.closestApproachKm);
    expect([...km].sort((a, b) => a - b)).toEqual(km);
  });

  it("lists places a storm passed", async () => {
    const places = await run<unknown[]>(stormPlacesQuery("java", "2013306N07162"));
    expect(places.length).toBeGreaterThan(0);
  });

  it("raises problem+json errors with their code", async () => {
    await expect(run(placeSearchQuery("java", " "))).rejects.toMatchObject({ status: 400, code: "validation" });
  });

  it("treats an HTML page at the API path as 'not deployed'", async () => {
    server.use(...[(await import("msw")).http.get("*/api/go/*", () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } }))]);
    const err = await run(placeSearchQuery("go", "tacloban")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("not-deployed");
  });
});

describe("backend health", () => {
  it("probes /healthz: up with latency", async () => {
    const h = await probeBackend("java");
    expect(h.state).toBe("up");
    expect(h.ms).toBeGreaterThanOrEqual(0);
  });

  it("reports down when the path serves the SPA instead of an API", async () => {
    const html = (async () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } })) as typeof fetch;
    expect((await probeBackend("go", html)).state).toBe("down");
  });

  it("goes waking on a 503 cold start, then down when it never wakes", async () => {
    const busy = (async () => new Response("", { status: 503 })) as typeof fetch;
    const h = await probeBackend("go", busy, { wakeLimitMs: 0 });
    expect(h.state).toBe("down");
    expect(h.detail).toMatch(/did not wake/);
  });

  it("shows an old 'up' as asleep (free instances sleep after 15 minutes)", () => {
    const now = Date.now();
    expect(displayHealth({ state: "up", lastUpAt: now - SLEEP_AFTER_MS - 1 }, now)).toBe("asleep");
    expect(displayHealth({ state: "up", lastUpAt: now }, now)).toBe("up");
    expect(displayHealth(undefined)).toBe("asleep");
  });
});
