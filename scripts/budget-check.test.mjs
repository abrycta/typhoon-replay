// node --test scripts/budget-check.test.mjs: the Render hours guard and the static-mode trip and recovery against mocked provider APIs (nothing real is
// called, suspended or written).
import assert from "node:assert/strict";
import { test } from "node:test";

import { decideGuard, decideStatic, edgeFlagsNamespace, run } from "./budget-check.mjs";

const NOW = new Date("2026-10-22T02:17:00Z");
const svc = (id, name, suspended = false) => ({ service: { id, name, suspended: suspended ? "suspended" : "not_suspended", serviceDetails: { plan: "free" } } });

/** A fetch double: Render with `hours` of CPU samples split over the services, GitHub with `issues`. */
function mock({ hours, services, issues = [] }) {
  const calls = [];
  const buckets = Math.round((hours * 3600) / 300);
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${url.split("?")[0]}`);
    let body = {};
    if (url.includes("/v1/services?")) body = services;
    else if (url.includes("/metrics/bandwidth")) body = [];
    else if (url.includes("/metrics/cpu")) {
      const id = new URL(url).searchParams.get("resource");
      const mine = id === services[0].service.id ? buckets : 0; // all hours on the first service
      body = [{ values: Array.from({ length: mine }, (_, i) => ({ timestamp: new Date(Date.UTC(2026, 9, 1) + i * 300_000).toISOString(), value: 0.1 })) }];
    } else if (url.includes("/issues?")) body = issues;
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { calls, fetchImpl };
}

const env = { RENDER_API_KEY: "test", GITHUB_TOKEN: "test", GITHUB_REPOSITORY: "o/r", RENDER_GUARD_SERVICES: "typhoon-replay-go" };
const writes = (calls) => calls.filter((c) => !c.startsWith("GET") && !c.endsWith("/graphql")); // GraphQL POSTs only read
const quiet = () => {};

test("below 85 %: nothing is paused", async () => {
  const m = mock({ hours: 630, services: [svc("srv-java", "typhoon-replay-java"), svc("srv-go", "typhoon-replay-go")] });
  const r = await run({ env, now: NOW, fetchImpl: m.fetchImpl, log: quiet });
  assert.deepEqual(writes(m.calls), []);
  assert.equal(r.over, true); // 84 % still trips the 70 % alert
});

test("at 85 %: suspends the first listed service and opens the guard issue; never an unlisted one", async () => {
  const m = mock({ hours: 640, services: [svc("srv-plumes", "plumes-java"), svc("srv-go", "typhoon-replay-go")] });
  await run({ env, now: NOW, fetchImpl: m.fetchImpl, log: quiet });
  assert.deepEqual(writes(m.calls), ["POST https://api.render.com/v1/services/srv-go/suspend", "POST https://api.github.com/repos/o/r/issues"]);
});

test("dry run plans the suspension without calling any write API", async () => {
  const m = mock({ hours: 700, services: [svc("srv-go", "typhoon-replay-go")] });
  const r = await run({ env, now: NOW, fetchImpl: m.fetchImpl, dryRun: true, log: quiet });
  assert.deepEqual(writes(m.calls), []);
  assert.match(r.actions[0], /^suspend typhoon-replay-go/);
});

test("next month: resumes what the guard paused and closes its issue", async () => {
  const issue = { number: 7, title: "Render hours guard: paused typhoon-replay-go (2026-10)", body: "x\n<!-- render-guard month=2026-10 services=typhoon-replay-go -->" };
  const m = mock({ hours: 1, services: [svc("srv-go", "typhoon-replay-go", true)], issues: [issue] });
  await run({ env, now: new Date("2026-11-01T02:17:00Z"), fetchImpl: m.fetchImpl, log: quiet });
  assert.deepEqual(writes(m.calls), [
    "POST https://api.render.com/v1/services/srv-go/resume",
    "POST https://api.github.com/repos/o/r/issues/7/comments",
    "PATCH https://api.github.com/repos/o/r/issues/7",
  ]);
});

test("a service suspended by hand (no guard issue) is not resumed", () => {
  const d = decideGuard({ hours: 1, services: [{ id: "srv-go", name: "typhoon-replay-go", suspended: true }], guardList: ["typhoon-replay-go"], pausedIssues: [], now: new Date("2026-11-01T00:00:00Z") });
  assert.deepEqual(d.resume, []);
  assert.equal(d.suspend, null);
});

// --- Static-mode trip (Render bandwidth, Neon compute, daily Workers requests at 70 %) ---

/** A fetch double for the trip: Render bandwidth `gb`, Neon compute `cuh`, Cloudflare requests `req`, KV flag `flag`. */
function tripMock({ gb = 0, cuh = 0, req = 0, flag, issues = [] }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${url.split("?")[0]}`);
    let body = {};
    if (url.includes("/storage/kv/")) {
      if ((init.method ?? "GET") === "GET") return flag === undefined ? new Response("", { status: 404 }) : new Response(flag, { status: 200 });
      body = { success: true };
    } else if (url.includes("/v1/services?")) body = [svc("srv-java", "typhoon-replay-java")];
    else if (url.includes("/metrics/bandwidth")) body = [{ values: [{ timestamp: "2026-10-02T00:00:00Z", value: gb * 1000 }] }];
    else if (url.includes("/metrics/cpu")) body = [];
    else if (url.includes("/graphql")) body = { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: req }, dimensions: { scriptName: "x" } }], pagesFunctionsInvocationsAdaptiveGroups: [] }] } } };
    else if (url.includes("console.neon.tech")) body = { project: { compute_time_seconds: cuh * 3600 } };
    else if (url.includes("/issues?")) body = issues;
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { calls, fetchImpl };
}

