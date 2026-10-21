// Parameter binding, driven by the contract: which parameters an operation takes, their types and constraints all
// come from src/generated (scripts/generate.mjs). Values are converted strictly (an integer is [+-]digits, a number a
// plain decimal), then checked by the operation's precompiled Ajv validator.
import { OPERATIONS, type OperationId } from '../generated/operations';
import type { operations } from '../generated/contract';
import * as validators from '../generated/validators.js';
import type { Rq } from './http';
import { invalid, Problem, type FieldProblem } from './problem';

type Params<K extends OperationId> = (operations[K]['parameters'] extends { query?: infer Q } ? NonNullable<Q> : object) &
  (operations[K]['parameters'] extends { path: infer P } ? P : object);

const INTEGER = /^[+-]?\d{1,15}$/;
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function convert(type: string, raw: string): unknown {
  if (type === 'integer') return INTEGER.test(raw) ? Number(raw) : raw;
  if (type === 'number') return DECIMAL.test(raw) ? Number(raw) : raw;
  return raw;
}

/** Names of an operation's query parameters: the ones that count for its ETag (CONTRACT-GUIDE §6). */
export const queryNames = (op: OperationId): string[] => OPERATIONS[op].params.filter((p) => p.in === 'query').map((p) => p.name);

/**
 * Bind and validate an operation's query and path parameters. The first value of a repeated parameter wins; an empty
 * value is rejected; unknown parameters are ignored. Throws 400 validation with one pointer per bad parameter.
 */
export function bind<K extends OperationId>(op: K, rq: Rq, path: Record<string, string> = {}): Params<K> {
  const spec = OPERATIONS[op];
  const data: Record<string, unknown> = {};
  const where: Record<string, string> = {};
  for (const p of spec.params) {
    where[p.name] = p.in;
    const raw = p.in === 'path' ? path[p.name] : rq.query.get(p.name)?.[0];
    if (raw === undefined) continue;
    if (p.in === 'query' && rq.query.get(p.name)!.some((v) => v === '')) throw invalid(`#/query/${p.name}`, 'must not be empty');
    data[p.name] = convert(p.type, raw);
  }
  const validate = (validators as Record<string, validators.ParamValidator>)[op]!;
  if (!validate(data)) {
    const errors: FieldProblem[] = (validate.errors ?? []).map((e) => {
      const name = e.keyword === 'required' ? String(e.params.missingProperty) : e.instancePath.split('/')[1] ?? '';
      const detail = e.keyword === 'required' ? 'is required' : e.keyword === 'enum' ? `must be one of ${(e.params.allowedValues as unknown[]).join(', ')}` : e.message ?? 'is invalid';
      return { pointer: `#/${where[name] ?? 'query'}/${name}`, detail };
    });
    const first = errors[0] ?? { pointer: '#/query', detail: 'is invalid' };
    throw new Problem('validation', `${first.pointer.replace(/^#\//, '')} ${first.detail}`, errors);
  }
  return data as Params<K>;
}
