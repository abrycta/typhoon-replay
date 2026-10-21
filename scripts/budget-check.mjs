#!/usr/bin/env node
// Free-tier budget check (docs/architecture/DECISIONS.md, "Hosting the Go, Node and Rust backends"): reads this
// month's usage from the providers' APIs and prints a Markdown report. Exits 2 when any meter passes WARN_AT (70 %)
// of its free limit, so the workflow can open an issue. A provider whose credentials are missing is reported as
// "not checked", never as a failure. No dependencies: Node 24's fetch.
//
// Env: RENDER_API_KEY, CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, NEON_API_KEY + NEON_PROJECT_ID (all optional).

const WARN_AT = Number(process.env.WARN_AT ?? 0.7);
const now = new Date();
const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
const monthFraction = (now - monthStart) / (monthEnd - monthStart);
const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** @type {{provider: string, meter: string, used: number, limit: number, unit: string, note?: string}[]} */
const meters = [];
const skipped = [];

async function getJson(url, init = {}) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${url.split("?")[0]}`);
  return res.json();
}

// --- Render: free instance hours (750/month per workspace, shared) and outbound bandwidth (5 GB/month on Hobby) ---
async function render(key) {
  const h = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  const services = (await getJson("https://api.render.com/v1/services?limit=100", { headers: h })).map((s) => s.service);
  const free = services.filter((s) => s.serviceDetails?.plan === "free");
  let hours = 0;
  let mb = 0;
  const q = `startTime=${monthStart.toISOString()}&endTime=${now.toISOString()}`;
  for (const s of services) {
    const bw = await getJson(`https://api.render.com/v1/metrics/bandwidth?resource=${s.id}&${q}&resolutionSeconds=86400`, { headers: h });
    mb += bw.flatMap((series) => series.values).reduce((sum, v) => sum + v.value, 0);
  }
  // Render reports no instance-hour meter over the API. A free service only reports CPU while it runs, so the number
  // of 5-minute buckets with a CPU sample approximates its running time (one instance each on the free plan).
  for (const s of free) {
    const cpu = await getJson(`https://api.render.com/v1/metrics/cpu?resource=${s.id}&${q}&resolutionSeconds=300`, { headers: h });
    const buckets = new Set(cpu.flatMap((series) => series.values.map((v) => v.timestamp)));
    hours += (buckets.size * 300) / 3600;
  }
  meters.push({ provider: "Render", meter: `free instance hours (${free.length} free services, estimated)`, used: hours, limit: 750, unit: "h" });
  meters.push({ provider: "Render", meter: "outbound bandwidth", used: mb / 1000, limit: 5, unit: "GB" });
}

// --- Cloudflare: Workers + Pages Functions requests (100,000/day, shared) ---
async function cloudflare(token, account) {
  const query = `query($a: String!, $s: Time!) { viewer { accounts(filter: {accountTag: $a}) {
    workersInvocationsAdaptive(limit: 1000, filter: {datetime_geq: $s}) { sum { requests } dimensions { scriptName } }
    pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: {datetime_geq: $s}) { sum { requests } }
  } } }`;
  const body = JSON.stringify({ query, variables: { a: account, s: dayStart.toISOString() } });
  const d = await getJson("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
  });
  if (d.errors?.length) throw new Error(d.errors.map((e) => e.message).join("; "));
  const acc = d.data.viewer.accounts[0] ?? {};
  const workers = (acc.workersInvocationsAdaptive ?? []).reduce((s, r) => s + r.sum.requests, 0);
  const pages = (acc.pagesFunctionsInvocationsAdaptiveGroups ?? []).reduce((s, r) => s + r.sum.requests, 0);
  meters.push({ provider: "Cloudflare", meter: "Workers + Pages Functions requests today (UTC)", used: workers + pages, limit: 100_000, unit: "req",
    note: `Workers ${workers}, Pages Functions ${pages}` });
}

// --- Neon free: 100 CU-hours/month, 5 GB egress/month, 1 GB storage per project (project endpoint, current period) ---
async function neon(key, project) {
  const p = (await getJson(`https://console.neon.tech/api/v2/projects/${project}`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } })).project;
  meters.push({ provider: "Neon", meter: "compute", used: (p.compute_time_seconds ?? 0) / 3600, limit: 100, unit: "CU-h" });
  meters.push({ provider: "Neon", meter: "data transfer (egress)", used: (p.data_transfer_bytes ?? 0) / 1e9, limit: 5, unit: "GB" });
  meters.push({ provider: "Neon", meter: "storage", used: (p.synthetic_storage_size ?? 0) / 1e9, limit: 1, unit: "GB" });
}

const env = process.env;
const checks = [
  ["Render", env.RENDER_API_KEY, () => render(env.RENDER_API_KEY)],
  ["Cloudflare", env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID, () => cloudflare(env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID)],
  ["Neon", env.NEON_API_KEY && env.NEON_PROJECT_ID, () => neon(env.NEON_API_KEY, env.NEON_PROJECT_ID)],
];
for (const [name, ok, run] of checks) {
  if (!ok) {
    skipped.push(`${name}: not checked (credentials not set)`);
    continue;
  }
  try {
    await run();
  } catch (e) {
    skipped.push(`${name}: not checked (${e.message})`);
  }
}

let over = false;
const lines = [
  `## Free-tier usage, ${now.toISOString().slice(0, 10)} (month ${Math.round(monthFraction * 100)} % elapsed)`,
  "",
  "| Provider | Meter | Used | Free limit | Share | Month-end projection |",
  "|---|---|---|---|---|---|",
];
for (const m of meters) {
  const share = m.used / m.limit;
  const daily = m.unit === "req"; // a per-day meter: no month projection
  const projected = daily ? share : share / Math.max(monthFraction, 1 / 31);
  const flag = share >= WARN_AT || (!daily && projected >= 1) ? " ⚠️" : "";
  if (flag) over = true;
  lines.push(`| ${m.provider} | ${m.meter}${m.note ? ` (${m.note})` : ""} | ${m.used.toFixed(m.unit === "req" ? 0 : 2)} ${m.unit} | ${m.limit} ${m.unit} | ${(share * 100).toFixed(1)} %${flag} | ${daily ? "per day" : `${(projected * 100).toFixed(0)} %`} |`);
}
if (skipped.length) lines.push("", ...skipped.map((s) => `- ${s}`));
lines.push("", `Warning threshold: ${WARN_AT * 100} % of a limit, or a month-end projection over 100 %.`);
console.log(lines.join("\n"));
process.exit(over ? 2 : 0);
