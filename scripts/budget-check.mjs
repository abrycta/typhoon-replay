#!/usr/bin/env node
// Free-tier budget check and Render hours guard (docs/architecture/DECISIONS.md, "Hosting the Go, Node and Rust
// backends"; .github/workflows/budget.yml). No dependencies: Node 24's fetch.
//
// 1. Reads this month's usage from the providers' APIs and prints a Markdown report. Exits 2 when any meter passes
//    WARN_AT (70 %) of its free limit or is projected past 100 %, so the workflow opens an issue. A provider whose
//    credentials are missing is reported as "not checked", never as a failure.
// 2. Render hours guard. Running out of the workspace's 750 free instance hours suspends every free service, the
//    live ones included, until next month. So when the month's estimated hours reach GUARD_AT (85 %), the guard
//    suspends the first still-running service of RENDER_GUARD_SERVICES (comma-separated names, in pause order; a
//    service that is not listed is never paused), one per run, and records it in a GitHub issue. On the first run
//    of a later month it resumes the services those issues name and closes the issues. Services suspended by hand
//    are never resumed: only the guard's own issues are read.
// 3. Static-mode trip. When Render outbound bandwidth or Neon compute passes STATIC_AT (70 %) of the monthly free
//    allowance, or today's Workers + Pages Functions requests pass 70 % of the daily one, it writes static_mode=true to
//    the EDGE_FLAGS KV namespace (wrangler.jsonc kv_namespaces; the edge reads it within a minute, no redeploy) and
//    opens an issue that says what tripped and how to switch back. It never switches back by itself.
//
// Env: RENDER_API_KEY, CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, NEON_API_KEY + NEON_PROJECT_ID, GITHUB_TOKEN +
// GITHUB_REPOSITORY (all optional), RENDER_GUARD_SERVICES (default "typhoon-replay-go"), WARN_AT, GUARD_AT, STATIC_AT,
// EDGE_FLAGS_NAMESPACE_ID (default: the EDGE_FLAGS binding in wrangler.jsonc).
// Flag: --dry-run plans the guard's and the trip's actions without suspending, resuming, writing KV or issues.

import { readFileSync } from "node:fs";

const RENDER = "https://api.render.com/v1";
const GITHUB = "https://api.github.com";
export const GUARD_TITLE = "Render hours guard: paused";
const MARKER = /<!-- render-guard month=(\d{4}-\d{2}) services=([\w,.-]+) -->/;

const CLOUDFLARE = "https://api.cloudflare.com/client/v4";
export const STATIC_TITLE = "Static mode switched on";

const monthKey = (d) => d.toISOString().slice(0, 7);

/** The EDGE_FLAGS KV namespace id from wrangler.jsonc, or undefined when the binding is not set up. */
export function edgeFlagsNamespace(text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")) {
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
  return (config.kv_namespaces ?? []).find((k) => k.binding === "EDGE_FLAGS")?.id;
}

/** The meters that switch the edge to static mode: Render bandwidth, Neon compute, the daily Workers requests. */
const tripsStatic = (m) =>
  (m.provider === "Render" && m.meter === "outbound bandwidth") ||
  (m.provider === "Neon" && m.meter === "compute") ||
  (m.provider === "Cloudflare" && m.unit === "req");

/**
 * The static-mode trip's decision (pure). `meters` as in the report; `flagOn` whether static_mode is already true.
 * Returns the meters at or past `staticAt` of their free allowance and whether to switch static mode on now.
 */
export function decideStatic({ meters, staticAt = 0.7, flagOn }) {
  const tripped = meters.filter((m) => tripsStatic(m) && m.used / m.limit >= staticAt);
  return { tripped, switchOn: tripped.length > 0 && !flagOn };
}

/** The month's frame: start, end and the fraction elapsed. */
export function frame(now) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start, end, day, fraction: (now - start) / (end - start) };
}

/**
 * The guard's decision (pure). `hours` is the month's estimated free instance hours; `services` the Render services
 * ({id, name, suspended}); `guardList` the names that may be paused, in order; `pausedIssues` the open guard issues
 * ({number, month, services}). Returns what to resume (issues from earlier months) and what to suspend now.
 */
