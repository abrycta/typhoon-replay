// Catalogue reads: one Neon round trip per request (the dataset version and the operation's statements in one
// transaction), the dataset ETag, 304s, and the row mappers the operations share.
import type { components } from '../generated/contract';
import type { OperationId } from '../generated/operations';
import { catalogueETag, etagMatches } from '../platform/etag';
import { JSON_TYPE, notModified, send, type Rq } from '../platform/http';
import { batch, type Query, type Row, type Rows } from '../platform/neon';
import { queryNames } from '../platform/params';
import { datasetVersion, q } from './sql';

type Schemas = components['schemas'];

/**
 * Run a catalogue read. The ETag comes from the dataset version read in the same transaction, so a matching
 * If-None-Match gets its 304 from that one round trip (there is no cache between requests to answer from).
 */
export async function catalogue(
  rq: Rq,
  op: OperationId,
  queries: Query[],
): Promise<{ done: Response } | { rows: Rows[]; etag: string; done?: undefined }> {
  const [version, ...rows] = await batch(rq.env, [q(datasetVersion), ...queries]);
  const etag = await catalogueETag(version!.row(0).s('v'), rq.path, rq.query, queryNames(op));
  if (etagMatches(rq.ifNoneMatch, etag)) return { done: notModified(rq, etag) };
  return { rows, etag };
}

/** A 200 with its ETag and, for a page with more after it, the Link to the next page (CONTRACT-GUIDE §5). */
export function sendJSON(rq: Rq, body: unknown, etag: string, nextCursor?: string, contentType = JSON_TYPE): Response {
  const extra: Record<string, string> = { ETag: etag };
  if (nextCursor) extra.Link = nextLink(rq, nextCursor);
  return send(rq, 200, typeof body === 'string' ? body : JSON.stringify(body), contentType, extra);
}

function nextLink(rq: Rq, cursor: string): string {
  const pairs = rq.rawQuery.split('&').filter((p) => p !== '' && p !== 'cursor' && !p.startsWith('cursor='));
  pairs.push(`cursor=${cursor}`);
  return `<${rq.publicBase()}${rq.path}?${pairs.join('&')}>; rel="next"`;
}

/** [lon, lat] (rounded to 4 decimals in SQL), longitude normalised to (-180, 180]. */
export function lonLat(lonText: string, latText: string): [number, number] {
  let lon = Number(lonText);
  if (lon <= -180) lon = Number((lon + 360).toFixed(4));
  else if (lon > 180) lon = Number((lon - 360).toFixed(4));
  return [lon, Number(latText)];
}

export function localNames(ph: string | null, ja: string | null): { localNames?: Schemas['LocalNames'] } {
  if (ph === null && ja === null) return {};
  return { localNames: { ...(ph !== null ? { ph } : {}), ...(ja !== null ? { ja } : {}) } };
}

/** StormSummary from the stormColumns. Optional members are omitted, never null. */
export function stormSummary(r: Row): Schemas['StormSummary'] {
  return {
    sid: r.s('s_sid'),
    name: r.s('s_name'),
    ...localNames(r.n('s_name_ph'), r.n('s_name_ja')),
    season: Number(r.s('s_season')),
    basin: r.s('s_basin') as Schemas['Basin'],
    startedAt: r.s('s_started_at'),
    endedAt: r.s('s_ended_at'),
    peakWindKt: r.num('s_peak_wind_kt'),
    peakWindAgency: r.opt('s_peak_wind_agency') as Schemas['StormSummary']['peakWindAgency'],
    minPressureHpa: r.num('s_min_pressure_hpa'),
    landfallCountries: JSON.parse(r.s('s_landfall_countries')),
  };
}

/** PlaceSummary from the placeColumns. */
export function placeSummary(r: Row): Schemas['PlaceSummary'] {
  return {
    id: r.s('p_id'),
    country: r.s('p_country') as Schemas['CountryCode'],
    kind: r.s('p_kind') as Schemas['PlaceSummary']['kind'],
    name: r.s('p_name'),
    nameJa: r.opt('p_name_ja'),
    admin1: r.s('p_admin1'),
    admin1Ja: r.opt('p_admin1_ja'),
    admin2: r.opt('p_admin2'),
    centroid: lonLat(r.s('p_lon'), r.s('p_lat')),
  };
}

/** The closest-approach members of a StormHit / PlaceHit (columns km, at, wind, gust, hours). */
export function exposure(r: Row) {
  return {
    closestApproachKm: Number(r.s('km')),
    closestApproachAt: r.s('at'),
    maxWindKtWithinRadius: r.num('wind'),
    maxGustKtWithinRadius: r.num('gust'),
    hoursWithinRadius: Number(r.s('hours')),
  };
}
