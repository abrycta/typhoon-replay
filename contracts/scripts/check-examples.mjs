// Validate every example in the bundled contract (dist/openapi.json; run `npm run bundle` first) against the
// schema it illustrates, with JSON Schema 2020-12 and formats enforced:
//   - media-type `example` / `examples` (named examples, $refs to components.examples resolved) on responses
//     and request bodies;
//   - parameter and header `example` / `examples`;
//   - schema-level `examples` arrays.
// Strict about undeclared properties too: the contract's objects are open for tolerant readers (portable subset),
// so JSON Schema alone accepts any extra field, but an example that carries one documents a field that doesn't
// exist (usually a stale one). Redocly's no-invalid-*-examples rules allow extra properties and skip formats.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(root, 'dist/openapi.json'), 'utf8'));

const deref = (x) => {
  let o = x;
  for (let i = 0; o && typeof o === 'object' && typeof o.$ref === 'string' && i < 10; i++) {
    o = o.$ref
      .replace(/^#\//, '')
      .split('/')
      .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((acc, k) => acc?.[k], spec);
  }
  return o;
};

/** A copy of the components where every object schema that lists its properties rejects undeclared ones. */
function closeObjects(node) {
  if (Array.isArray(node)) return node.map(closeObjects);
  if (!node || typeof node !== 'object') return node;
  const out = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === 'examples' || k === 'example' ? v : closeObjects(v)]));
  const composed = out.allOf || out.oneOf || out.anyOf;
  if (out.properties && !composed && out.additionalProperties === undefined && out.unevaluatedProperties === undefined) {
    out.unevaluatedProperties = false;
  }
  if (composed && out.unevaluatedProperties === undefined) out.unevaluatedProperties = false;
  return out;
}

const ajv = new Ajv2020({ strict: false, allErrors: true, discriminator: true });
addFormats(ajv);
// OpenAPI-only keywords that are not JSON Schema.
for (const k of ['example', 'xml', 'externalDocs']) ajv.addKeyword(k);
ajv.addSchema({ $id: 'openapi', components: closeObjects(spec.components) });

const ref = (schema) => (schema?.$ref?.startsWith('#/') ? { $ref: `openapi${schema.$ref}` } : { $id: undefined, ...closeObjects(schema), $defs: undefined });
const problems = [];
let checked = 0;
// Examples that state the contract version must state this one: Prism serves them as the mock's answers, and the
// conformance suite (IMPL=mock) expects X-Contract-Version and meta to match info.version.
const version = spec.info.version;
function checkVersion(where, value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.contractVersion === 'string' && value.contractVersion !== version) {
    problems.push(`${where}/contractVersion: ${value.contractVersion}, but the contract is ${version}`);
  }
  if (typeof value.openapi === 'string' && typeof value.info?.version === 'string' && value.info.version !== version) {
    problems.push(`${where}/info/version: ${value.info.version}, but the contract is ${version}`);
  }
}
function check(where, schema, value) {
  if (!schema || value === undefined) return;
  checked++;
  checkVersion(where, value);
  if (/header X-Contract-Version/i.test(where) && value !== version) problems.push(`${where}: ${value}, but the contract is ${version}`);
  const validate = ajv.compile(schema.$ref ? ref(schema) : { ...closeObjects(rewrite(schema)) });
  if (!validate(value)) {
    for (const e of validate.errors ?? []) {
      const extra = e.params?.unevaluatedProperty ? ` '${e.params.unevaluatedProperty}'` : '';
      problems.push(`${where}${e.instancePath || ''}: ${e.message}${extra}`);
    }
  }
}
/** Point inline schemas' internal $refs at the registered components. */
function rewrite(node) {
  if (Array.isArray(node)) return node.map(rewrite);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === '$ref' && typeof v === 'string' && v.startsWith('#/') ? `openapi${v}` : rewrite(v)]));
}

function checkExamples(where, holder, schema) {
  const h = deref(holder);
  if (!h) return;
  const s = schema ?? h.schema;
  if (h.example !== undefined) check(`${where} example`, s, h.example);
  for (const [name, ex] of Object.entries(h.examples ?? {})) {
    const e = deref(ex);
    if (e && 'value' in e) check(`${where} examples.${name}`, s, e.value);
  }
}

