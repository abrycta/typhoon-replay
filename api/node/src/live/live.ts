// Live: GET /v1/live/storms (snapshot), GET /v1/live/stream (SSE, CONTRACT-GUIDE §7) and the test hook
// POST /v1/_test/live-events.
//
// Stream limits on Workers: an invocation may make 50 subrequests on the free plan, and every poll is one HTTPS
// round trip to Neon. So a stream polls every 2 s (inside the 5 s delivery rule) and ends after 90 s (1 + 45 Neon
// requests); EventSource then reconnects with Last-Event-ID and resumes without a snapshot. With no stream open,
// nothing touches the database. Every stream is its own invocation, so there is no shared stream cap to enforce.
import { etagMatches } from '../platform/etag';
import { IDENTITY, JSON_TYPE, notModified, send, type Rq } from '../platform/http';
import { batch, type Row, type Rows } from '../platform/neon';
import { bind } from '../platform/params';
import { invalid, missing, Problem } from '../platform/problem';
import { q, sql, ts } from '../catalog/sql';

const snapshotSQL = sql`SELECT r.seq,
    CASE WHEN r.seq > 0 THEN ${ts('r.updated_at')} ELSE ${ts('now()')} END AS as_of,
    (SELECT coalesce(jsonb_agg(a.storm ORDER BY a.live_id), '[]'::jsonb) FROM live.active_storm a)::text AS storms
  FROM live.revision r WHERE r.singleton`;

/** The resume window: oldest retained seq - 1 <= id <= revision. */
const inWindow = (id: string) =>
  sql`SELECT ${id}::bigint BETWEEN coalesce((SELECT min(seq) FROM live.live_event), r.seq + 1) - 1 AND r.seq AS ok
      FROM live.revision r WHERE r.singleton`;
const eventsAfter = (seq: string) =>
  sql`SELECT seq, type, payload::text AS payload FROM live.live_event WHERE seq > ${seq}::bigint ORDER BY seq LIMIT 1000`;
const revisionSQL = sql`SELECT seq FROM live.revision WHERE singleton`;

const POLL_MS = 2_000;
const HEARTBEAT_MS = 15_000;
const LIFETIME_MS = 90_000;
const RETRY_MS = 10_000;

/** LiveSnapshot JSON; the storms array is spliced in as the jsonb text Postgres wrote (one line). */
const snapshotJSON = (row: Row) => `{"asOf":${JSON.stringify(row.s('as_of'))},"seq":${Number(row.s('seq'))},"storms":${row.s('storms')}}`;

/** GET /v1/live/storms: no-cache with ETag W/"s{seq}". */
export async function getLiveSnapshot(rq: Rq): Promise<Response> {
  const [rows] = await batch(rq.env, [q(snapshotSQL)]);
  const row = rows!.row(0);
  const etag = `W/"s${row.s('seq')}"`;
  if (etagMatches(rq.ifNoneMatch, etag)) return notModified(rq, etag);
  return send(rq, 200, snapshotJSON(row), JSON_TYPE, { ETag: etag });
}

/** Last-Event-ID: 1–19 digits; a value beyond any seq is simply outside the window (a snapshot follows). */
function eventId(raw: string, pointer: string): string {
  if (!/^[0-9]{1,19}$/.test(raw)) throw invalid(pointer, 'must be 1-19 digits');
  return BigInt(raw) > 9223372036854775807n ? '9223372036854775807' : raw;
}

