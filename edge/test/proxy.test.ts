import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseCacheControl } from "../src/cache";
import { parseOrigins } from "../src/env";
import { etagMatches, uuidv7 } from "../src/http";
import { MAX_BODY_BYTES } from "../src/proxy";
import { CATALOGUE, delay, type Harness, harness, json, ORIGIN, problemOf } from "./helpers";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("routing and path rewrite", () => {
  it("strips /api/{impl} and keeps the query", async () => {
    const { res } = await h.call("/api/java/v1/storms?season=2013&limit=5");
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url).toBe(`${ORIGIN}/v1/storms?season=2013&limit=5`);
    expect(res.headers.get("X-Edge-Route")).toBe("java");
  });

  it("maps /healthz and /readyz to the backend root", async () => {
    await h.call("/api/java/healthz");
    await h.call("/api/java/readyz");
    expect(h.calls.map((c) => c.url)).toEqual([`${ORIGIN}/healthz`, `${ORIGIN}/readyz`]);
  });

  it("preserves method and body", async () => {
    h.setOrigin(async (req) => json({ method: req.method, body: await req.text() }, { status: 201 }));
    const { res } = await h.call("/api/java/v1/me/places", {
      method: "POST",
      body: JSON.stringify({ placeId: "PH-0837000000" }),
      headers: { "Content-Type": "application/json", "X-Requested-With": "typhoon-replay", Origin: "https://typhoon.krtmtthw.dev" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ method: "POST", body: '{"placeId":"PH-0837000000"}' });
    expect(h.calls[0]!.headers.get("Origin")).toBe("https://typhoon.krtmtthw.dev");
    expect(h.calls[0]!.headers.get("X-Requested-With")).toBe("typhoon-replay");
  });

  it("passes redirects through instead of following them (OAuth login)", async () => {
    h.setOrigin(() => new Response(null, { status: 302, headers: { Location: "https://github.com/login/oauth/authorize?x=1", "Cache-Control": "no-store" } }));
    const { res } = await h.call("/api/java/v1/auth/github/login?returnTo=/town");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://github.com/login/oauth/authorize?x=1");
    expect(h.calls[0]!.redirect).toBe("manual");
  });

  it("unknown impl → 404 unknown-backend, origin untouched", async () => {
    const { res } = await h.call("/api/cobol/v1/storms");
    expect(res.status).toBe(404);
    expect((await problemOf(res)).code).toBe("unknown-backend");
    expect(h.calls).toHaveLength(0);
  });

  it("known but unconfigured impl → 503 backend-not-deployed", async () => {
    const { res } = await h.call("/api/node/v1/storms");
    expect(res.status).toBe(503);
    const p = await problemOf(res);
    expect(p.code).toBe("backend-not-deployed");
    expect(p.requestId).toBe(res.headers.get("X-Request-Id"));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("refuses paths outside the contract's roots (no open proxy)", async () => {
    for (const p of ["/api/java/", "/api/java", "/api/java/admin", "/api/java/v2/x", "/api/java/%2F%2Fevil.test/v1", "/api/"]) {
      const { res } = await h.call(p);
      expect(res.status, p).toBe(404);
    }
    // dot segments are resolved by the URL parser before routing
    const { res } = await h.call("/api/java/v1/../../node/v1/storms");
    expect(res.status).toBe(503); // became /api/node/v1/storms, which is not configured
    expect(h.calls).toHaveLength(0);
  });

  it("rejects unsupported methods", async () => {
    const { res } = await h.call("/api/java/v1/storms", { method: "TRACE" });
    expect(res.status).toBe(405);
  });
});

describe("origin map", () => {
  it("keeps only http(s) origins of known impls, reduced to scheme://host", () => {
    const m = parseOrigins(
      JSON.stringify({
        java: "https://a.test/some/path?q=1",
        node: "ftp://b.test",
        rust: "javascript:alert(1)",
        go: "http://localhost:8084",
        evil: "https://evil.test",
      }),
    );
    expect([...m]).toEqual([
      ["java", "https://a.test"],
      ["go", "http://localhost:8084"],
    ]);
    expect(parseOrigins("not json").size).toBe(0);
    expect(parseOrigins({ java: "https://obj.test" }).get("java")).toBe("https://obj.test");
  });
});

describe("header hygiene", () => {
  it("forwards safe headers, sets X-Forwarded-*, filters cookies and drops cf-*/hop-by-hop", async () => {
    await h.call("/api/java/v1/me", {
      headers: {
        "CF-Connecting-IP": "198.51.100.9",
        "CF-Ray": "abc",
        "CF-IPCountry": "PH",
        "X-Forwarded-For": "1.2.3.4",
        Cookie: "__cf_bm=xyz; _ga=GA1.1; __Host-tr_session=tok123; cf_clearance=zzz",
        Connection: "keep-alive",
        "Keep-Alive": "timeout=5",
        "Accept-Encoding": "br",
        Accept: "application/json",
        "X-Request-Id": "req-1",
        "Last-Event-ID": "7",
        "User-Agent": "test-agent",
      },
    });
    const up = h.calls[0]!.headers;
    expect(up.get("X-Forwarded-For")).toBe("198.51.100.9");
    expect(up.get("X-Forwarded-Host")).toBe(new URL(h.site).host);
    expect(up.get("X-Forwarded-Proto")).toBe("https");
    expect(up.get("X-Forwarded-Prefix")).toBe("/api/java");
    expect(up.get("Cookie")).toBe("__Host-tr_session=tok123");
    expect(up.get("X-Request-Id")).toBe("req-1");
    expect(up.get("User-Agent")).toBe("test-agent");
    expect(up.get("Accept")).toBe("application/json");
    for (const name of ["CF-Ray", "CF-IPCountry", "Connection", "Keep-Alive", "Accept-Encoding", "CF-Connecting-IP"]) expect(up.has(name), name).toBe(false);
  });

  it("proves itself to the backend with EDGE_SECRET, never forwarding a client's copy", async () => {
    await h.call("/api/java/v1/storms", { headers: { "X-Edge-Secret": "guess" } });
    expect(h.calls[0]!.headers.has("X-Edge-Secret")).toBe(false);
    await h.call("/api/java/v1/storms?season=2013", { headers: { "X-Edge-Secret": "guess", "CF-Connecting-IP": "198.51.100.9" } }, { EDGE_SECRET: "s3cret" });
    expect(h.calls[1]!.headers.get("X-Edge-Secret")).toBe("s3cret");
    expect(h.calls[1]!.headers.get("X-Forwarded-For")).toBe("198.51.100.9");
  });

  it("drops a cookie header that holds no session cookie", async () => {
    await h.call("/api/java/v1/storms", { headers: { Cookie: "__cf_bm=1; _ga=2" } });
    expect(h.calls[0]!.headers.has("Cookie")).toBe(false);
  });

  it("mints a UUIDv7 request id when the inbound one is invalid", async () => {
    await h.call("/api/java/healthz", { headers: { "X-Request-Id": "bad id with spaces" } });
    expect(h.calls[0]!.headers.get("X-Request-Id")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidv7()).toMatch(/-7/);
  });

  it("strips hop-by-hop and origin-host headers, keeps Set-Cookie and X-Backend-Impl", async () => {
    h.setOrigin(() => {
      const headers = new Headers({ "Cache-Control": "private, no-store", "X-Backend-Impl": "java", Server: "render", "Alt-Svc": "h3", Connection: "close, X-Secret", "X-Secret": "1", "Keep-Alive": "x" });
      headers.append("Set-Cookie", "__Host-tr_session=new; Path=/; Secure; HttpOnly; SameSite=Lax");
      headers.append("Set-Cookie", "other=1; Path=/");
      return json({}, { headers });
    });
    const { res } = await h.call("/api/java/v1/me", { headers: { Cookie: "__Host-tr_session=old" } });
    expect(res.headers.get("X-Backend-Impl")).toBe("java");
    expect(res.headers.getSetCookie()).toEqual(["__Host-tr_session=new; Path=/; Secure; HttpOnly; SameSite=Lax", "other=1; Path=/"]);
    for (const name of ["Server", "Alt-Svc", "Connection", "X-Secret", "Keep-Alive"]) expect(res.headers.has(name), name).toBe(false);
    expect(res.headers.get("X-Edge-Cache")).toBe("BYPASS");
    expect(res.headers.get("Server-Timing")).toMatch(/^edge;dur=\d+/);
  });
});

describe("edge cache", () => {
  it("MISS then HIT without touching the origin", async () => {
    h.setOrigin(() => json({ items: [] }, { headers: CATALOGUE }));
    const first = await h.call("/api/java/v1/storms?b=2&a=1");
    expect(first.res.headers.get("X-Edge-Cache")).toBe("MISS");
    expect(await first.res.json()).toEqual({ items: [] });
    await first.settle();
    const second = await h.call("/api/java/v1/storms?a=1&b=2"); // same query, different order
    expect(second.res.headers.get("X-Edge-Cache")).toBe("HIT");
    expect(second.res.headers.get("Cache-Control")).toBe(CATALOGUE["Cache-Control"]);
    expect(second.res.headers.get("ETag")).toBe(CATALOGUE.ETag);
    expect(second.res.headers.get("X-Backend-Impl")).toBe("java");
    expect(Number(second.res.headers.get("Age"))).toBeGreaterThanOrEqual(0);
    expect(second.res.headers.has("X-Edge-Stored-At")).toBe(false);
    expect(await second.res.json()).toEqual({ items: [] });
    expect(h.calls).toHaveLength(1);
  });

  it("keys on Vary-relevant headers", async () => {
    h.setOrigin((req) => json({ lang: req.headers.get("Accept-Language") }, { headers: { ...CATALOGUE, Vary: "Accept-Encoding, Accept-Language" } }));
    const en = await h.call("/api/java/v1/storms", { headers: { "Accept-Language": "en" } });
    await en.settle();
    const ja = await h.call("/api/java/v1/storms", { headers: { "Accept-Language": "ja" } });
    expect(ja.res.headers.get("X-Edge-Cache")).toBe("MISS");
    expect(await ja.res.json()).toEqual({ lang: "ja" });
    await ja.settle();
    const en2 = await h.call("/api/java/v1/storms", { headers: { "Accept-Language": "en" } });
    expect(en2.res.headers.get("X-Edge-Cache")).toBe("HIT");
    expect(await en2.res.json()).toEqual({ lang: "en" });
  });

  it("answers 304 at the edge for a matching If-None-Match on a hit", async () => {
    await h.seed("/api/java/v1/storms", { items: [] }, CATALOGUE, 10);
    const { res } = await h.call("/api/java/v1/storms", { headers: { "If-None-Match": '"d7-abc"' } });
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(CATALOGUE.ETag);
    expect(res.headers.get("Cache-Control")).toBe(CATALOGUE["Cache-Control"]);
    expect(res.headers.get("X-Edge-Cache")).toBe("HIT");
    expect(await res.text()).toBe("");
    expect(h.calls).toHaveLength(0);
  });

  it("on a miss, fetches a full copy (no validators) and still answers 304", async () => {
    h.setOrigin(() => json({ items: [] }, { headers: CATALOGUE }));
    const { res, settle } = await h.call("/api/java/v1/storms", { headers: { "If-None-Match": 'W/"d7-abc"' } });
    expect(res.status).toBe(304);
    expect(h.calls[0]!.headers.has("If-None-Match")).toBe(false);
    await settle();
    const again = await h.call("/api/java/v1/storms");
    expect(again.res.status).toBe(200);
    expect(again.res.headers.get("X-Edge-Cache")).toBe("HIT");
  });

  it("serves HEAD from a cached GET", async () => {
    await h.seed("/api/java/v1/meta", { impl: "java" }, { "Cache-Control": "public, max-age=60", "X-Backend-Impl": "java" }, 1);
    const { res } = await h.call("/api/java/v1/meta", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Edge-Cache")).toBe("HIT");
    expect(res.body).toBeNull();
  });

  it("caches catalogue 404s with public max-age", async () => {
    h.setOrigin(() => json({ code: "not-found" }, { status: 404, headers: { "Content-Type": "application/problem+json", "Cache-Control": "public, max-age=60" } }));
    const a = await h.call("/api/java/v1/storms/1900001N00000");
    expect(a.res.status).toBe(404);
    await a.settle();
    const b = await h.call("/api/java/v1/storms/1900001N00000");
    expect(b.res.status).toBe(404);
    expect(b.res.headers.get("X-Edge-Cache")).toBe("HIT");
    expect(h.calls).toHaveLength(1);
  });

  it("keeps 404s at most 60 s and never serves them stale (a dataset publish can turn them into 200s)", async () => {
    const notFound = { "Content-Type": "application/problem+json", "Cache-Control": "public, max-age=300" };
    await h.seed("/api/java/v1/storms/2013306N07162", { code: "not-found" }, notFound, 61, {}, 404);
    h.setOrigin(async (req) => {
      await delay(400, req.signal); // asleep: a stale-if-error copy would win the race
      return json({ sid: "2013306N07162" }, { headers: CATALOGUE });
    });
    const { res } = await h.call("/api/java/v1/storms/2013306N07162", {}, { STALE_TIMEOUT_MS: "100", ORIGIN_TIMEOUT_MS: "1000" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Edge-Cache")).toBe("MISS");
    expect(await res.json()).toEqual({ sid: "2013306N07162" });
  });

  it("revalidates /v1/meta without If-None-Match: its ETag doesn't change with datasetVersion", async () => {
    const meta = { "Cache-Control": "public, max-age=60", ETag: 'W/"c2.0.0-java-0.2.0"', "X-Backend-Impl": "java" };
    await h.seed("/api/java/v1/meta", { datasetVersion: 0 }, meta, 3600);
    h.setOrigin((req) =>
      req.headers.has("If-None-Match") ? new Response(null, { status: 304, headers: meta }) : json({ datasetVersion: 1 }, { headers: meta }),
    );
    const { res } = await h.call("/api/java/v1/meta");
    expect(h.calls[0]!.headers.get("If-None-Match")).toBeNull();
    expect(await res.json()).toEqual({ datasetVersion: 1 });
  });

  it.each([
    ["private", { "Cache-Control": "private, no-store" }],
    ["no-cache (live snapshot)", { "Cache-Control": "no-cache", ETag: 'W/"s5"' }],
    ["no-store", { "Cache-Control": "no-store" }],
    ["Set-Cookie", { "Cache-Control": "public, max-age=300", "Set-Cookie": "a=b" }],
    ["Vary: Cookie", { "Cache-Control": "public, max-age=300", Vary: "Accept-Encoding, Cookie" }],
    ["no max-age", { "Cache-Control": "public" }],
  ])("never stores a response with %s", async (_name, headers) => {
    h.setOrigin(() => json({ n: h.calls.length }, { headers }));
    const a = await h.call("/api/java/v1/live/storms");
    await a.settle();
    const b = await h.call("/api/java/v1/live/storms");
    expect(b.res.headers.get("X-Edge-Cache")).toBe("MISS");
    expect(h.calls).toHaveLength(2);
  });

  it("bypasses the cache for requests with a session cookie or Authorization (and never stores them)", async () => {
    h.setOrigin(() => json({ items: [] }, { headers: CATALOGUE }));
    await h.seed("/api/java/v1/storms", { items: ["cached"] }, CATALOGUE, 1);
    const withCookie = await h.call("/api/java/v1/storms", { headers: { Cookie: "__Host-tr_session=tok" } });
    expect(withCookie.res.headers.get("X-Edge-Cache")).toBe("BYPASS");
    expect(await withCookie.res.json()).toEqual({ items: [] });
    await withCookie.settle();
    const withAuth = await h.call("/api/java/v1/storms", { headers: { Authorization: "Bearer x" } });
    expect(withAuth.res.headers.get("X-Edge-Cache")).toBe("BYPASS");
    const anon = await h.call("/api/java/v1/storms");
    expect(anon.res.headers.get("X-Edge-Cache")).toBe("HIT");
    expect(await anon.res.json()).toEqual({ items: ["cached"] });
    expect(h.calls).toHaveLength(2);
  });

  it("never caches /v1/me even if it were marked public", async () => {
    h.setOrigin(() => json({ id: "u" }, { headers: CATALOGUE }));
    const a = await h.call("/api/java/v1/me");
    expect(a.res.headers.get("X-Edge-Cache")).toBe("BYPASS");
    await a.settle();
    await h.call("/api/java/v1/me");
    expect(h.calls).toHaveLength(2);
  });

  it("stale-while-revalidate: serves the stale copy at once and revalidates with the cached ETag", async () => {
    await h.seed("/api/java/v1/storms", { items: ["old"] }, CATALOGUE, 600); // fresh 300 s, then 1 day of swr
    h.setOrigin(async (req) => {
      await delay(200, req.signal); // a slow (cold) backend never blocks the visitor
      return new Response(null, { status: 304, headers: { ETag: CATALOGUE.ETag, "Cache-Control": CATALOGUE["Cache-Control"] } });
    });
    const t0 = Date.now();
    const { res, settle } = await h.call("/api/java/v1/storms");
    expect(Date.now() - t0).toBeLessThan(150);
    expect(res.headers.get("X-Edge-Cache")).toBe("STALE");
    expect(res.headers.get("X-Edge-Stale")).toBe("revalidating");
    expect(await res.json()).toEqual({ items: ["old"] });
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.headers.get("If-None-Match")).toBe(CATALOGUE.ETag);
    const after = await h.call("/api/java/v1/storms");
    expect(after.res.headers.get("X-Edge-Cache")).toBe("HIT"); // the 304 refreshed the entry
    expect(await after.res.json()).toEqual({ items: ["old"] });
  });

  it("stale-if-error: serves the stale copy when the backend answers 503", async () => {
    const meta = { "Cache-Control": "public, max-age=60", ETag: 'W/"c1.0.0-java-0.1.0"', "X-Backend-Impl": "java" };
    await h.seed("/api/java/v1/meta", { impl: "java" }, meta, 3600);
    h.setOrigin(() => new Response("<html>Service Unavailable</html>", { status: 503, headers: { "Content-Type": "text/html" } }));
    const { res } = await h.call("/api/java/v1/meta");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Edge-Cache")).toBe("STALE");
    expect(res.headers.get("X-Edge-Stale")).toBe("if-error");
    expect(await res.json()).toEqual({ impl: "java" });
  });

  it("stale-if-error: serves the stale copy when the backend is asleep, and refreshes in the background", async () => {
    const meta = { "Cache-Control": "public, max-age=60", "X-Backend-Impl": "java" };
    await h.seed("/api/java/v1/meta", { v: 1 }, meta, 3600);
    h.setOrigin(async (req) => {
      await delay(400, req.signal);
      return json({ v: 2 }, { headers: meta });
    });
    const { res, settle } = await h.call("/api/java/v1/meta", {}, { STALE_TIMEOUT_MS: "100" });
    expect(res.headers.get("X-Edge-Cache")).toBe("STALE");
    expect(await res.json()).toEqual({ v: 1 });
    await settle();
    const after = await h.call("/api/java/v1/meta");
    expect(after.res.headers.get("X-Edge-Cache")).toBe("HIT");
    expect(await after.res.json()).toEqual({ v: 2 });
  });

  it("stale-if-error: uses a quick fresh answer when the backend is up", async () => {
    const meta = { "Cache-Control": "public, max-age=60", "X-Backend-Impl": "java" };
    await h.seed("/api/java/v1/meta", { v: 1 }, meta, 3600);
    h.setOrigin(() => json({ v: 2 }, { headers: meta }));
    const { res } = await h.call("/api/java/v1/meta");
    expect(res.headers.get("X-Edge-Cache")).toBe("MISS");
    expect(await res.json()).toEqual({ v: 2 });
  });
});

describe("cold start", () => {
  it("a slow miss returns 503 backend-waking with Retry-After, and the request finishes in the background", async () => {
    h.setOrigin(async (req) => {
      await delay(300, req.signal);
      return json({ items: [] }, { headers: CATALOGUE });
    });
    const { res, settle } = await h.call("/api/java/v1/storms", {}, { ORIGIN_TIMEOUT_MS: "100" });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("20");
    expect((await problemOf(res)).code).toBe("backend-waking");
    await settle();
    const next = await h.call("/api/java/v1/storms");
    expect(next.res.headers.get("X-Edge-Cache")).toBe("HIT"); // the woken backend's answer filled the cache
    expect(h.calls).toHaveLength(1);
  });

  it("a backend whose database is still waking (503 not-ready) is a backend-waking answer, retried in the background", async () => {
    let ready = false;
    h.setOrigin(() =>
      ready
        ? json({ sid: "2013306N07162" }, { headers: CATALOGUE })
        : json({ code: "not-ready", status: 503 }, { status: 503, headers: { "Content-Type": "application/problem+json", "Cache-Control": "no-store", "Retry-After": "10" } }),
    );
    const { res, settle } = await h.call("/api/java/v1/storms/2013306N07162");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("10");
    expect((await problemOf(res)).code).toBe("backend-waking");
    ready = true;
    await settle();
    expect(h.calls).toHaveLength(2);
    const next = await h.call("/api/java/v1/storms/2013306N07162");
    expect(next.res.headers.get("X-Edge-Cache")).toBe("HIT");
  }, 15_000);

  it("a slow health probe is cut short with 503 and kicks a background /healthz wake", async () => {
    h.setOrigin(async (req) => {
      await delay(req.headers.get("User-Agent") === "typhoon-replay-edge/wake" ? 10 : 5000, req.signal);
      return json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
    });
    const { res, settle } = await h.call("/api/java/healthz", {}, { ORIGIN_TIMEOUT_MS: "100" });
    expect(res.status).toBe(503);
    expect((await problemOf(res)).code).toBe("backend-waking");
    await settle();
    expect(h.calls.map((c) => [c.url, c.headers.get("User-Agent")])).toEqual([
      [`${ORIGIN}/healthz`, null],
      [`${ORIGIN}/healthz`, "typhoon-replay-edge/wake"],
    ]);
    expect(h.calls[0]!.signal.aborted).toBe(true);
  });

  it("turns Render's HTML 502/503/504 pages into problem+json", async () => {
    h.setOrigin(() => new Response("<html>bad gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } }));
    const { res } = await h.call("/api/java/healthz");
    expect(res.status).toBe(503);
    expect((await problemOf(res)).code).toBe("backend-unavailable");
  });

  it("an unreachable origin is a 502 problem", async () => {
    h.setOrigin(() => {
      throw new TypeError("connect failed");
    });
    const { res } = await h.call("/api/java/v1/storms");
    expect(res.status).toBe(502);
    expect((await problemOf(res)).code).toBe("bad-gateway");
  });
});

describe("SSE", () => {
  it("streams frames through as they arrive, forwards Last-Event-ID and never caches", async () => {
    const enc = new TextEncoder();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.setOrigin(() => {
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(enc.encode("retry: 10000\nevent: snapshot\nid: 7\ndata: {}\n\n"));
          await gate;
          c.enqueue(enc.encode(":\n\n"));
          c.close();
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "X-Backend-Impl": "java" } });
    });
    const { res } = await h.call("/api/java/v1/live/stream", { headers: { Accept: "text/event-stream", "Last-Event-ID": "5" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("X-Edge-Cache")).toBe("BYPASS");
    expect(h.calls[0]!.headers.get("Last-Event-ID")).toBe("5");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const first = await reader.read(); // arrives while the origin is still holding the stream open
    expect(dec.decode(first.value)).toContain("event: snapshot");
    release();
    let restText = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      restText += dec.decode(value);
    }
    expect(restText).toBe(":\n\n");
  });
});

describe("rate limiting", () => {
  it("returns 429 problem+json with Retry-After once the per-IP bucket is empty", async () => {
    const env = { RATE_LIMIT_BURST: "2", RATE_LIMIT_PER_MINUTE: "6" };
    expect((await h.call("/api/java/healthz", {}, env)).res.status).toBe(200);
    expect((await h.call("/api/java/healthz", {}, env)).res.status).toBe(200);
    const { res } = await h.call("/api/java/healthz", {}, env);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect((await problemOf(res)).code).toBe("rate-limited");
    // another client is unaffected
    expect((await h.call("/api/java/healthz", { headers: { "CF-Connecting-IP": "192.0.2.1" } }, env)).res.status).toBe(200);
  });

  it("uses a rate limiting binding when one is bound", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const { res } = await h.call("/api/java/healthz", {}, { RATE_LIMITER: { limit } });
    expect(res.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: "203.0.113.7" });
  });
});

describe("static mode", () => {
  it("serves cached copies only and never calls the origin", async () => {
    await h.seed("/api/java/v1/storms", { items: ["cached"] }, CATALOGUE, 10);
    await h.seed("/api/java/v1/meta", { impl: "java" }, { "Cache-Control": "public, max-age=60" }, 3600);
    const env = { STATIC_MODE: "true" };
    const fresh = await h.call("/api/java/v1/storms", {}, env);
    expect(fresh.res.headers.get("X-Edge-Cache")).toBe("HIT");
    const stale = await h.call("/api/java/v1/meta", {}, env);
    expect(stale.res.headers.get("X-Edge-Cache")).toBe("STALE");
    expect(stale.res.headers.get("X-Edge-Stale")).toBe("static-mode");
    for (const [path, init] of [
      ["/api/java/v1/places/search?q=Tacloban", {}],
      ["/api/java/healthz", {}],
      ["/api/java/v1/live/stream", {}],
      ["/api/java/v1/me/places", { method: "POST", body: "{}" }],
    ] as const) {
      const { res } = await h.call(path, init, env);
      expect(res.status, path).toBe(503);
      expect((await problemOf(res)).code).toBe("static-mode");
      expect(res.headers.get("Retry-After")).toBeTruthy();
    }
    expect(h.calls).toHaveLength(0);
  });

  it("can be switched on from a KV flag", async () => {
    const kv = { get: vi.fn(async () => "true") } as unknown as KVNamespace;
    const { res } = await h.call("/api/java/v1/storms", {}, { EDGE_FLAGS: kv });
    expect((await problemOf(res)).code).toBe("static-mode");
  });
});

describe("request body cap", () => {
  it("rejects a declared Content-Length over 64 KB", async () => {
    const { res } = await h.call("/api/java/v1/me/places", { method: "POST", body: "x".repeat(MAX_BODY_BYTES + 1) });
    expect(res.status).toBe(413);
    expect((await problemOf(res)).code).toBe("payload-too-large");
    expect(h.calls).toHaveLength(0);
  });

  it("rejects a streamed body that grows past 64 KB", async () => {
    const chunk = new Uint8Array(16 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ < 6) c.enqueue(chunk);
        else c.close();
      },
    });
    const { res } = await h.call("/api/java/v1/me/places", { method: "POST", body, headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(413);
    expect(h.calls).toHaveLength(0);
  });

  it("allows exactly 64 KB", async () => {
    h.setOrigin(async (req) => json({ len: (await req.arrayBuffer()).byteLength }));
    const { res } = await h.call("/api/java/v1/me/places", { method: "POST", body: "x".repeat(MAX_BODY_BYTES) });
    expect(await res.json()).toEqual({ len: MAX_BODY_BYTES });
  });
});

describe("helpers", () => {
  it("parses Cache-Control", () => {
    expect(parseCacheControl("public, max-age=300, stale-while-revalidate=86400")).toMatchObject({ public: true, maxAge: 300, swr: 86400 });
    expect(parseCacheControl("private, no-store")).toMatchObject({ private: true, noStore: true });
  });
  it("compares ETags weakly", () => {
    expect(etagMatches('"a", W/"b"', 'W/"b"')).toBe(true);
    expect(etagMatches('"b"', 'W/"b"')).toBe(true);
    expect(etagMatches('"c"', 'W/"b"')).toBe(false);
    expect(etagMatches("*", '"x"')).toBe(true);
  });
});