for (const [path, item] of Object.entries(spec.paths)) {
  for (const p of item.parameters ?? []) checkExamples(`${path} parameter ${deref(p).name}`, p);
  for (const [method, op] of Object.entries(item)) {
    if (!op || typeof op !== 'object' || !op.responses) continue;
    const at = `${method.toUpperCase()} ${path}`;
    for (const p of op.parameters ?? []) checkExamples(`${at} parameter ${deref(p).name}`, p);
    for (const [type, media] of Object.entries(deref(op.requestBody)?.content ?? {})) checkExamples(`${at} request ${type}`, media);
    for (const [status, r] of Object.entries(op.responses)) {
      const res = deref(r);
      for (const [name, hdr] of Object.entries(res?.headers ?? {})) checkExamples(`${at} ${status} header ${name}`, hdr);
      for (const [type, media] of Object.entries(res?.content ?? {})) {
        // An event stream's examples are SSE text, not instances of the schema.
        if (type === 'text/event-stream') continue;
        checkExamples(`${at} ${status} ${type}`, media);
      }
    }
  }
}
// Schema-level `examples` and (OpenAPI 3.0-style) `example`, at any depth, against the schema that carries them.
function schemaExamples(node, at) {
  if (Array.isArray(node)) return node.forEach((n, i) => schemaExamples(n, `${at}/${i}`));
  if (!node || typeof node !== 'object') return;
  const { example, examples, ...schema } = node;
  if (example !== undefined) check(`${at} example`, schema, example);
  if (Array.isArray(examples)) examples.forEach((ex, i) => check(`${at} examples[${i}]`, schema, ex));
  for (const [k, v] of Object.entries(schema)) schemaExamples(v, `${at}/${k}`);
}
schemaExamples(spec.components.schemas ?? {}, 'components.schemas');

// Event-stream examples: each frame's `data:` is JSON for the schema its `event:` names in x-sse-events.
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    const events = op?.['x-sse-events'];
    const media = deref(op?.responses?.['200'])?.content?.['text/event-stream'];
    if (!events || !media) continue;
    const texts = [media.example, ...Object.values(media.examples ?? {}).map((e) => deref(e)?.value)].filter((x) => typeof x === 'string');
    for (const text of texts) {
      for (const frame of text.split(/\n\n+/)) {
        const event = /^event: ?(.*)$/m.exec(frame)?.[1] ?? 'message';
        const data = [...frame.matchAll(/^data: ?(.*)$/gm)].map((m) => m[1]).join('\n');
        if (!data) continue;
        const at = `${method.toUpperCase()} ${path} text/event-stream event ${event}`;
        if (!events[event]) problems.push(`${at}: event not declared in x-sse-events`);
        else {
          try {
            check(at, events[event], JSON.parse(data));
          } catch (e) {
            problems.push(`${at}: data is not JSON (${e.message})`);
          }
        }
      }
    }
  }
}

// Cursor examples must be usable as they stand: Schemathesis (positive_data_acceptance) sends each one with the
// operation's other examples, so a cursor made for another sort is a valid-looking request the API rejects (400
// invalid-cursor). Check the decoded `[1, "<sort>", <keyset...>, "<lastId>"]` against the operation's default sort.
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (!op || typeof op !== 'object' || !op.responses) continue;
    const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(deref);
    const cursor = params.find((p) => p?.name === 'cursor' && p.in === 'query');
    if (cursor?.example === undefined) continue;
    const at = `${method.toUpperCase()} ${path} parameter cursor example`;
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(cursor.example, 'base64url').toString('utf8'));
    } catch {
      problems.push(`${at}: not base64url JSON`);
      continue;
    }
    if (!Array.isArray(decoded) || decoded[0] !== 1 || typeof decoded[1] !== 'string' || decoded.length < 4 || typeof decoded.at(-1) !== 'string') {
      problems.push(`${at}: not [1, "<sort>", <keyset...>, "<lastId>"]: ${JSON.stringify(decoded)}`);
      continue;
    }
    const sort = params.find((p) => p?.name === 'sort' && p.in === 'query');
    const expected = sort ? (sort.example ?? sort.schema?.default) : undefined;
    if (expected !== undefined && decoded[1] !== expected) problems.push(`${at}: made for sort "${decoded[1]}", but the operation's sort is "${expected}"`);
    checked++;
  }
}

if (problems.length) {
  console.error(`Contract examples: ${problems.length} problem(s) in ${checked} examples\n  ` + problems.join('\n  '));
  process.exit(1);
}
console.log(`Contract examples: ${checked} examples valid against their schemas (formats and undeclared properties checked)`);