export function decideGuard({ hours, limit = 750, guardAt = 0.85, services, guardList, pausedIssues, now }) {
  const month = monthKey(now);
  const byName = new Map(services.map((s) => [s.name, s]));
  const resume = [];
  for (const issue of pausedIssues.filter((i) => i.month < month)) {
    for (const name of issue.services) {
      const s = byName.get(name);
      if (s && s.suspended) resume.push({ service: s, issue: issue.number });
    }
  }
  const resumed = new Set(resume.map((r) => r.service.id));
  let suspend;
  if (hours >= guardAt * limit) {
    suspend = guardList
      .map((name) => byName.get(name))
      .find((s) => s && (!s.suspended || resumed.has(s.id)));
  }
  return { month, resume, suspend: suspend ?? null, closeIssues: [...new Set(resume.map((r) => r.issue))], over: hours >= guardAt * limit };
}

export async function run({ env = process.env, now = new Date(), fetchImpl = fetch, dryRun = false, log = console.log } = {}) {
  const WARN_AT = Number(env.WARN_AT ?? 0.7);
  const GUARD_AT = Number(env.GUARD_AT ?? 0.85);
  const STATIC_AT = Number(env.STATIC_AT ?? 0.7);
  const guardList = (env.RENDER_GUARD_SERVICES ?? "typhoon-replay-go").split(",").map((s) => s.trim()).filter(Boolean);
  const { start, day, fraction } = frame(now);
  const meters = [];
  const notes = [];
  const actions = [];

  async function call(url, init = {}) {
    const res = await fetchImpl(url, init);
    if (!res.ok) throw new Error(`${res.status} ${init.method ?? "GET"} ${url.split("?")[0]}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  // --- Render: free instance hours (750/month per workspace, shared) and outbound bandwidth (5 GB/month) ---
  let renderState;
  async function render(key) {
    const h = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    const services = (await call(`${RENDER}/services?limit=100`, { headers: h })).map((s) => s.service);
    const free = services.filter((s) => s.serviceDetails?.plan === "free");
    const q = `startTime=${start.toISOString()}&endTime=${now.toISOString()}`;
    let mb = 0;
    for (const s of services) {
      const bw = await call(`${RENDER}/metrics/bandwidth?resource=${s.id}&${q}&resolutionSeconds=86400`, { headers: h });
      mb += bw.flatMap((series) => series.values).reduce((sum, v) => sum + v.value, 0);
    }
    // Render reports no instance-hour meter over the API. A free service only reports CPU while it runs, so the
    // number of 5-minute buckets with a CPU sample approximates its running time (one instance each on free).
    let hours = 0;
    for (const s of free) {
      const cpu = await call(`${RENDER}/metrics/cpu?resource=${s.id}&${q}&resolutionSeconds=300`, { headers: h });
      hours += (new Set(cpu.flatMap((series) => series.values.map((v) => v.timestamp))).size * 300) / 3600;
    }
    meters.push({ provider: "Render", meter: `free instance hours (${free.length} free services, estimated)`, used: hours, limit: 750, unit: "h" });
    meters.push({ provider: "Render", meter: "outbound bandwidth", used: mb / 1000, limit: 5, unit: "GB" });
    renderState = { headers: h, hours, services: services.map((s) => ({ id: s.id, name: s.name, suspended: s.suspended === "suspended" })) };
  }

  // --- Cloudflare: Workers + Pages Functions requests (100,000/day, shared) ---
  async function cloudflare(token, account) {
    const query = `query($a: String!, $s: Time!) { viewer { accounts(filter: {accountTag: $a}) {
      workersInvocationsAdaptive(limit: 1000, filter: {datetime_geq: $s}) { sum { requests } dimensions { scriptName } }
      pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: {datetime_geq: $s}) { sum { requests } }
    } } }`;
    const d = await call("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { a: account, s: day.toISOString() } }),
    });
    if (d.errors?.length) throw new Error(d.errors.map((e) => e.message).join("; "));
    const acc = d.data.viewer.accounts[0] ?? {};
    const workers = (acc.workersInvocationsAdaptive ?? []).reduce((s, r) => s + r.sum.requests, 0);
    const pages = (acc.pagesFunctionsInvocationsAdaptiveGroups ?? []).reduce((s, r) => s + r.sum.requests, 0);
    meters.push({ provider: "Cloudflare", meter: "Workers + Pages Functions requests today (UTC)", used: workers + pages, limit: 100_000, unit: "req",
      note: `Workers ${workers}, Pages Functions ${pages}` });
  }

  // --- Neon free: 100 CU-hours/month, 5 GB egress/month, 1 GB storage per project (current period) ---
  async function neon(key, project) {
    const p = (await call(`https://console.neon.tech/api/v2/projects/${project}`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } })).project;
    meters.push({ provider: "Neon", meter: "compute", used: (p.compute_time_seconds ?? 0) / 3600, limit: 100, unit: "CU-h" });
    meters.push({ provider: "Neon", meter: "data transfer (egress)", used: (p.data_transfer_bytes ?? 0) / 1e9, limit: 5, unit: "GB" });
    meters.push({ provider: "Neon", meter: "storage", used: (p.synthetic_storage_size ?? 0) / 1e9, limit: 1, unit: "GB" });
  }

  for (const [name, ok, check] of [
    ["Render", env.RENDER_API_KEY, () => render(env.RENDER_API_KEY)],
    ["Cloudflare", env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID, () => cloudflare(env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID)],
    ["Neon", env.NEON_API_KEY && env.NEON_PROJECT_ID, () => neon(env.NEON_API_KEY, env.NEON_PROJECT_ID)],
  ]) {
    if (!ok) {
      notes.push(`${name}: not checked (credentials not set)`);
      continue;
    }
    try {
      await check();
    } catch (e) {
      notes.push(`${name}: not checked (${e.message})`);
    }
  }

  const gh = env.GITHUB_TOKEN && env.GITHUB_REPOSITORY
    ? { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" }, repo: `${GITHUB}/repos/${env.GITHUB_REPOSITORY}` }
    : undefined;
  const write = (url, init) => (dryRun ? Promise.resolve({}) : call(url, init));

  // --- Render hours guard ---
  if (renderState) {
    const pausedIssues = [];
    if (gh) {
      const open = await call(`${gh.repo}/issues?state=open&per_page=100`, { headers: gh.headers });
      for (const i of open) {
        const m = i.title.startsWith(GUARD_TITLE) && MARKER.exec(i.body ?? "");
        if (m) pausedIssues.push({ number: i.number, month: m[1], services: m[2].split(",") });
      }
    }
    const d = decideGuard({ hours: renderState.hours, guardAt: GUARD_AT, services: renderState.services, guardList, pausedIssues, now });
    for (const r of d.resume) {
      actions.push(`resume ${r.service.name} (paused in an earlier month, issue #${r.issue})`);
      await write(`${RENDER}/services/${r.service.id}/resume`, { method: "POST", headers: renderState.headers });
    }
    for (const n of d.closeIssues) {
      if (!gh) continue;
      await write(`${gh.repo}/issues/${n}/comments`, { method: "POST", headers: gh.headers, body: JSON.stringify({ body: `New month (${d.month}): resumed. Free instance hours reset.` }) });
      await write(`${gh.repo}/issues/${n}`, { method: "PATCH", headers: gh.headers, body: JSON.stringify({ state: "closed" }) });
    }
    if (d.suspend) {
      const s = d.suspend;
      actions.push(`suspend ${s.name}: ${renderState.hours.toFixed(1)} h of 750 h free instance hours used (guard at ${GUARD_AT * 100} %)`);
      await write(`${RENDER}/services/${s.id}/suspend`, { method: "POST", headers: renderState.headers });
      if (gh) {
        const existing = pausedIssues.find((i) => i.month === d.month);
        const services = [...new Set([...(existing?.services ?? []), s.name])];
        const body = [
          `The Render hours guard (\`.github/workflows/budget.yml\`) suspended **${services.join(", ")}**: this workspace's free`,
          `instance hours reached ${renderState.hours.toFixed(1)} h of 750 h (guard at ${GUARD_AT * 100} %). Running out would suspend every`,
          `free service until next month. The edge answers \`backend-paused\` meanwhile, and the Tech page shows "paused this month".`,
          `The first budget run of next month resumes it and closes this issue.`,
          "",
          `<!-- render-guard month=${d.month} services=${services.join(",")} -->`,
        ].join("\n");
        if (existing) {
          await write(`${gh.repo}/issues/${existing.number}`, { method: "PATCH", headers: gh.headers, body: JSON.stringify({ body }) });
        } else {
          await write(`${gh.repo}/issues`, { method: "POST", headers: gh.headers, body: JSON.stringify({ title: `${GUARD_TITLE} ${s.name} (${d.month})`, body }) });
        }
      }
    } else if (d.over) {
      notes.push(`Render hours guard: over ${GUARD_AT * 100} %, but every listed service (${guardList.join(", ")}) is already paused.`);
    }
  }

  // --- Static-mode trip ---
  const namespace = "EDGE_FLAGS_NAMESPACE_ID" in env ? env.EDGE_FLAGS_NAMESPACE_ID : edgeFlagsNamespace();
  if (!namespace) {
    notes.push("Static-mode trip: not set up (no EDGE_FLAGS KV binding in wrangler.jsonc).");
  } else if (!(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID)) {
    notes.push("Static-mode trip: not checked (Cloudflare credentials not set).");
  } else {
    const kv = `${CLOUDFLARE}/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${namespace}/values/static_mode`;
    const auth = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
    let flagOn;
    try {
      const res = await fetchImpl(kv, { headers: auth });
      if (res.status !== 404 && !res.ok) throw new Error(`${res.status} GET static_mode`);
      flagOn = res.ok && ["1", "true", "yes", "on"].includes((await res.text()).trim().toLowerCase());
    } catch (e) {
      notes.push(`Static-mode trip: not checked (${e.message}).`);
    }
    if (flagOn !== undefined) {
      const d = decideStatic({ meters, staticAt: STATIC_AT, flagOn });
      if (flagOn) notes.push("Static mode is ON (EDGE_FLAGS static_mode=true). It stays on until switched back by hand (see its issue).");
      if (d.switchOn) {
        const why = d.tripped.map((m) => `${m.provider} ${m.meter}: ${m.used.toFixed(m.unit === "req" ? 0 : 2)} ${m.unit} of ${m.limit} ${m.unit} (${((m.used / m.limit) * 100).toFixed(1)} %)`);
        actions.push(`static mode on: ${why.join("; ")}`);
        await write(kv, { method: "PUT", headers: { ...auth, "Content-Type": "text/plain" }, body: "true" });
        if (gh) {
          const body = [
            `The budget check (\`.github/workflows/budget.yml\`) switched the edge to **static mode**: at least one meter passed`,
            `${STATIC_AT * 100} % of its free allowance.`,
            "",
            ...why.map((w) => `- ${w}`),
            "",
            "Static mode serves cached answers of any age and sends nothing to the backends (other requests get 503",
            "`static-mode`). The edge picks the flag up within about a minute. **It never switches back by itself.**",
            "",
            "To switch back once the cause is handled, set the KV key `static_mode` to `false` (the edge follows within a minute):",
            "```sh",
            "CLOUDFLARE_API_TOKEN=\"$(security find-generic-password -s cloudflare-api-token -w)\" \\",
            `  npx wrangler kv key put static_mode false --namespace-id ${namespace} --remote`,
            "```",
            "or in the Cloudflare dashboard: Storage & Databases → Workers KV → typhoon-replay-edge-flags → `static_mode` → `false`.",
            "Then close this issue.",
          ].join("\n");
          await write(`${gh.repo}/issues`, { method: "POST", headers: gh.headers, body: JSON.stringify({ title: `${STATIC_TITLE} (${now.toISOString().slice(0, 10)})`, body }) });
        }
      }
    }
  }

  // --- Report ---
  let over = false;
  const lines = [
    `## Free-tier usage, ${now.toISOString().slice(0, 10)} (month ${Math.round(fraction * 100)} % elapsed)`,
    "",
    "| Provider | Meter | Used | Free limit | Share | Month-end projection |",
    "|---|---|---|---|---|---|",
  ];
  for (const m of meters) {
    const share = m.used / m.limit;
    const daily = m.unit === "req";
    const projected = daily ? share : share / Math.max(fraction, 1 / 31);
    const flag = share >= WARN_AT || (!daily && projected >= 1) ? " ⚠️" : "";
    if (flag) over = true;
    lines.push(`| ${m.provider} | ${m.meter}${m.note ? ` (${m.note})` : ""} | ${m.used.toFixed(daily ? 0 : 2)} ${m.unit} | ${m.limit} ${m.unit} | ${(share * 100).toFixed(1)} %${flag} | ${daily ? "per day" : `${(projected * 100).toFixed(0)} %`} |`);
  }
  if (actions.length) lines.push("", `Actions${dryRun ? " (dry run, nothing changed)" : ""}:`, ...actions.map((a) => `- ${a}`));
  if (notes.length) lines.push("", ...notes.map((s) => `- ${s}`));
  lines.push("", `Warning threshold: ${WARN_AT * 100} % of a limit, or a month-end projection over 100 %. Guard: ${GUARD_AT * 100} % of Render hours pauses, in order: ${guardList.join(", ") || "(none)"}. Static mode: ${STATIC_AT * 100} % of Render bandwidth, Neon compute or the daily Workers requests.`);
  log(lines.join("\n"));
  return { over, actions };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { over } = await run({ dryRun: process.argv.includes("--dry-run") });
  process.exit(over ? 2 : 0);
}
