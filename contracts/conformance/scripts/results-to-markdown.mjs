// Turns per-backend suite results into the compatibility table (README and web/ /compat).
//   node conformance/scripts/results-to-markdown.mjs [resultsDir] > compat.md
// Inputs in resultsDir (default conformance/results):
//   <impl>-scenarios.json   Vitest JSON reporter output
//   <impl>-schemathesis.xml Schemathesis JUnit report (optional)
//   <impl>-meta.json        GET /v1/meta of that backend (optional; implVersion, contractVersion)
// Also writes compat.json next to the inputs for the web page.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? new URL('../results', import.meta.url).pathname;
const IMPLS = ['java', 'node', 'rust', 'go'];
const SUITES = [
  { id: 'schemathesis', label: 'Schemathesis' },
  { id: 'headers', label: 'Headers', files: ['headers'] },
  { id: 'catalogue', label: 'Catalogue', files: ['storms', 'places'] },
  { id: 'caching', label: 'ETag / 304', files: ['caching'] },
  { id: 'problems', label: 'Errors', files: ['problems'] },
  { id: 'sse', label: 'SSE', files: ['live'] },
  { id: 'hooks', label: 'Test hooks', files: ['test-hooks'] },
];

const files = existsSync(dir) ? readdirSync(dir) : [];
const read = (f) => (files.includes(f) ? readFileSync(join(dir, f), 'utf8') : undefined);

function vitestCounts(report, fileStems) {
  const c = { passed: 0, failed: 0, skipped: 0 };
  for (const file of report.testResults ?? []) {
    const stem = file.name.split('/').pop().replace(/\.test\.ts$/, '');
    if (!fileStems.includes(stem)) continue;
    for (const t of file.assertionResults ?? []) {
      if (t.status === 'passed') c.passed++;
      else if (t.status === 'failed') c.failed++;
      else c.skipped++; // skipped, pending, todo: includes "not claimed" scenarios
    }
  }
  return c;
}

function junitCounts(xml) {
  const n = (attr) => [...xml.matchAll(new RegExp(`<testsuite\\b[^>]*\\b${attr}="(\\d+)"`, 'g'))].reduce((s, m) => s + Number(m[1]), 0);
  const tests = n('tests');
  const failed = n('failures') + n('errors');
  const skipped = n('skipped');
  return { passed: tests - failed - skipped, failed, skipped };
}

const cell = (c) => {
  if (!c) return '—';
  const total = c.passed + c.failed;
  if (total === 0) return c.skipped ? `⏭ ${c.skipped} skipped` : '—';
  return c.failed ? `❌ ${c.passed}/${total}` : `✅ ${c.passed}/${total}`;
};

const rows = [];
const json = {};
for (const impl of IMPLS) {
  const scenarios = read(`${impl}-scenarios.json`);
  const junit = read(`${impl}-schemathesis.xml`);
  const meta = read(`${impl}-meta.json`);
  if (!scenarios && !junit) continue;
  const report = scenarios ? JSON.parse(scenarios) : undefined;
  const m = meta ? JSON.parse(meta) : {};
  const result = {};
  for (const s of SUITES) {
    result[s.id] = s.id === 'schemathesis' ? (junit ? junitCounts(junit) : undefined) : report ? vitestCounts(report, s.files) : undefined;
  }
  json[impl] = { implVersion: m.implVersion, contractVersion: m.contractVersion, suites: result };
  rows.push(`| ${impl} | ${m.implVersion ?? '?'} | ${m.contractVersion ?? '?'} | ${SUITES.map((s) => cell(result[s.id])).join(' | ')} |`);
}

const header = `| Backend | Version | Contract | ${SUITES.map((s) => s.label).join(' | ')} |`;
const sep = `|${'---|'.repeat(SUITES.length + 3)}`;
const md = rows.length ? [header, sep, ...rows].join('\n') : '_No conformance results yet._';
writeFileSync(join(dir, 'compat.json'), JSON.stringify(json, null, 2) + '\n');
console.log(md);
