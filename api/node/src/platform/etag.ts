// Data-derived weak ETags (CONTRACT-GUIDE §6): computed from the request and the dataset, never from response
// bytes, so every backend emits the same tag for the same resource.
import { percentEncode } from './query';

/** The canonical request: path, then ? and the recognised parameters sent, sorted by name then value, encoded. */
export function canonicalRequest(path: string, query: Map<string, string[]>, recognised: readonly string[]): string {
  const pairs: [string, string][] = [];
  for (const name of recognised) for (const v of query.get(name) ?? []) pairs.push([name, v]);
  if (pairs.length === 0) return path;
  // JavaScript compares strings by UTF-16 code units, as the Java reference does.
  pairs.sort(([ka, va], [kb, vb]) => (ka < kb ? -1 : ka > kb ? 1 : va < vb ? -1 : va > vb ? 1 : 0));
  return `${path}?${pairs.map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`).join('&')}`;
}

/** W/"d{datasetVersion}-{first 16 hex digits of SHA-256(canonical request)}". */
export async function catalogueETag(datasetVersion: string, path: string, query: Map<string, string[]>, recognised: readonly string[]) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest(path, query, recognised)));
  const hex = [...new Uint8Array(digest, 0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `W/"d${datasetVersion}-${hex}"`;
}

/** Weak comparison of an If-None-Match list (or *) against our tag. */
export function etagMatches(ifNoneMatch: string, etag: string): boolean {
  if (!ifNoneMatch.trim()) return false;
  const ours = etag.replace(/^W\//, '');
  return ifNoneMatch.split(',').some((c) => {
    const t = c.trim();
    return t === '*' || (t !== '' && t.replace(/^W\//, '') === ours);
  });
}
