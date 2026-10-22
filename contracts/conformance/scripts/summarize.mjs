// Writes <resultsDir>/<impl>-conformance.json: one backend's conformance figures, from one CI run, for the
// Under the hood page's table (web/scripts/conformance-from-ci.mjs collects them from the latest main runs).
//   node conformance/scripts/summarize.mjs <impl> [resultsDir]
// Inputs in resultsDir (default conformance/results):
//   <impl>-scenarios.json            Vitest JSON reporter output (required)
//   <impl>-schemathesis.log          console output of the gating Schemathesis run (required)
//   <impl>-schemathesis-full.log     console output of the full-config run (optional, informational)
//   <impl>-schemathesis-full.xml     its JUnit report: which operations failed which check (optional)
// Env: EXCLUDED_CHECKS (comma-separated checks the gating run excludes); GITHUB_RUN_ID, GITHUB_SHA,
// GITHUB_SERVER_URL, GITHUB_REPOSITORY (set by Actions) identify the run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [impl, dirArg] = process.argv.slice(2);
if (!impl) throw new Error("usage: summarize.mjs <impl> [resultsDir]");
const dir = dirArg ?? new URL("../results", import.meta.url).pathname;
const read = (f) =>
  existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : undefined;
const need = (f) => read(f) ?? fail(`${f} is missing in ${dir}`);
function fail(msg) {
  throw new Error(msg);
}

// eslint-disable-next-line no-control-regex
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** "Test cases:" line of a Schemathesis run: "1444 generated, 1444 passed" or "979 generated, 4 found 4 unique failures". */
function schemathesisCases(log, file) {
  const m = plain(log).match(/Test cases:\s*\n\s*(\d+) generated, ([^\n]+)/);
  if (!m) fail(`no "Test cases:" summary in ${file}`);
  const total = Number(m[1]);
  const num = (re) => Number(m[2].match(re)?.[1] ?? 0);
  // "passed" is printed only when nothing failed; with failures Schemathesis reports unique failures instead.
  const failed = num(/found (\d+) unique failures?/);
  return {
    total,
    ...(failed ? {} : { passed: num(/(\d+) passed/) }),
    failed,
    skipped: num(/(\d+) skipped/),
  };
}

/** Failed operations and checks from a Schemathesis JUnit report. */
function junitFailures(xml) {
  const out = [];
  const unescape = (s) =>
    s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
  for (const tc of xml.matchAll(
    /<testcase\b[^>]*?\bname="([^"]*)"[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g,
  )) {
    for (const f of (tc[2] ?? "").matchAll(
      /<(?:failure|error)\b[^>]*>([\s\S]*?)<\/(?:failure|error)>/g,
    )) {
      const seen = new Set();
      for (const c of unescape(f[1]).matchAll(
        /^- (?:([A-Z]{2}\d{3}) )?(.+)$/gm,
      )) {
        const key = `${c[1]}|${c[2]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          operation: unescape(tc[1]),
          ...(c[1] ? { code: c[1] } : {}),
          title: c[2].trim(),
        });
      }
    }
  }
  return out;
}

const report = JSON.parse(need(`${impl}-scenarios.json`));
const scenarios = {
  total: report.numTotalTests,
  passed: report.numPassedTests,
  failed: report.numFailedTests,
  skipped: report.numPendingTests + report.numTodoTests,
};

const excludedChecks = (process.env.EXCLUDED_CHECKS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const generated = {
  ...schemathesisCases(
    need(`${impl}-schemathesis.log`),
    `${impl}-schemathesis.log`,
  ),
  excludedChecks,
};

const fullLog = read(`${impl}-schemathesis-full.log`);
const fullXml = read(`${impl}-schemathesis-full.xml`);
const full = fullLog
  ? {
      ...schemathesisCases(fullLog, `${impl}-schemathesis-full.log`),
      failures: fullXml ? junitFailures(fullXml) : [],
    }
  : undefined;

const {
  GITHUB_RUN_ID: id,
  GITHUB_SHA: sha,
  GITHUB_SERVER_URL: server,
  GITHUB_REPOSITORY: repo,
} = process.env;
const run =
  id && server && repo
    ? {
        id: Number(id),
        url: `${server}/${repo}/actions/runs/${id}`,
        sha,
        date: new Date().toISOString().slice(0, 10),
      }
    : undefined;

const out = { impl, run, scenarios, generated, ...(full ? { full } : {}) };
writeFileSync(
  join(dir, `${impl}-conformance.json`),
  JSON.stringify(out, null, 2) + "\n",
);
console.log(
  `${impl}: scenarios ${scenarios.passed}/${scenarios.total}, generated ${generated.passed}/${generated.total}` +
    (full ? `, full run ${full.failed} unique failures in ${full.total}` : ""),
);
