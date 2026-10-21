// node --test scripts/budget-check.test.mjs: the Render hours guard against mocked provider APIs (nothing real is
// called, suspended or written).
import assert from "node:assert/strict";
import { test } from "node:test";

import { decideGuard, run } from "./budget-check.mjs";

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
const writes = (calls) => calls.filter((c) => !c.startsWith("GET"));
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
