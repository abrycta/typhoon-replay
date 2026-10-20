// CONTRACT-GUIDE §8: RFC 9457 problem details with stable codes.
import { describe, expect, it } from 'vitest';
import { responseErrors } from '../src/contract.ts';
import { IS_MOCK, TEST_HOOKS } from '../src/env.ts';
import { call, encodeCursor, get, type Res } from '../src/http.ts';
import { PROBLEM_BASE, PROBLEM_TITLES } from '../src/fixtures.ts';

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

  it.runIf(TEST_HOOKS)('rejects non-JSON bodies with 415 and oversized bodies with 413', async () => {
    const r415 = await call('/v1/_test/live-events', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    expectProblem(r415, 415, 'unsupported-media-type');
    const big = { type: 'storm-removed', payload: { liveId: 'x', reason: 'dissipated', padding: 'y'.repeat(70 * 1024) } };
    expectProblem(await call('/v1/_test/live-events', { method: 'POST', body: big }), 413, 'payload-too-large');
  });
});

// CONTRACT-GUIDE §9, §14: contract 2.0.0 has no accounts, so the v1 account routes are unknown routes.
describe.skipIf(IS_MOCK)('no accounts [c2.0.0]', () => {
  it.each([
    ['GET', '/v1/me'],
    ['DELETE', '/v1/me'],
    ['GET', '/v1/me/places'],
    ['POST', '/v1/me/places'],
    ['PATCH', '/v1/me/places/0192f5a0-0000-7000-8000-000000000999'],
    ['GET', '/v1/me/alerts'],
    ['PUT', '/v1/me/alerts'],
    ['GET', '/v1/auth/providers'],
    ['GET', '/v1/auth/github/login'],
    ['GET', '/v1/auth/google/callback?code=x&state=y'],
    ['POST', '/v1/auth/logout'],
    ['GET', '/v1/alerts/unsubscribe?token=x'],
    ['POST', '/v1/_test/sessions'],
  ])('%s %s returns 404 not-found and sets no cookie', async (method, path) => {
    const res = await call(path, { method, body: method === 'GET' || method === 'DELETE' ? undefined : {} });
    expectProblem(res, 404, 'not-found');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('answers unsafe methods on public paths with 405 and Allow, without asking for CSRF headers', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await call('/v1/storms', { method, body: {} });
      expectProblem(res, 405, 'method-not-allowed');
      expect(res.headers.get('allow') ?? '').toMatch(/GET/);
    }
  });
});
