// CONTRACT-GUIDE §7: snapshot + SSE framing, delivery, resume with Last-Event-ID.
import { afterEach, describe, expect, it } from 'vitest';
import { responseErrors, schemaErrors, spec } from '../src/contract.ts';
import { IS_MOCK, SLOW, TEST_HOOKS } from '../src/env.ts';
import { get } from '../src/http.ts';
import { applyLiveEvent } from '../src/hooks.ts';
import { openStream, type Frame, type Stream } from '../src/sse.ts';

const SSE_EVENTS: Record<string, { $ref: string }> = spec.paths['/v1/live/stream'].get['x-sse-events'];
const dataErrors = (f: Frame) => {
  const ref = SSE_EVENTS[f.event];
  return ref ? schemaErrors(ref.$ref.split('/').pop()!, JSON.parse(f.data)) : []; // unknown events are ignored
};

const advisory = (n: number) => ({
  liveId: 'jma-9901',
  name: 'Conformance',
  agency: 'jma',
  advisoryNumber: n,
  observedAt: '2026-10-21T00:00:00Z',
  position: [130.1, 18.2],
  windKt: 60 + n,
});

let open: Stream[] = [];
afterEach(() => {
  open.forEach((s) => s.close());
  open = [];
});
const stream = async (opts?: Parameters<typeof openStream>[0]) => {
  const s = await openStream(opts);
  open.push(s);
  return s;
};

describe.skipIf(IS_MOCK)('live snapshot [c1.0.0]', () => {
  it('matches the contract', async () => {
    const res = await get('/v1/live/storms');
    expect(responseErrors('GET', '/v1/live/storms', res)).toEqual([]);
  });
});

describe.skipIf(IS_MOCK || !TEST_HOOKS)('live stream [c1.0.0]', () => {
  it('starts with retry: 10000 and a schema-valid snapshot whose id is the snapshot seq', async () => {
    const s = await stream();
    expect(s.status).toBe(200);
    expect(s.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(s.headers.get('cache-control')).toBe('no-cache');
    expect(s.headers.get('x-accel-buffering')).toBe('no');
    expect(s.headers.get('content-encoding')).toBeNull();
    const first = await s.waitFor(() => true, 5_000);
    expect(s.retry).toBe(10_000);
    expect(first.event).toBe('snapshot');
    expect(dataErrors(first)).toEqual([]);
    expect(first.id).toBe(String(JSON.parse(first.data).seq));
    expect(first.data).not.toContain('\n');
  });

  it('delivers a new event within 5 s, with id = seq', async () => {
    const s = await stream();
    await s.waitFor((f) => f.event === 'snapshot', 5_000);
    const seq = await applyLiveEvent('storm-upserted', advisory(1));
    const started = Date.now();
    const f = await s.waitFor((x) => x.event === 'storm-upserted' && x.id === String(seq), 5_000);
    expect(Date.now() - started).toBeLessThanOrEqual(5_000);
    expect(dataErrors(f)).toEqual([]);
    expect(JSON.parse(f.data)).toMatchObject({ liveId: 'jma-9901', advisoryNumber: 1 });
  });

  it('resumes after Last-Event-ID with the missed events in order and no snapshot', async () => {
    const s = await stream();
    const snap = await s.waitFor((f) => f.event === 'snapshot', 5_000);
    s.close();
    const a = await applyLiveEvent('storm-upserted', advisory(2));
    const b = await applyLiveEvent('storm-removed', { liveId: 'jma-9901', reason: 'dissipated' });
    for (const opts of [{ lastEventId: snap.id }, { query: `?lastEventId=${snap.id}` }]) {
      const resumed = await stream(opts);
      await resumed.waitFor((f) => f.id === String(b), 5_000);
      const ids = resumed.frames.map((f) => f.id);
      expect(resumed.frames.some((f) => f.event === 'snapshot')).toBe(false);
      expect(ids.indexOf(String(a))).toBeLessThan(ids.indexOf(String(b)));
      resumed.frames.forEach((f) => expect(dataErrors(f)).toEqual([]));
    }
  });

  it('sends a snapshot when Last-Event-ID is outside the retained window', async () => {
    // Window: oldest retained seq - 1 <= Last-Event-ID <= live.revision.seq (CONTRACT-GUIDE §7). A future id is outside it.
    const far = await stream({ lastEventId: '999999999999' });
    expect((await far.waitFor(() => true, 5_000)).event).toBe('snapshot');
  });

  it.runIf(SLOW)('sends a comment heartbeat at least every 20 s', { timeout: 30_000 }, async () => {
    const s = await stream();
    await s.waitFor((f) => f.event === 'snapshot', 5_000);
    await s.waitForComments(1, 21_000);
  });
});