/** SSE frames for the events after `after`; returns the frames and the newest seq written. */
function frames(rows: Rows, after: string): { text: string; last: string } {
  let text = '';
  let last = after;
  for (const e of rows) {
    const seq = e.s('seq');
    if (BigInt(seq) <= BigInt(last)) continue;
    text += `id: ${seq}\nevent: ${e.s('type')}\ndata: ${e.s('payload')}\n\n`;
    last = seq;
  }
  return { text, last };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET /v1/live/stream (SSE). The Last-Event-ID header wins over ?lastEventId=. */
export async function streamLiveEvents(rq: Rq): Promise<Response> {
  const p = bind('streamLiveEvents', rq);
  const header = rq.request.headers.get('Last-Event-ID');
  const last = header !== null ? eventId(header, '#/header/Last-Event-ID') : p.lastEventId;

  // Snapshot or resume is decided before the stream opens, so a failing database gives a problem response.
  let first = `retry: ${RETRY_MS}\n`;
  let sent: string | undefined;
  if (last !== undefined) {
    const [win, events] = await batch(rq.env, [q(inWindow(last)), q(eventsAfter(last))]);
    if (win!.length > 0 && win!.row(0).bool('ok')) {
      const f = frames(events!, last);
      first += `\n${f.text}`;
      sent = f.last;
    }
  }
  if (sent === undefined) {
    const [rows] = await batch(rq.env, [q(snapshotSQL)]);
    const row = rows!.row(0);
    sent = row.s('seq');
    first += `id: ${sent}\nevent: snapshot\ndata: ${snapshotJSON(row)}\n\n`;
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const env = rq.env;
  const pump = async (cursor: string) => {
    await writer.write(enc.encode(first));
    const started = Date.now();
    let lastWrite = Date.now();
    while (Date.now() - started < LIFETIME_MS) {
      await sleep(POLL_MS);
      let out = '';
      try {
        const [rev, events] = await batch(env, [q(revisionSQL), q(eventsAfter(cursor))]);
        if (rev!.length > 0 && BigInt(rev!.row(0).s('seq')) > BigInt(cursor)) {
          const f = frames(events!, cursor);
          out = f.text;
          cursor = f.last;
        }
      } catch {
        // A failed poll is retried on the next tick; the client sees only a later delivery.
      }
      if (!out && Date.now() - lastWrite >= HEARTBEAT_MS) out = ':\n\n';
      if (out) {
        await writer.write(enc.encode(out));
        lastWrite = Date.now();
      }
    }
  };
  pump(sent)
    .catch(() => undefined) // the client went away
    .finally(() => writer.close().catch(() => undefined));

  rq.status = 200;
  return new Response(readable, {
    status: 200,
    headers: {
      'X-Backend-Impl': IDENTITY.impl,
      'X-Backend-Version': IDENTITY.implVersion,
      'X-Contract-Version': IDENTITY.contractVersion,
      'X-Request-Id': rq.requestId,
      Vary: 'Accept-Encoding',
      'Cache-Control': 'no-cache',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

const MAX_BODY = 64 * 1024;

/**
 * POST /v1/_test/live-events {type, payload} → 201 {seq}, through live.apply_event (the ingestion job's own write
 * path). Only with TR_TEST_HOOKS=1; otherwise 404 not-found.
 */
export async function testLiveEvent(rq: Rq): Promise<Response> {
  if (rq.method !== 'POST') {
    throw new Problem('method-not-allowed', `Method ${rq.method} is not supported here.`, [], { Allow: 'POST, OPTIONS' });
  }
  const tooLarge = new Problem('payload-too-large', 'Request bodies are limited to 64 KB.', [], { Connection: 'close' });
  if (Number(rq.request.headers.get('Content-Length') ?? 0) > MAX_BODY) throw tooLarge;
  const raw = await rq.request.arrayBuffer();
  if (raw.byteLength > MAX_BODY) throw tooLarge;
  if (!(rq.request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
    throw new Problem('unsupported-media-type', 'Request bodies must be application/json.');
  }
  if (rq.env.TR_TEST_HOOKS !== '1') throw missing('No such resource.');
  let input: { type?: unknown; payload?: unknown };
  try {
    input = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw invalid('#/body', 'is not valid JSON for this operation');
  }
  if (input.type !== 'storm-upserted' && input.type !== 'storm-removed') {
    throw invalid('#/body/type', 'must be storm-upserted or storm-removed');
  }
  const payload = input.payload as { liveId?: unknown } | null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.liveId !== 'string') {
    throw invalid('#/body/payload', 'must be an object with liveId');
  }
  const [rows] = await batch(rq.env, [q(sql`SELECT live.apply_event(${input.type}, ${JSON.stringify(payload)}::jsonb) AS seq`)], {
    write: true,
  });
  return send(rq, 201, JSON.stringify({ seq: Number(rows!.row(0).s('seq')) }));
}
