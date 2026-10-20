// Test hooks (TR_TEST_HOOKS=1 only): sign in without a provider, and apply live events.
import { call, sessionCookie } from './http.ts';

let counter = 0;

/** Creates a fresh user + session via POST /v1/_test/sessions and returns the Cookie header value. */
export async function testSession(provider: 'github' | 'google' = 'github', base?: string): Promise<{ cookie: string; userId: string }> {
  const email = `conformance-${process.pid}-${Date.now()}-${counter++}@example.com`;
  const res = await call('/v1/_test/sessions', { method: 'POST', body: { email, provider }, csrf: false, base });
  if (res.status !== 201) throw new Error(`test session hook returned ${res.status}: ${res.text}`);
  const cookie = sessionCookie(res);
  if (!cookie) throw new Error('test session hook set no __Host-tr_session cookie');
  return { cookie, userId: res.json.userId };
}

export async function applyLiveEvent(type: 'storm-upserted' | 'storm-removed', payload: object): Promise<number> {
  const res = await call('/v1/_test/live-events', { method: 'POST', body: { type, payload }, csrf: false });
  if (res.status !== 201) throw new Error(`live event hook returned ${res.status}: ${res.text}`);
  return res.json.seq as number;
}
