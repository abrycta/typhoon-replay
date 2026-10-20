// Bundle the split YAML into the published artefacts:
//   dist/openapi.json      OpenAPI 3.1, canonical; served at GET /v1/openapi.json (x-internal test hooks removed)
//   dist/openapi.3.0.json  down-converted to 3.0.3, only for generators that need it
// Then check the invariants the bundler can't: every x-sse-events entry points at a bundled component schema.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const bin = (name) => join(root, 'node_modules', '.bin', name);
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });

mkdirSync(dist, { recursive: true });
// Write each artefact once, and only when it changed, so watchers (Prism) don't reload mid-run.
const writeIfChanged = (file, text) => {
  const path = join(dist, file);
  if (!existsSync(path) || readFileSync(path, 'utf8') !== text) writeFileSync(path, text);
};

run(bin('redocly'), ['bundle', 'public', '--output', 'dist/.openapi.tmp.json', '--ext', 'json']);
const spec = JSON.parse(readFileSync(join(dist, '.openapi.tmp.json'), 'utf8'));
rmSync(join(dist, '.openapi.tmp.json'));
const problems = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!op || typeof op !== 'object' || !op['x-sse-events']) continue;
    // Redocly inlines $refs inside vendor extensions; point them back at the component (titles equal component names).
    for (const [event, schema] of Object.entries(op['x-sse-events'])) {
      if (schema && !schema.$ref && spec.components.schemas[schema.title]) {
        op['x-sse-events'][event] = { $ref: `#/components/schemas/${schema.title}` };
      }
    }
    for (const [event, ref] of Object.entries(op['x-sse-events'])) {
      const m = /^#\/components\/schemas\/([A-Za-z0-9]+)$/.exec(ref?.$ref ?? '');
      if (!m || !spec.components.schemas[m[1]]) problems.push(`${method.toUpperCase()} ${path}: x-sse-events.${event} -> ${JSON.stringify(ref)}`);
    }
  }
  if (path.includes('/_test/')) problems.push(`test hook ${path} leaked into the public bundle`);
}
if (problems.length) {
  console.error('Bundle invariants failed:\n  ' + problems.join('\n  '));
  process.exit(1);
}
// Stable formatting so the bundle diffs cleanly and is byte-identical however it is produced.
writeIfChanged('openapi.json', JSON.stringify(spec, null, 2) + '\n');

run(bin('openapi-down-convert'), ['--input', 'dist/openapi.json', '--output', 'dist/.openapi.3.0.tmp.json']);
const down = JSON.parse(readFileSync(join(dist, '.openapi.3.0.tmp.json'), 'utf8'));
rmSync(join(dist, '.openapi.3.0.tmp.json'));
// 3.1-only fields the converter leaves behind (the portable subset avoids the rest).
if (down.info.summary) {
  down.info.description = `${down.info.summary}\n\n${down.info.description ?? ''}`;
  delete down.info.summary;
}
writeIfChanged('openapi.3.0.json', JSON.stringify(down, null, 2) + '\n');

const kb = (f) => (readFileSync(join(dist, f)).length / 1024).toFixed(1);
console.log(`dist/openapi.json ${spec.openapi} v${spec.info.version} (${Object.keys(spec.paths).length} paths, ${kb('openapi.json')} KB)`);
console.log(`dist/openapi.3.0.json ${down.openapi} (${kb('openapi.3.0.json')} KB)`);
