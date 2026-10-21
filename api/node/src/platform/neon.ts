// SQL over Neon's serverless HTTP endpoint (POST https://{host}/sql): one HTTPS request per transaction, no
// connection held between requests, so Neon's compute can scale to zero (DECISIONS, "Neon over HTTP, not Hyperdrive").
//
// Every call is a batch that Neon runs as one transaction: SET LOCAL statement_timeout first (CONTRACT-GUIDE §11:
// 5 s, no session state), then the caller's statements. Values come back as Postgres text (Neon-Raw-Text-Output), so
// numbers keep their exact decimal form, and rows as arrays (Neon-Array-Mode).
import type { Env } from './env';

/** One compiled statement ($1, $2, … placeholders). */
export interface Query {
  sql: string;
  parameters: readonly unknown[];
}

/** A result: text values by column name (null = SQL NULL). */
export class Rows {
  private readonly index: Map<string, number>;
  constructor(
    fields: string[],
    readonly data: (string | null)[][],
  ) {
    this.index = new Map(fields.map((f, i) => [f, i]));
  }
  get length(): number {
    return this.data.length;
  }
  row(i: number): Row {
    return new Row(this.index, this.data[i]!);
  }
  *[Symbol.iterator](): IterableIterator<Row> {
    for (let i = 0; i < this.data.length; i++) yield this.row(i);
  }
}

export class Row {
  constructor(
    private readonly index: Map<string, number>,
    private readonly values: (string | null)[],
  ) {}
  /** A nullable column. */
  n(name: string): string | null {
    const i = this.index.get(name);
    if (i === undefined) throw new Error(`no column ${name}`);
    return this.values[i] ?? null;
  }
  /** A column that is never NULL. */
  s(name: string): string {
    return this.n(name) ?? '';
  }
  /** A nullable numeric column as a JSON number (undefined when NULL, so the member is omitted). */
  num(name: string): number | undefined {
    const v = this.n(name);
    return v === null ? undefined : Number(v);
  }
  /** A nullable text column (undefined when NULL). */
  opt(name: string): string | undefined {
    return this.n(name) ?? undefined;
  }
  bool(name: string): boolean {
    return this.n(name) === 't';
  }
}

/** A failed batch. `unavailable` means the database can't be reached right now (503 not-ready, not 500). */
export class NeonError extends Error {
  constructor(
    message: string,
    readonly unavailable: boolean,
    readonly status = 0,
    readonly code = '',
  ) {
    super(message);
  }
}

const TIMEOUT = 'SET LOCAL statement_timeout = 5000';

/** The SQL endpoint for DATABASE_URL: NEON_HTTP_URL when set, else https://{host}/sql. */
function endpoint(env: Env): string {
  if (env.NEON_HTTP_URL) return env.NEON_HTTP_URL;
  try {
    return `https://${new URL(env.DATABASE_URL ?? '').hostname}/sql`;
  } catch {
    throw new NeonError('DATABASE_URL is not a postgres URL', true);
  }
}

/** Parameters go over the wire as text (or null); SQL casts them where the type matters. */
const wire = (p: unknown): string | null =>
  p === null || p === undefined ? null : typeof p === 'string' ? p : typeof p === 'object' ? JSON.stringify(p) : String(p);

/** Run statements in one transaction (read-only unless `write`) and return one result per statement. */
export async function batch(env: Env, queries: Query[], opts: { write?: boolean; signal?: AbortSignal } = {}): Promise<Rows[]> {
  if (!env.DATABASE_URL) throw new NeonError('DATABASE_URL is not set', true);
  const body = JSON.stringify({
    queries: [{ query: TIMEOUT, params: [] }, ...queries.map((q) => ({ query: q.sql, params: q.parameters.map(wire) }))],
  });
  let res: Response;
  try {
    res = await fetch(endpoint(env), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Neon-Connection-String': env.DATABASE_URL,
        'Neon-Raw-Text-Output': 'true',
        'Neon-Array-Mode': 'true',
        'Neon-Batch-Read-Only': String(!opts.write),
        'Neon-Batch-Isolation-Level': 'ReadCommitted',
      },
      body,
      signal: opts.signal,
    });
  } catch (e) {
    throw new NeonError(`fetch failed: ${(e as Error).message}`, true);
  }
  const text = await res.text();
  if (res.status !== 200) {
    let err: { message?: string; code?: string } = {};
    try {
      err = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    const code = err.code ?? '';
    throw new NeonError(err.message ?? `HTTP ${res.status}`, unavailable(res.status, code), res.status, code);
  }
  const out = JSON.parse(text) as { results: { fields: { name: string }[]; rows: (string | null)[][] }[] };
  if (out.results.length !== queries.length + 1) throw new NeonError('unexpected result count', false, res.status);
  return out.results.slice(1).map((r) => new Rows(r.fields.map((f) => f.name), r.rows));
}

/**
 * The proxy could not reach a compute (5xx, rate limits), or Postgres refused the connection (class 08 connection
 * exceptions, 53300 too many connections, 57P0x shutdown / cannot connect now).
 */
function unavailable(status: number, code: string): boolean {
  return status >= 500 || status === 429 || code.startsWith('08') || code === '53300' || code.startsWith('57P0');
}
