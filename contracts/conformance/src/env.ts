// Everything the suite needs to know about the target comes from the environment, so the same
// tests run against java | node | rust | go | mock.
export type Impl = 'java' | 'node' | 'rust' | 'go' | 'mock';

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (e.g. BASE_URL=http://localhost:8081 IMPL=java)`);
  return v;
};

// vitest.config.ts forwards BASE_URL as TR_CONFORMANCE_BASE_URL (Vite shadows BASE_URL in workers).
export const BASE_URL = (process.env.TR_CONFORMANCE_BASE_URL || required('BASE_URL')).replace(/\/$/, '');
export const IMPL = required('IMPL') as Impl;
/** True when the target is the Prism mock: only contract-shape checks apply, not behaviour. */
export const IS_MOCK = IMPL === 'mock';
/** The browser-visible origin backends build redirect URIs and Link headers from (TR_SITE_ORIGIN). */
export const SITE_ORIGIN = (process.env.SITE_ORIGIN ?? 'http://localhost:8788').replace(/\/$/, '');
/** What the edge proxy would send as X-Forwarded-Prefix; the suite sends it on every request. */
export const FORWARDED_PREFIX = process.env.FORWARDED_PREFIX ?? `/api/${IMPL}`;
/** The public base a browser sees, e.g. http://localhost:8788/api/java. */
export const PUBLIC_BASE = `${SITE_ORIGIN}${FORWARDED_PREFIX}`;
/** Other backends, comma-separated `impl=url` pairs, for cross-backend cursor and ETag checks. */
export const OTHER_BACKENDS: { impl: string; url: string }[] = (process.env.OTHER_BACKENDS ?? '')
  .split(',')
  .filter(Boolean)
  .map((pair) => {
    const [impl, url] = pair.split('=');
    return { impl: impl ?? '', url: (url ?? '').replace(/\/$/, '') };
  });
/** Set when the target runs with TR_TEST_HOOKS=1 (the live scenarios need the hooks). */
export const TEST_HOOKS = process.env.TEST_HOOKS !== '0' && !IS_MOCK;
/** A backend started WITHOUT TR_TEST_HOOKS, to prove the hooks are absent. Optional. */
export const NO_HOOKS_BASE_URL = process.env.NO_HOOKS_BASE_URL?.replace(/\/$/, '');
/** Opt-in for the slow (25 s) heartbeat scenario. */
export const SLOW = process.env.SLOW === '1';
/** Contract version the backend claims (impl.json); scenarios tagged newer are skipped as "not claimed". */
export const CLAIMED_CONTRACT = process.env.CLAIMED_CONTRACT ?? '2.0.1';

const parse = (v: string) => v.split('.').map(Number) as [number, number, number];
/**
 * True when the backend claims at least contract version `v`. Across a major: scenarios that survive a major bump
 * keep their original tag (2.0.0 only removed operations, CONTRACT-GUIDE §14), and removed ones are deleted.
 */
export function claims(v: string): boolean {
  const [a1, b1, c1] = parse(CLAIMED_CONTRACT);
  const [a2, b2, c2] = parse(v);
  return a1 > a2 || (a1 === a2 && (b1 > b2 || (b1 === b2 && c1 >= c2)));
}
