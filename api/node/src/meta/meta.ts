// Meta and probes: GET /healthz, /readyz, /v1/meta, /v1/openapi.json.
import impl from '../../impl.json';
import type { components } from '../generated/contract';
import { OPENAPI_JSON } from '../generated/openapi';
import { etagMatches } from '../platform/etag';
import { IDENTITY, log, notModified, send, type Rq } from '../platform/http';
import { batch } from '../platform/neon';
import { Problem } from '../platform/problem';
import { q, sql } from '../catalog/sql';

type Schemas = components['schemas'];

const metaSQL = sql`SELECT (SELECT max(version) FROM public.schema_migrations) AS schema_version,
  coalesce((SELECT version FROM catalog.current_dataset_version), 0) AS dataset_version`;

/** When this isolate served its first request (Workers report the epoch for Date.now() at module load). */
let startedAt: string | undefined;
export const markStarted = () => {
  startedAt ??= new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
};

/** W/"c{contractVersion}-{impl}-{implVersion}" (CONTRACT-GUIDE §6). */
const bundleTag = `c${IDENTITY.contractVersion}-${IDENTITY.impl}-${IDENTITY.implVersion}`;

/** GET /healthz: liveness, no database access. */
export async function getHealth(rq: Rq): Promise<Response> {
  const body: Schemas['Health'] = { status: 'ok', impl: IDENTITY.impl };
  return send(rq, 200, JSON.stringify(body));
}

/** GET /readyz: the database answers and its schema is at least minSchemaVersion. */
export async function getReadiness(rq: Rq): Promise<Response> {
  let applied = '';
  try {
    const [rows] = await batch(rq.env, [q(metaSQL)]);
    applied = rows!.row(0).s('schema_version');
  } catch (e) {
    log('warn', (e as Error).message, rq);
  }
  if (!applied || applied < impl.minSchemaVersion) {
    const detail = applied ? `Database schema is older than ${impl.minSchemaVersion}.` : 'Database unreachable or not migrated.';
    throw new Problem('not-ready', detail, [], { 'Retry-After': '5' });
  }
  const body: Schemas['Readiness'] = { status: 'ready', impl: IDENTITY.impl, schemaVersion: applied, minSchemaVersion: impl.minSchemaVersion };
  return send(rq, 200, JSON.stringify(body));
}

/** GET /v1/meta: the ETag carries the dataset version, since the body does (contract 2.0.1). */
export async function getMeta(rq: Rq): Promise<Response> {
  const [rows] = await batch(rq.env, [q(metaSQL)]);
  const row = rows!.row(0);
  const version = row.s('dataset_version');
  const etag = `W/"${bundleTag}-d${version}"`;
  if (etagMatches(rq.ifNoneMatch, etag)) return notModified(rq, etag);
  const body: Schemas['Meta'] = {
    impl: IDENTITY.impl,
    implVersion: IDENTITY.implVersion,
    contractVersion: IDENTITY.contractVersion,
    schemaVersion: row.n('schema_version') ?? '00000000000000',
    datasetVersion: Number(version),
    commit: rq.env.TR_COMMIT || 'unknown',
    startedAt: startedAt!,
  };
  return send(rq, 200, JSON.stringify(body), undefined, { ETag: etag });
}

/** GET /v1/openapi.json: the contract bundle, byte for byte. */
export async function getOpenApiDocument(rq: Rq): Promise<Response> {
  const etag = `W/"${bundleTag}"`;
  if (etagMatches(rq.ifNoneMatch, etag)) return notModified(rq, etag);
  return send(rq, 200, OPENAPI_JSON, undefined, { ETag: etag });
}
