// Test hooks (TR_TEST_HOOKS=1 only): apply live events.
import { call } from './http.ts';

export async function applyLiveEvent(type: 'storm-upserted' | 'storm-removed', payload: object): Promise<number> {
  const res = await call('/v1/_test/live-events', { method: 'POST', body: { type, payload } });
  if (res.status !== 201) throw new Error(`live event hook returned ${res.status}: ${res.text}`);
  return res.json.seq as number;
}
