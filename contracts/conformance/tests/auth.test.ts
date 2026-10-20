// CONTRACT-GUIDE §9: OAuth2 code flow with PKCE against the mock IdP, shared sessions, logout everywhere.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { responseErrors } from '../src/contract.ts';
import { BASE_URL, IDP_URL, IS_MOCK, OTHER_BACKENDS, PUBLIC_BASE, TEST_HOOKS } from '../src/env.ts';
import { call, get, sessionCookie, sessionCookieAttributes } from '../src/http.ts';

/** Map a browser-visible URL under PUBLIC_BASE onto the backend under test (what the edge proxy does). */
const toBackend = (url: string) => (url.startsWith(PUBLIC_BASE) ? BASE_URL + url.slice(PUBLIC_BASE.length) : url);

async function signIn(provider: 'github' | 'google', returnTo = '/places') {
  const login = await get(`/v1/auth/${provider}/login?returnTo=${encodeURIComponent(returnTo)}`);
  const authorize = new URL(login.headers.get('location')!);
  // The mock IdP approves immediately and redirects to redirect_uri with code + state.
  const approved = await fetch(authorize, { redirect: 'manual' });
  const callbackUrl = approved.headers.get('location')!;
  const callback = await get(toBackend(callbackUrl));
  return { login, authorize, callbackUrl, callback };
}

describe.skipIf(IS_MOCK)('sign-in providers [c1.0.0]', () => {
  it('lists Google and GitHub', async () => {
    const res = await get('/v1/auth/providers');
    expect(responseErrors('GET', '/v1/auth/providers', res)).toEqual([]);
    expect(res.json.items.map((p: { id: string }) => p.id).sort()).toEqual(['github', 'google']);
  });
});

describe.skipIf(IS_MOCK || !TEST_HOOKS)('OAuth2 login against the mock IdP [c1.0.0]', () => {
  it.each(['github', 'google'] as const)('%s: redirects with state and an S256 PKCE challenge', async (provider) => {
    const res = await get(`/v1/auth/${provider}/login?returnTo=/places`);
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toMatch(new RegExp(`^${IDP_URL}/${provider}/`));
    const q = loc.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBeTruthy();
    expect(q.get('state')!.length).toBeGreaterThanOrEqual(16);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('redirect_uri')).toBe(`${PUBLIC_BASE}/v1/auth/${provider}/callback`);
  });

  it.each(['github', 'google'] as const)('%s: callback sets the __Host- session cookie and redirects to returnTo', async (provider) => {
    const { callback } = await signIn(provider, '/places/PH-0831600000');
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/places/PH-0831600000');
    const c = sessionCookieAttributes(callback)!;
    expect(c).toBeDefined();
    expect(c.value).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    expect(c).toMatchObject({ path: '/', secure: 'true', httponly: 'true', 'max-age': '2592000' });
    expect(c.samesite?.toLowerCase()).toBe('lax');
    expect(c).not.toHaveProperty('domain');
    const me = await get('/v1/me', { cookie: sessionCookie(callback) });
    expect(me.status).toBe(200);
    expect(me.json.providers).toContain(provider);
  });

  it('verifies the PKCE verifier at the token endpoint (mock IdP rejects a mismatch)', async () => {
    const { authorize } = await signIn('github');
    const challenge = authorize.searchParams.get('code_challenge')!;
    const seen = await (await fetch(`${IDP_URL}/_mock/last-token-request`)).json();
    expect(createHash('sha256').update(seen.code_verifier).digest('base64url')).toBe(challenge);
  });

  it('rejects unknown or reused state with a redirect to /signin?error=invalid-state and no cookie', async () => {
    const { callbackUrl } = await signIn('github');
    const again = await get(toBackend(callbackUrl));
    expect(again.status).toBe(302);
    expect(again.headers.get('location')).toBe('/signin?error=invalid-state');
    expect(sessionCookie(again)).toBeUndefined();
    const forged = await get('/v1/auth/github/callback?code=x&state=forged-state-0000000000');
    expect(forged.headers.get('location')).toBe('/signin?error=invalid-state');
  });

  it('maps a provider denial to /signin?error=access-denied', async () => {
    const login = await get('/v1/auth/github/login');
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    const res = await get(`/v1/auth/github/callback?error=access_denied&state=${state}`);
    expect(res.headers.get('location')).toBe('/signin?error=access-denied');
  });

  it.each(['//evil.example/x', 'https://evil.example/', 'javascript:alert(1)', 'places'])('replaces unsafe returnTo %s with /', async (bad) => {
    const { callback } = await signIn('github', bad);
    expect(callback.headers.get('location')).toBe('/');
  });

  it.each(OTHER_BACKENDS)('a session minted here works on $impl, and a flow started there completes here', async ({ url }) => {
    const { callback } = await signIn('github');
    const cookie = sessionCookie(callback)!;
    expect((await get('/v1/me', { cookie, base: url })).status).toBe(200);
    const theirLogin = await get('/v1/auth/github/login', { base: url });
    const approved = await fetch(theirLogin.headers.get('location')!, { redirect: 'manual' });
    const path = new URL(approved.headers.get('location')!);
    const here = await get(`/v1/auth/github/callback${path.search}`);
    expect(sessionCookie(here)).toBeDefined();
  });

  it('logout revokes the session everywhere and clears the cookie', async () => {
    const { callback } = await signIn('google');
    const cookie = sessionCookie(callback)!;
    const out = await call('/v1/auth/logout', { method: 'POST', cookie });
    expect(out.status).toBe(204);
    expect(sessionCookieAttributes(out)).toMatchObject({ value: '', 'max-age': '0', path: '/' });
    expect((await get('/v1/me', { cookie })).status).toBe(401);
    for (const { url } of OTHER_BACKENDS) expect((await get('/v1/me', { cookie, base: url })).status).toBe(401);
  });
});
