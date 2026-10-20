// Validates responses against the bundled contract (dist/openapi.json) with JSON Schema 2020-12.
import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { Res } from './http.ts';

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;
const SPEC_ID = 'https://typhoon-replay.pages.dev/openapi.json';
export const spec = JSON.parse(readFileSync(new URL('../../dist/openapi.json', import.meta.url), 'utf8'));
export const CONTRACT_VERSION: string = spec.info.version;

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv);
ajv.addSchema({ ...spec, $id: SPEC_ID });

const cache = new Map<string, ValidateFunction>();
const validator = (pointer: string): ValidateFunction => {
  let v = cache.get(pointer);
  if (!v) {
    const fn = ajv.getSchema(`${SPEC_ID}#${pointer}`);
    if (!fn) throw new Error(`No schema at ${pointer}`);
    v = fn;
    cache.set(pointer, v);
  }
  return v;
};

const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');

/** Errors (empty when valid) for `value` against a component schema, e.g. schemaErrors('LiveSnapshot', data). */
export function schemaErrors(component: string, value: unknown): string[] {
  const v = validator(`/components/schemas/${component}`);
  return v(value) ? [] : (v.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

/**
 * Errors (empty when valid) for a response against the documented response of `method path`:
 * the status must be documented, the media type must match, the body must match the schema,
 * and every required header must be present.
 */
export function responseErrors(method: string, path: string, res: Res): string[] {
  const op = spec.paths[path]?.[method.toLowerCase()];
  if (!op) return [`operation ${method} ${path} not in contract`];
  const raw = op.responses[String(res.status)];
  if (!raw) return [`status ${res.status} not documented for ${method} ${path}`];
  // JSON pointer of the response object, following a components/responses $ref.
  const pointer = raw.$ref ? raw.$ref.slice(1) : `/paths/${esc(path)}/${method.toLowerCase()}/responses/${res.status}`;
  const response = raw.$ref ? resolve(raw.$ref) : raw;
  const errors: string[] = [];
  for (const [name, h] of Object.entries<any>(response.headers ?? {})) {
    const header = h.$ref ? resolve(h.$ref) : h;
    if (header.required && !res.headers.has(name)) errors.push(`missing required header ${name}`);
  }
  const types = Object.keys(response.content ?? {});
  if (types.length === 0) return errors;
  const got = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
  if (!types.includes(got)) return [...errors, `content-type ${got} not in ${types.join(', ')}`];
  if (/^application\/(json|problem\+json|geo\+json)$/.test(got)) {
    const fn = validator(`${pointer}/content/${esc(got)}/schema`);
    if (!fn(res.json)) errors.push(...(fn.errors ?? []).map((e) => `body${e.instancePath} ${e.message}`));
  }
  return errors;
}

function resolve(ref: string): any {
  return ref
    .slice(2)
    .split('/')
    .reduce((node: any, key) => node[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
}