const tripEnv = { ...env, CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acc", NEON_API_KEY: "n", NEON_PROJECT_ID: "p", EDGE_FLAGS_NAMESPACE_ID: "ns1" };
const KV = "https://api.cloudflare.com/client/v4/accounts/acc/storage/kv/namespaces/ns1/values/static_mode";

test("trip dry run: Render bandwidth past 70 % plans static mode without writing KV or an issue", async () => {
  const m = tripMock({ gb: 3.6 });
  const r = await run({ env: tripEnv, now: NOW, fetchImpl: m.fetchImpl, dryRun: true, log: quiet });
  assert.deepEqual(writes(m.calls), []);
  assert.equal(r.actions.length, 1);
  assert.match(r.actions[0], /^static mode on: Render outbound bandwidth: 3\.60 GB of 5 GB \(72\.0 %\)/);
});

test("trip: Neon compute past 70 % writes static_mode=true and opens the issue", async () => {
  const m = tripMock({ cuh: 71 });
  await run({ env: tripEnv, now: NOW, fetchImpl: m.fetchImpl, log: quiet });
  assert.deepEqual(writes(m.calls), [`PUT ${KV}`, "POST https://api.github.com/repos/o/r/issues"]);
});

test("trip: the daily Workers requests past 70 % trip it too", async () => {
  const m = tripMock({ req: 70_000 });
  const r = await run({ env: tripEnv, now: NOW, fetchImpl: m.fetchImpl, dryRun: true, log: quiet });
  assert.match(r.actions[0], /Cloudflare Workers \+ Pages Functions requests today/);
});

test("trip: already on, or below 70 %, writes nothing", async () => {
  for (const m of [tripMock({ gb: 4.5, flag: "true" }), tripMock({ gb: 3.4, cuh: 69, req: 69_000 })]) {
    await run({ env: tripEnv, now: NOW, fetchImpl: m.fetchImpl, log: quiet });
    assert.deepEqual(writes(m.calls), []);
  }
});

// --- Static-mode recovery (under 50 % on every trip meter, on for 24 h, only what the trip itself switched on) ---

const ISSUE = "https://api.github.com/repos/o/r/issues/9";
const tripIssue = (createdAt = "2026-10-01T10:17:00Z") => ({ number: 9, title: "Static mode switched on (2026-10-01)", created_at: createdAt, body: "x" });

test("recovery: every meter under 50 % and on for 24 h switches static mode off and closes the trip issue", async () => {
  const m = tripMock({ gb: 0.2, cuh: 3, req: 100, flag: "true", issues: [tripIssue()] });
  const r = await run({ env: tripEnv, now: NOW, fetchImpl: m.fetchImpl, log: quiet });
  assert.deepEqual(writes(m.calls), [`PUT ${KV}`, `POST ${ISSUE}/comments`, `PATCH ${ISSUE}`]);
  assert.match(r.actions[0], /^static mode off/);
});

test("recovery dry run plans the switch-off without writing KV or issues", async () => {
  const m = tripMock({ flag: "true", issues: [tripIssue()] });
  const r = await run({ env: tripEnv, now: NOW, fetchImpl: m.fetchImpl, dryRun: true, log: quiet });
  assert.deepEqual(writes(m.calls), []);
  assert.match(r.actions[0], /^static mode off/);
});

test("recovery hysteresis: between 50 % and 70 %, or on for under 24 h, static mode stays on", async () => {
  for (const m of [
    tripMock({ gb: 2.6, flag: "true", issues: [tripIssue()] }), // 52 % bandwidth
    tripMock({ cuh: 60, flag: "true", issues: [tripIssue()] }), // 60 % Neon compute
    tripMock({ req: 50_000, flag: "true", issues: [tripIssue()] }), // 50 % of today's requests
    tripMock({ flag: "true", issues: [tripIssue("2026-10-21T18:17:00Z")] }), // on for 8 h
  ]) {
    const r = await run({ env: tripEnv, now: NOW, fetchImpl: m.fetchImpl, log: quiet });
    assert.deepEqual(writes(m.calls), []);
    assert.deepEqual(r.actions, []);
  }
});

test("recovery: never when a meter could not be read, or when static mode was switched on by hand", async () => {
  const noNeon = { ...tripEnv, NEON_API_KEY: undefined };
  for (const [e, m] of [
    [noNeon, tripMock({ flag: "true", issues: [tripIssue()] })], // Neon not checked
    [tripEnv, tripMock({ flag: "true" })], // on with no trip issue: set by hand
    [tripEnv, tripMock({ flag: "true", issues: [{ ...tripIssue(), title: "Something else" }] })],
  ]) {
    await run({ env: e, now: NOW, fetchImpl: m.fetchImpl, log: quiet });
    assert.deepEqual(writes(m.calls), []);
  }
});

test("recovery: a trip issue whose flag was already switched off by hand is closed, KV untouched", async () => {
  const m = tripMock({ flag: "false", issues: [tripIssue()] });
  await run({ env: tripEnv, now: NOW, fetchImpl: m.fetchImpl, log: quiet });
  assert.deepEqual(writes(m.calls), [`POST ${ISSUE}/comments`, `PATCH ${ISSUE}`]);
});

test("full cycle: 72 % trips on, 60 % holds, the monthly reset switches off, then 72 % trips again", async () => {
  let flag; let issues = [];
  const step = async (gb, now) => {
    const m = tripMock({ gb, flag, issues });
    const r = await run({ env: tripEnv, now: new Date(now), fetchImpl: m.fetchImpl, log: quiet });
    for (const c of writes(m.calls)) {
      if (c === `PUT ${KV}`) flag = r.actions.some((a) => a.startsWith("static mode on")) ? "true" : "false";
      if (c.endsWith("/repos/o/r/issues")) issues = [tripIssue(now)];
      if (c === `PATCH ${ISSUE}`) issues = [];
    }
    return flag;
  };
  assert.equal(await step(3.6, "2026-10-20T02:17:00Z"), "true");
  assert.equal(await step(3.0, "2026-10-25T02:17:00Z"), "true");
  assert.equal(await step(0.1, "2026-11-01T02:17:00Z"), "false");
  assert.equal(await step(0.1, "2026-11-01T10:17:00Z"), "false");
  assert.equal(await step(3.6, "2026-11-20T02:17:00Z"), "true");
});

test("trip: Render hours, Neon egress and storage never trip static mode", () => {
  const meters = [
    { provider: "Render", meter: "free instance hours", used: 740, limit: 750, unit: "h" },
    { provider: "Neon", meter: "data transfer (egress)", used: 4.9, limit: 5, unit: "GB" },
    { provider: "Neon", meter: "storage", used: 0.99, limit: 1, unit: "GB" },
  ];
  const d = decideStatic({ meters, flagOn: false });
  assert.deepEqual([d.tripped, d.switchOn, d.switchOff], [[], false, false]);
});

test("the EDGE_FLAGS namespace comes from wrangler.jsonc's kv_namespaces, comments allowed", () => {
  assert.equal(edgeFlagsNamespace('{\n  // note\n  "kv_namespaces": [{ "binding": "EDGE_FLAGS", "id": "abc" }]\n}'), "abc");
  assert.equal(edgeFlagsNamespace('{ "name": "x" }'), undefined);
});
