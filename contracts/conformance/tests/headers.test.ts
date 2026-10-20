// CONTRACT-GUIDE §4: headers every response MUST carry, on success, error and 304 alike.
import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION, responseErrors } from '../src/contract.ts';
import { BASE_URL, IMPL, IS_MOCK } from '../src/env.ts';
import { get } from '../src/http.ts';
import { HAIYAN, TACLOBAN } from '../src/fixtures.ts';

// [contract path template, concrete request path]
const READS: [string, string][] = [
  ['/healthz', '/healthz'],
  ['/readyz', '/readyz'],
  ['/v1/meta', '/v1/meta'],
  ['/v1/openapi.json', '/v1/openapi.json'],
  ['/v1/storms', '/v1/storms?limit=3'],
  ['/v1/storms/{sid}', `/v1/storms/${HAIYAN}`],
  ['/v1/storms/{sid}/track', `/v1/storms/${HAIYAN}/track`],
  ['/v1/storms/{sid}/places', `/v1/storms/${HAIYAN}/places?radiusKm=100`],
  ['/v1/places/search', '/v1/places/search?q=taclo'],
  ['/v1/places/nearest', '/v1/places/nearest?lat=11.2433&lon=125.0039'],
  ['/v1/places/{placeId}', `/v1/places/${TACLOBAN}`],
  ['/v1/places/{placeId}/storms', `/v1/places/${TACLOBAN}/storms?radiusKm=100`],
  ['/v1/hits', '/v1/hits?lat=11.2433&lon=125.0039&radiusKm=100'],
  ['/v1/live/storms', '/v1/live/storms'],
  ['/v1/auth/providers', '/v1/auth/providers'],
];

describe('required headers and contract shape [c1.0.0]', () => {
  it.each(READS)('GET %s matches the contract', async (template, path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(responseErrors('GET', template, res)).toEqual([]);
    expect(res.headers.get('x-backend-impl')).toBe(IMPL);
    expect(res.headers.get('x-contract-version')).toBe(CONTRACT_VERSION);
    expect(res.headers.get('x-backend-version')).toMatch(/^\d+\.\d+\.\d+/);
    expect(res.headers.get('cache-control')).toBeTruthy();
    expect(res.headers.get('vary') ?? '').toMatch(/accept-encoding/i);
  });

  it.skipIf(IS_MOCK)('echoes a valid inbound X-Request-Id', async () => {
    const res = await get('/v1/meta', { headers: { 'X-Request-Id': 'conformance.req-01' } });
    expect(res.headers.get('x-request-id')).toBe('conformance.req-01');
  });

  it.skipIf(IS_MOCK)('replaces an invalid inbound X-Request-Id with a fresh one', async () => {
    const res = await get('/v1/meta', { headers: { 'X-Request-Id': 'bad id with spaces' } });
    const id = res.headers.get('x-request-id') ?? '';
    expect(id).not.toBe('bad id with spaces');
    expect(id).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
  });

  it.skipIf(IS_MOCK)('errors carry the headers too, and X-Backend-Impl names this backend', async () => {
    for (const path of ['/v1/storms/1999001N00000', '/v1/no-such-route', '/v1/me']) {
      const res = await get(path);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get('x-backend-impl')).toBe(IMPL);
      expect(res.headers.get('x-request-id')).toBeTruthy();
      expect(res.headers.get('cache-control')).toBeTruthy();
    }
  });

  it.skipIf(IS_MOCK)('compresses responses over 1 KB when gzip is accepted', async () => {
    const res = await fetch(`${BASE_URL}/v1/storms?limit=20`, { headers: { 'Accept-Encoding': 'gzip' } });
    expect(res.headers.get('content-encoding')).toMatch(/gzip|br/);
  });

  it.skipIf(IS_MOCK)('serves the contract bundle unchanged at /v1/openapi.json', async () => {
    const res = await get('/v1/openapi.json');
    expect(res.json.info.version).toBe(CONTRACT_VERSION);
    expect(Object.keys(res.json.paths).some((p: string) => p.includes('/_test/'))).toBe(false);
  });

  it('/v1/meta reports the same impl and contract version as the headers', async () => {
    const res = await get('/v1/meta');
    expect(res.json.impl).toBe(IMPL === 'mock' ? res.json.impl : IMPL);
    if (!IS_MOCK) expect(res.json.contractVersion).toBe(CONTRACT_VERSION);
  });
});
