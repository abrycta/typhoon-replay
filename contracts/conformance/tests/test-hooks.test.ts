// Test hooks MUST be absent unless TR_TEST_HOOKS=1 (CONTRACT-GUIDE §10, §12.4).
import { describe, expect, it } from 'vitest';
import { NO_HOOKS_BASE_URL } from '../src/env.ts';
import { call } from '../src/http.ts';

describe.runIf(NO_HOOKS_BASE_URL)('test hooks disabled [c1.0.0]', () => {
  it.each(['/v1/_test/sessions', '/v1/_test/live-events'])('%s returns 404 problem+json', async (path) => {
    const res = await call(path, { method: 'POST', body: { email: 'x@example.com', provider: 'github' }, csrf: false, base: NO_HOOKS_BASE_URL });
    expect(res.status).toBe(404);
    expect(res.json.code).toBe('not-found');
  });
});
