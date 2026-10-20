// CONTRACT-GUIDE §8: RFC 9457 problem details with stable codes.
import { describe, expect, it } from 'vitest';
import { responseErrors } from '../src/contract.ts';
import { IS_MOCK } from '../src/env.ts';
import { call, encodeCursor, get, type Res } from '../src/http.ts';
import { FIXTURE_COOKIE, PROBLEM_BASE, PROBLEM_TITLES } from '../src/fixtures.ts';

function expectProblem(res: Res, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toMatch(/^application\/problem\+json/);
  expect(res.json).toMatchObject({ type: PROBLEM_BASE + code, title: PROBLEM_TITLES[code], status, code });
  expect(res.json.requestId).toBe(res.headers.get('x-request-id'));
  expect(res.text).not.toMatch(/at [\w.$]+\(|SELECT |Exception|Traceback|panicked/);
}

describe.skipIf(IS_MOCK)('problem details [c1.0.0]', () => {
  it('rejects an out-of-range limit with validation and a field pointer', async () => {
    const res = await get('/v1/storms?limit=500');
    expectProblem(res, 400, 'validation');
    expect(responseErrors('GET', '/v1/storms', res)).toEqual([]);
    expect(res.json.errors).toEqual(expect.arrayContaining([expect.objectContaining({ pointer: '#/query/limit' })]));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects radii outside the precomputed bands', async () => {
    expectProblem(await get('/v1/places/PH-0831600000/storms?radiusKm=150'), 400, 'validation');
  });

  it('rejects season together with from/to', async () => {
    expectProblem(await get('/v1/storms?season=2013&from=2010'), 400, 'validation');
  });

  it('rejects a malformed cursor and a cursor from another sort with invalid-cursor', async () => {
    expectProblem(await get('/v1/storms?cursor=bm90LWpzb24'), 400, 'invalid-cursor');
    const nameCursor = encodeCursor([1, 'name', 'HAIYAN', '2013306N07162']);
    expectProblem(await get(`/v1/storms?sort=season-desc&cursor=${nameCursor}`), 400, 'invalid-cursor');
  });

  it('returns a cacheable 404 for an unknown storm', async () => {
    const res = await get('/v1/storms/1999001N00000');
    expectProblem(res, 404, 'not-found');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('returns problem+json (not an HTML page) for unknown routes under /v1', async () => {
    expectProblem(await get('/v1/no-such-route'), 404, 'not-found');
  });

  it('returns 401 unauthenticated without a session, and with a bogus one', async () => {
    expectProblem(await get('/v1/me'), 401, 'unauthenticated');
    expectProblem(await get('/v1/me', { cookie: '__Host-tr_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }), 401, 'unauthenticated');
  });

  it('rejects non-JSON bodies with 415 and oversized bodies with 413', async () => {
    const r415 = await call('/v1/me/places', { method: 'POST', cookie: FIXTURE_COOKIE, headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    expectProblem(r415, 415, 'unsupported-media-type');
    const big = { label: 'x', placeId: 'PH-0831600000', padding: 'y'.repeat(70 * 1024) };
    expectProblem(await call('/v1/me/places', { method: 'POST', cookie: FIXTURE_COOKIE, body: big }), 413, 'payload-too-large');
  });
});
