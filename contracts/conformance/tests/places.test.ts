// Places and the headline query: "typhoons that hit my town".
import { describe, expect, it } from 'vitest';
import { responseErrors } from '../src/contract.ts';
import { IS_MOCK, OTHER_BACKENDS } from '../src/env.ts';
import { get } from '../src/http.ts';
import {
  HAIYAN, HAIYAN_PLACES_100KM, MAX_RESPONSE_BYTES, NAHA, NAHA_100KM, TACLOBAN, TACLOBAN_100KM, TACLOBAN_200KM_PEAK_WIND,
} from '../src/fixtures.ts';

const sids = (res: { json: { items: { storm: { sid: string } }[] } }) => res.json.items.map((i) => i.storm.sid);

describe.skipIf(IS_MOCK)('places [c1.0.0]', () => {
  it('searches Latin and Japanese names', async () => {
    const taclo = await get('/v1/places/search?q=taclo');
    expect(responseErrors('GET', '/v1/places/search', taclo)).toEqual([]);
    expect(taclo.json.items[0].id).toBe(TACLOBAN);
    const naha = await get(`/v1/places/search?q=${encodeURIComponent('那覇')}`);
    expect(naha.json.items[0]).toMatchObject({ id: NAHA, nameJa: '那覇市', admin1Ja: '沖縄県' });
    const jpOnly = await get('/v1/places/search?q=a&country=JP&limit=50');
    expect(jpOnly.json.items.every((p: { country: string }) => p.country === 'JP')).toBe(true);
  });

  it('returns place detail with a simplified boundary', async () => {
    const res = await get(`/v1/places/${TACLOBAN}`);
    expect(responseErrors('GET', '/v1/places/{placeId}', res)).toEqual([]);
    expect(res.json).toMatchObject({ id: TACLOBAN, country: 'PH', kind: 'city', name: 'Tacloban City', admin2: 'Leyte' });
    expect(res.json.geometry.type).toBe('MultiPolygon');
  });

  it('finds the place containing a point', async () => {
    const res = await get('/v1/places/nearest?lat=11.2433&lon=125.0039');
    expect(res.json).toMatchObject({ place: { id: TACLOBAN }, contains: true, distanceKm: 0 });
  });

  it('404s for an unknown place and for a point far from every place', async () => {
    expect((await get('/v1/places/PH-0000000000')).status).toBe(404);
    expect((await get('/v1/places/nearest?lat=0&lon=0')).status).toBe(404);
  });
});

describe.skipIf(IS_MOCK)('storms that hit a place [c1.0.0]', () => {
  it('ranks Haiyan first for Tacloban within 100 km (closest)', async () => {
    const res = await get(`/v1/places/${TACLOBAN}/storms?radiusKm=100`);
    expect(responseErrors('GET', '/v1/places/{placeId}/storms', res)).toEqual([]);
    expect(res.json.radiusKm).toBe(100);
    expect(res.json.items).toHaveLength(TACLOBAN_100KM.length);
    TACLOBAN_100KM.forEach((golden, i) => {
      const { sid, ...rest } = golden;
      expect(res.json.items[i].storm.sid).toBe(sid);
      expect(res.json.items[i]).toMatchObject(rest);
    });
    expect(res.json.items[1]).not.toHaveProperty('maxWindKtWithinRadius');
  });

  it('ranks by peak wind within the radius, unknown last', async () => {
    const res = await get(`/v1/places/${TACLOBAN}/storms?radiusKm=200&sort=peak-wind-desc`);
    expect(sids(res)).toEqual(TACLOBAN_200KM_PEAK_WIND);
  });

  it('pages with interchangeable cursors', async () => {
    const page1 = await get(`/v1/places/${TACLOBAN}/storms?radiusKm=500&limit=2`);
    const page2 = await get(`/v1/places/${TACLOBAN}/storms?radiusKm=500&limit=2&cursor=${page1.json.nextCursor}`);
    const all = await get(`/v1/places/${TACLOBAN}/storms?radiusKm=500&limit=100`);
    expect([...sids(page1), ...sids(page2)]).toEqual(sids(all).slice(0, 4));
    for (const { url } of OTHER_BACKENDS) {
      const theirs = await get(`/v1/places/${TACLOBAN}/storms?radiusKm=500&limit=2&cursor=${page1.json.nextCursor}`, { base: url });
      expect(sids(theirs)).toEqual(sids(page2));
    }
  });

  it('filters by minimum wind and season range', async () => {
    const strong = await get(`/v1/places/${TACLOBAN}/storms?radiusKm=200&minWindKt=150`);
    expect(sids(strong)).toEqual([HAIYAN]);
    const old = await get(`/v1/places/${TACLOBAN}/storms?radiusKm=500&from=1940&to=1950`);
    expect(sids(old)).toEqual(['1946316N07133']);
  });

  it('finds Khanun for Naha within 100 km', async () => {
    const res = await get(`/v1/places/${NAHA}/storms?radiusKm=100`);
    expect(res.json.items).toHaveLength(1);
    const { sid, ...rest } = NAHA_100KM[0]!;
    expect(res.json.items[0].storm.sid).toBe(sid);
    expect(res.json.items[0]).toMatchObject(rest);
  });

  it('lists the places Haiyan passed near', async () => {
    const res = await get(`/v1/storms/${HAIYAN}/places?radiusKm=100`);
    expect(res.json.items.map((i: { place: { id: string } }) => i.place.id)).toEqual(HAIYAN_PLACES_100KM);
  });

  it('answers the same question for an arbitrary point', async () => {
    const res = await get('/v1/hits?lat=11.2433&lon=125.0039&radiusKm=100');
    expect(responseErrors('GET', '/v1/hits', res)).toEqual([]);
    expect(sids(res)[0]).toBe(HAIYAN);
  });

  it('stays under the 64 KB response cap at the maximum limit', async () => {
    for (const path of [`/v1/places/${TACLOBAN}/storms?radiusKm=500&limit=100`, '/v1/hits?lat=11.2&lon=125&radiusKm=500&limit=100', `/v1/places/${TACLOBAN}`]) {
      expect((await get(path)).bytes, path).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    }
  });
});
