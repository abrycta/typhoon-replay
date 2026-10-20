// Test hooks MUST be absent unless TR_TEST_HOOKS=1 (CONTRACT-GUIDE §10, §12.4).
import { describe, expect, it } from 'vitest';
import { NO_HOOKS_BASE_URL } from '../src/env.ts';
import { call } from '../src/http.ts';

describe.runIf(NO_HOOKS_BASE_URL)('test hooks disabled [c1.0.0]', () => {
  it('/v1/_test/live-events returns 404 problem+json', async () => {
    const res = await call('/v1/_test/live-events', { method: 'POST', body: { type: 'storm-removed', payload: { liveId: 'x', reason: 'dissipated' } }, base: NO_HOOKS_BASE_URL });
    expect(res.status).toBe(404);
    expect(res.json.code).toBe('not-found');
  });
});
