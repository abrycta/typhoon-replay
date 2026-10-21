#!/usr/bin/env node
// Deploys one commit to a Render service and waits until it is live (or failed). Used by java.yml and go.yml after
// their tests and conformance pass, instead of Render's own auto-deploy (docs/architecture/DECISIONS.md).
//   RENDER_API_KEY=... node scripts/render-deploy.mjs <service-name> <commit-sha>
// A suspended service (paused by the hours guard, scripts/budget-check.mjs) is skipped: deploying would not wake it.
const [name, commit] = process.argv.slice(2);
const key = process.env.RENDER_API_KEY;
if (!name || !commit || !key) {
  console.error("usage: RENDER_API_KEY=... render-deploy.mjs <service-name> <commit-sha>");
  process.exit(64);
}
const API = "https://api.render.com/v1";
const headers = { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" };
async function call(path, init = {}) {
  const res = await fetch(API + path, { ...init, headers });
  if (!res.ok) throw new Error(`${res.status} ${init.method ?? "GET"} ${path.split("?")[0]}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
const service = (await call(`/services?name=${encodeURIComponent(name)}&limit=1`))[0]?.service;
if (!service) throw new Error(`no Render service named ${name}`);
if (service.suspended === "suspended") {
  console.log(`${name} is suspended (paused this month by the hours guard): not deploying.`);
  process.exit(0);
}
const deploy = await call(`/services/${service.id}/deploys`, { method: "POST", body: JSON.stringify({ commitId: commit, clearCache: "do_not_clear" }) });
console.log(`${name}: deploy ${deploy.id} of ${commit.slice(0, 7)} started`);
const deadline = Date.now() + 25 * 60_000;
const FAILED = new Set(["build_failed", "update_failed", "canceled", "pre_deploy_failed", "deactivated"]);
for (;;) {
  await new Promise((r) => setTimeout(r, 15_000));
  const d = await call(`/services/${service.id}/deploys/${deploy.id}`);
  if (d.status === "live") {
    console.log(`${name}: live`);
    break;
  }
  if (FAILED.has(d.status)) throw new Error(`${name}: deploy ${deploy.id} ended as ${d.status}`);
  if (Date.now() > deadline) throw new Error(`${name}: deploy ${deploy.id} still ${d.status} after 25 min`);
}
