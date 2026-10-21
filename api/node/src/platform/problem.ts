// RFC 9457 problem details with the contract's stable codes (CONTRACT-GUIDE §8).
import type { components } from '../generated/contract';

export type ProblemCode = components['schemas']['ProblemCode'];

const TYPES = {
  validation: [400, 'Request validation failed'],
  'invalid-cursor': [400, 'Invalid cursor'],
  'not-found': [404, 'Not found'],
  'method-not-allowed': [405, 'Method not allowed'],
  'not-acceptable': [406, 'Not acceptable'],
  'payload-too-large': [413, 'Payload too large'],
  'unsupported-media-type': [415, 'Unsupported media type'],
  'rate-limited': [429, 'Too many requests'],
  internal: [500, 'Internal server error'],
  'not-ready': [503, 'Service not ready'],
  'stream-capacity': [503, 'Too many live streams'],
} as const satisfies Partial<Record<ProblemCode, readonly [number, string]>>;

export type Code = keyof typeof TYPES;

/** Problem `type` URI base (contract 2.0.2). */
export const TYPE_BASE = 'https://replay.krtmtthw.dev/problems/';

export interface FieldProblem {
  pointer: string;
  detail: string;
}

/** Any failure that reaches the client as a problem document. Thrown by handlers, rendered by the app's onError. */
export class Problem extends Error {
  readonly status: number;
  constructor(
    readonly code: Code,
    readonly detail: string,
    readonly errors: FieldProblem[] = [],
    readonly headers: Record<string, string> = {},
  ) {
    super(`${code}: ${detail}`);
    this.status = TYPES[code][0];
  }

  body(instance: string, requestId: string): string {
    const doc: components['schemas']['Problem'] = {
      type: TYPE_BASE + this.code,
      title: TYPES[this.code][1],
      status: this.status,
      ...(this.detail.trim() ? { detail: this.detail } : {}),
      instance,
      code: this.code,
      requestId,
      ...(this.errors.length ? { errors: this.errors.slice(0, 50) } : {}),
    };
    return JSON.stringify(doc);
  }
}

/** 400 validation for one input. */
export const invalid = (pointer: string, detail: string) =>
  new Problem('validation', `${pointer.replace(/^#\//, '')} ${detail}`, [{ pointer, detail }]);

/** 400 invalid-cursor. */
export const badCursor = (detail: string) => new Problem('invalid-cursor', detail, [{ pointer: '#/query/cursor', detail }]);

/** 404 not-found. */
export const missing = (detail: string) => new Problem('not-found', detail);
