// Catalogue: listing, filters, cursor pagination (CONTRACT-GUIDE §5), detail and track.
import { describe, expect, it } from 'vitest';
import { responseErrors } from '../src/contract.ts';
import { IS_MOCK, OTHER_BACKENDS, PUBLIC_BASE } from '../src/env.ts';
import { decodeCursor, encodeCursor, get, nullPaths } from '../src/http.ts';
import { HAIYAN, MAX_RESPONSE_BYTES, STORMS_SEASON_DESC, UNNAMED_1946 } from '../src/fixtures.ts';

async function walk(query: string, base?: string): Promise<{ sids: string[]; pages: number }> {
  const sids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const res = await get(`/v1/storms?${query}${cursor ? `&cursor=${cursor}` : ''}`, { base });
    expect(res.status).toBe(200);
    expect(responseErrors('GET', '/v1/storms', res)).toEqual([]);
    sids.push(...res.json.items.map((s: { sid: string }) => s.sid));
    cursor = res.json.nextCursor;
    const link = res.headers.get('link');
    if (cursor) {
      expect(link, 'Link rel=next must accompany nextCursor').toContain('rel="next"');
      expect(link).toContain(`<${PUBLIC_BASE}/v1/storms?`);
      expect(link).toContain(`cursor=${cursor}`);
    } else {
      expect(link ?? '').not.toContain('rel="next"');
    }
    pages++;
  } while (cursor && pages < 50);
  return { sids, pages };
}

describe.skipIf(IS_MOCK)('storm catalogue [c1.0.0]', () => {
  it('walks every page with limit=2, in season-desc order, without duplicates', async () => {
    const { sids, pages } = await walk('limit=2');
    expect(sids).toEqual(STORMS_SEASON_DESC);
    expect(pages).toBe(5);
  });

  it('walks peak-wind-desc and name sorts completely', async () => {
    for (const sort of ['peak-wind-desc', 'name']) {
      const { sids } = await walk(`limit=4&sort=${sort}`);
      expect(new Set(sids).size).toBe(STORMS_SEASON_DESC.length);
    }
  });

  it('encodes cursors as base64url JSON [1, sort, ...keyset, lastId]', async () => {
    const res = await get('/v1/storms?limit=2');
    const parts = decodeCursor(res.json.nextCursor);
    expect(parts[0]).toBe(1);
    expect(parts[1]).toBe('season-desc');
    expect(parts.at(-1)).toBe(STORMS_SEASON_DESC[1]);
  });

  it('accepts a cursor built by hand (and so by any other backend)', async () => {
    const cursor = encodeCursor([1, 'season-desc', 2021, '2021346N05145']);
    const res = await get(`/v1/storms?limit=2&cursor=${cursor}`);
    expect(res.json.items.map((s: { sid: string }) => s.sid)).toEqual(STORMS_SEASON_DESC.slice(3, 5));
  });

  it.each(OTHER_BACKENDS)('continues a walk with a cursor from $impl', async ({ url }) => {
    const first = await get('/v1/storms?limit=3', { base: url });
    const res = await get(`/v1/storms?limit=3&cursor=${first.json.nextCursor}`);
    expect(res.json.items.map((s: { sid: string }) => s.sid)).toEqual(STORMS_SEASON_DESC.slice(3, 6));
  });

  it('finds storms by international, PAGASA and Japanese names', async () => {
    for (const q of ['haiyan', 'Yolanda', '台風第30号']) {
      const res = await get(`/v1/storms?q=${encodeURIComponent(q)}`);
      expect(res.json.items.map((s: { sid: string }) => s.sid), q).toContain(HAIYAN);
    }
  });

  it('filters by season, landfall country and minimum wind', async () => {
    const season = await get('/v1/storms?season=2013');
    expect(season.json.items.map((s: { sid: string }) => s.sid)).toEqual([HAIYAN]);
    const jp = await get('/v1/storms?country=JP');
    expect(jp.json.items.every((s: { landfallCountries: string[] }) => s.landfallCountries.includes('JP'))).toBe(true);
    expect(jp.json.items).toHaveLength(4);
    const strong = await get('/v1/storms?minWindKt=160');
    expect(strong.json.items.map((s: { sid: string }) => s.sid).sort()).toEqual(['2013306N07162', '2019278N16165', '2020299N11144']);
  });

  it('returns Haiyan / Yolanda in full', async () => {
    const res = await get(`/v1/storms/${HAIYAN}`);
    expect(responseErrors('GET', '/v1/storms/{sid}', res)).toEqual([]);
    expect(res.json).toMatchObject({
      sid: HAIYAN, name: 'Haiyan', localNames: { ph: 'Yolanda', ja: '台風第30号' }, season: 2013, basin: 'WP',
      startedAt: '2013-11-02T06:00:00Z', endedAt: '2013-11-11T12:00:00Z', fixCount: 38, landfallCountries: ['PH'],
      peak: { windKt: 170, agency: 'jtwc', pressureHpa: 895 }, replayAvailable: true,
    });
    expect(res.json.landfalls[0]).toMatchObject({ country: 'PH', at: '2013-11-08T00:00:00Z' });
  });

  it('omits unknown values instead of sending null (1946 unnamed storm has no wind data)', async () => {
    const res = await get(`/v1/storms/${UNNAMED_1946}`);
    expect(res.json.name).toBe('Unnamed');
    expect(res.json).not.toHaveProperty('peakWindKt');
    expect(nullPaths(res.json)).toEqual([]);
    const list = await get('/v1/storms?limit=100');
    expect(nullPaths(list.json)).toEqual([]);
  });

  it('serves the observed track as GeoJSON at best-track resolution', async () => {
    const res = await get(`/v1/storms/${HAIYAN}/track`);
    expect(res.headers.get('content-type')).toMatch(/^application\/geo\+json/);
    expect(responseErrors('GET', '/v1/storms/{sid}/track', res)).toEqual([]);
    expect(res.json.features).toHaveLength(38);
    const times = res.json.features.map((f: { properties: { at: string } }) => f.properties.at);
    expect([...times].sort()).toEqual(times);
    const landfall = res.json.features.find((f: { properties: { at: string } }) => f.properties.at === '2013-11-08T00:00:00Z');
    expect(landfall.geometry.coordinates).toEqual([124.8, 11]);
    expect(landfall.properties.windKt).toBe(165);
  });

  it('formats timestamps as RFC 3339 UTC with Z and whole seconds', async () => {
    const res = await get(`/v1/storms/${HAIYAN}/track`);
    for (const f of res.json.features) expect(f.properties.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it('stays under the 64 KB response cap at the maximum limit', async () => {
    for (const path of ['/v1/storms?limit=100', `/v1/storms/${HAIYAN}/track`, `/v1/storms/${HAIYAN}/places?radiusKm=500&limit=100`]) {
      const res = await get(path);
      expect(res.bytes, path).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    }
  });
});
