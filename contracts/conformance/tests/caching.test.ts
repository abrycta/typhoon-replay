// CONTRACT-GUIDE §6: data-derived weak ETags, identical across backends; 304 on If-None-Match.
import { describe, expect, it } from 'vitest';
import { IS_MOCK, OTHER_BACKENDS } from '../src/env.ts';
import { get } from '../src/http.ts';
import { HAIYAN, TACLOBAN } from '../src/fixtures.ts';

const CATALOGUE = [`/v1/storms/${HAIYAN}`, `/v1/storms/${HAIYAN}/track`, '/v1/storms?season=2013', `/v1/places/${TACLOBAN}/storms?radiusKm=100`];

describe.skipIf(IS_MOCK)('caching and conditional requests [c1.0.0]', () => {
  it.each(CATALOGUE)('%s is publicly cacheable with a dataset ETag', async (path) => {
    const res = await get(path);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, stale-while-revalidate=86400');
    expect(res.headers.get('etag')).toMatch(/^W\/"d\d+-[0-9a-f]{16}"$/);
  });

  it.each(CATALOGUE)('%s answers If-None-Match with 304, same ETag and Cache-Control, no body', async (path) => {
    const first = await get(path);
    const etag = first.headers.get('etag')!;
    const second = await get(path, { headers: { 'If-None-Match': etag } });
    expect(second.status).toBe(304);
    expect(second.text).toBe('');
    expect(second.headers.get('etag')).toBe(etag);
    expect(second.headers.get('cache-control')).toBe(first.headers.get('cache-control'));
  });

  it('uses weak comparison (a strong form of the same tag also matches)', async () => {
    const first = await get(`/v1/storms/${HAIYAN}`);
    const strong = first.headers.get('etag')!.replace(/^W\//, '');
    const res = await get(`/v1/storms/${HAIYAN}`, { headers: { 'If-None-Match': `"nope", ${strong}` } });
    expect(res.status).toBe(304);
  });

  it('gives different resources different ETags and ignores query order', async () => {
    const a = await get('/v1/storms?season=2013&limit=5');
    const b = await get('/v1/storms?limit=5&season=2013');
    const c = await get('/v1/storms?season=2009&limit=5');
    expect(a.headers.get('etag')).toBe(b.headers.get('etag'));
    expect(a.headers.get('etag')).not.toBe(c.headers.get('etag'));
  });

  it.each(OTHER_BACKENDS)('emits the same catalogue ETag as $impl', async ({ url }) => {
    for (const path of CATALOGUE) {
      const mine = await get(path);
      const theirs = await get(path, { base: url });
      expect(theirs.headers.get('etag'), path).toBe(mine.headers.get('etag'));
    }
  });

  it('marks the live snapshot no-cache with a sequence ETag', async () => {
    const res = await get('/v1/live/storms');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('etag')).toBe(`W/"s${res.json.seq}"`);
  });

  it('marks meta public, max-age=60', async () => {
    const res = await get('/v1/meta');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(res.headers.get('etag')).toMatch(/^W\/"c[0-9.]+-[a-z]+-.+"$/);
  });

  it('[c2.0.1] puts the datasetVersion in the meta ETag and answers it with 304', async () => {
    const res = await get('/v1/meta');
    const etag = res.headers.get('etag')!;
    expect(etag).toBe(`W/"c${res.json.contractVersion}-${res.json.impl}-${res.json.implVersion}-d${res.json.datasetVersion}"`);
    const again = await get('/v1/meta', { headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);
  });

  it('[c2.0.0] ignores cookies: same answer, no Set-Cookie, no Vary: Cookie (everything is publicly cacheable)', async () => {
    const path = `/v1/places/${TACLOBAN}/storms?radiusKm=100`;
    const plain = await get(path);
    const withCookie = await get(path, { cookie: '__Host-tr_session=fixture-session-token-ana-0000000000000; other=1' });
    expect(withCookie.status).toBe(200);
    expect(withCookie.headers.get('etag')).toBe(plain.headers.get('etag'));
    expect(withCookie.headers.get('cache-control')).toBe('public, max-age=300, stale-while-revalidate=86400');
    expect(withCookie.json).toEqual(plain.json);
    for (const res of [plain, withCookie]) {
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(res.headers.get('vary') ?? '').not.toMatch(/cookie/i);
    }
  });

  it('marks probes no-store', async () => {
    for (const path of ['/healthz', '/readyz']) expect((await get(path)).headers.get('cache-control')).toBe('no-store');
  });
});
