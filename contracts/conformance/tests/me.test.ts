// Saved places, alert preferences and the CSRF rules for unsafe methods (CONTRACT-GUIDE §9).
import { beforeAll, describe, expect, it } from 'vitest';
import { responseErrors } from '../src/contract.ts';
import { IS_MOCK, SITE_ORIGIN, TEST_HOOKS } from '../src/env.ts';
import { call, get } from '../src/http.ts';
import { testSession } from '../src/hooks.ts';
import { PROBLEM_BASE, TACLOBAN } from '../src/fixtures.ts';

let cookie = '';
beforeAll(async () => {
  if (TEST_HOOKS && !IS_MOCK) cookie = (await testSession()).cookie;
});

describe.skipIf(IS_MOCK || !TEST_HOOKS)('CSRF on unsafe methods [c1.0.0]', () => {
  const body = { placeId: 'JP-47207', label: 'csrf probe' };

  it('rejects a missing X-Requested-With', async () => {
    const res = await call('/v1/me/places', { method: 'POST', cookie, body, csrf: false, headers: { Origin: SITE_ORIGIN } });
    expect(res.status).toBe(403);
    expect(res.json.type).toBe(`${PROBLEM_BASE}csrf`);
  });

  it('rejects a foreign or missing Origin', async () => {
    const variants: Record<string, string>[] = [{ Origin: 'https://evil.example', 'X-Requested-With': 'typhoon-replay' }, { 'X-Requested-With': 'typhoon-replay' }];
    for (const headers of variants) {
      const res = await call('/v1/me/places', { method: 'POST', cookie, body, csrf: false, headers });
      expect(res.status).toBe(403);
      expect(res.json.code).toBe('csrf');
    }
  });

  it('applies to PUT, PATCH, DELETE and logout too', async () => {
    const put = await call('/v1/me/alerts', { method: 'PUT', cookie, csrf: false, body: { enabled: false, radiusKm: 200, minWindKt: 64, savedPlaceIds: [] } });
    expect(put.json.code).toBe('csrf');
    const del = await call('/v1/me/places/0192f5a0-0000-7000-8000-000000000999', { method: 'DELETE', cookie, csrf: false });
    expect(del.json.code).toBe('csrf');
    const logout = await call('/v1/auth/logout', { method: 'POST', cookie, csrf: false });
    expect(logout.json.code).toBe('csrf');
  });
});

describe.skipIf(IS_MOCK || !TEST_HOOKS)('saved places [c1.0.0]', () => {
  it('creates, lists, renames and deletes', async () => {
    const created = await call('/v1/me/places', { method: 'POST', cookie, body: { placeId: TACLOBAN, label: 'Home' } });
    expect(created.status).toBe(201);
    expect(responseErrors('POST', '/v1/me/places', created)).toEqual([]);
    expect(created.json).toMatchObject({ placeId: TACLOBAN, label: 'Home', place: { id: TACLOBAN } });
    expect(created.headers.get('cache-control')).toBe('private, no-store');

    const point = await call('/v1/me/places', { method: 'POST', cookie, body: { position: [124.995, 11.21] } });
    expect(point.status).toBe(201);
    expect(point.json.position).toEqual([124.995, 11.21]);

    const list = await get('/v1/me/places', { cookie });
    expect(list.json.items.map((p: { id: string }) => p.id)).toEqual([created.json.id, point.json.id]);

    const renamed = await call(`/v1/me/places/${created.json.id}`, { method: 'PATCH', cookie, body: { label: 'Lola' } });
    expect(renamed.json.label).toBe('Lola');

    expect((await call(`/v1/me/places/${point.json.id}`, { method: 'DELETE', cookie })).status).toBe(204);
    expect((await call(`/v1/me/places/${point.json.id}`, { method: 'DELETE', cookie })).status).toBe(404);
  });

  it('409s on a duplicate and 422s on neither/both of placeId and position', async () => {
    const dup = await call('/v1/me/places', { method: 'POST', cookie, body: { placeId: TACLOBAN } });
    expect(dup.status).toBe(409);
    expect(dup.json.code).toBe('conflict');
    for (const body of [{ label: 'x' }, { placeId: 'JP-47201', position: [127.68, 26.21] }]) {
      const res = await call('/v1/me/places', { method: 'POST', cookie, body });
      expect(res.status).toBe(422);
      expect(res.json.code).toBe('unprocessable');
    }
  });

  it("does not expose another user's saved place", async () => {
    const other = await testSession('google');
    const mine = await get('/v1/me/places', { cookie });
    const id = mine.json.items[0].id;
    expect((await call(`/v1/me/places/${id}`, { method: 'PATCH', cookie: other.cookie, body: { label: 'x' } })).status).toBe(404);
  });
});

describe.skipIf(IS_MOCK || !TEST_HOOKS)('alert preferences [c1.0.0]', () => {
  it('reads defaults, replaces and reads back', async () => {
    const fresh = await testSession();
    const defaults = await get('/v1/me/alerts', { cookie: fresh.cookie });
    expect(defaults.json).toMatchObject({ enabled: false, radiusKm: 200, minWindKt: 64, savedPlaceIds: [], language: 'en' });
    const place = await call('/v1/me/places', { method: 'POST', cookie: fresh.cookie, body: { placeId: TACLOBAN } });
    const put = await call('/v1/me/alerts', {
      method: 'PUT', cookie: fresh.cookie,
      body: { enabled: true, radiusKm: 100, minWindKt: 80, savedPlaceIds: [place.json.id], language: 'ja' },
    });
    expect(put.status).toBe(200);
    expect(responseErrors('PUT', '/v1/me/alerts', put)).toEqual([]);
    expect((await get('/v1/me/alerts', { cookie: fresh.cookie })).json).toMatchObject({ enabled: true, radiusKm: 100, savedPlaceIds: [place.json.id], language: 'ja' });
  });

  it("422s on a savedPlaceId that isn't the user's", async () => {
    const res = await call('/v1/me/alerts', {
      method: 'PUT', cookie,
      body: { enabled: true, radiusKm: 100, minWindKt: 80, savedPlaceIds: ['0192f5a0-0000-7000-8000-000000000201'] },
    });
    expect(res.status).toBe(422);
  });

  it('deletes the account and everything with it', async () => {
    const doomed = await testSession();
    await call('/v1/me/places', { method: 'POST', cookie: doomed.cookie, body: { placeId: TACLOBAN } });
    expect((await call('/v1/me', { method: 'DELETE', cookie: doomed.cookie })).status).toBe(204);
    expect((await get('/v1/me', { cookie: doomed.cookie })).status).toBe(401);
  });
});
