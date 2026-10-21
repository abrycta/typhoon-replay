// Storm catalogue: GET /v1/storms, /v1/storms/{sid}, /v1/storms/{sid}/track, /v1/storms/{sid}/places.
import type { components } from '../generated/contract';
import { decodeCursor, encodeCursor } from '../platform/cursor';
import type { Rq } from '../platform/http';
import { bind } from '../platform/params';
import { missing, Problem } from '../platform/problem';
import { catalogue, exposure, localNames, lonLat, placeSummary, sendJSON, stormSummary } from './read';
import { db, keyset, lat, likeEscape, lon, placeColumns, q, sql, stormColumns, ts, type Radius, type SortSpec } from './sql';

type Schemas = components['schemas'];

const STORM_SORTS: Record<string, SortSpec> = {
  'season-desc': { wire: 'season-desc', key: 's.season', ascending: false, cast: '::numeric', render: 's.season::text', kind: 'number' },
  'peak-wind-desc': {
    wire: 'peak-wind-desc',
    key: 'coalesce(s.peak_wind_kt, -1)',
    ascending: false,
    cast: '::numeric',
    render: 'coalesce(s.peak_wind_kt, -1)::text',
    kind: 'number',
  },
  name: { wire: 'name', key: 'upper(s.name) COLLATE "C"', ascending: true, cast: '::text', render: 'upper(s.name)', kind: 'string' },
};

const exists = (sid: string) => q(sql`SELECT EXISTS (SELECT 1 FROM catalog.storm WHERE sid = ${sid}) AS e`);

/** GET /v1/storms */
export async function listStorms(rq: Rq): Promise<Response> {
  const p = bind('listStorms', rq);
  if (p.season !== undefined && (p.from !== undefined || p.to !== undefined)) {
    throw new Problem('validation', 'season cannot be combined with from/to.', [
      { pointer: '#/query/season', detail: 'cannot be combined with from/to' },
    ]);
  }
  const sort = STORM_SORTS[p.sort ?? 'season-desc']!;
  const limit = p.limit ?? 50;
  const cursor = decodeCursor(p.cursor, sort.wire, sort.kind);

  let query = db
    .selectFrom('catalog.storm as s')
    .leftJoin('catalog.pagasa_name as pn', 'pn.sid', 's.sid')
    .select(stormColumns)
    .select(sql.raw<string>(sort.render).as('sort_key'));
  if (p.q !== undefined) query = query.where(sql<boolean>`s.search_text LIKE '%' || lower(${likeEscape(p.q)}) || '%' ESCAPE '\\'`);
  if (p.season !== undefined) query = query.where('s.season', '=', p.season);
  if (p.from !== undefined) query = query.where('s.season', '>=', p.from);
  if (p.to !== undefined) query = query.where('s.season', '<=', p.to);
  if (p.basin !== undefined) query = query.where('s.basin', '=', p.basin);
  if (p.country !== undefined) query = query.where(sql<boolean>`s.landfall_countries @> ARRAY[${p.country}::text]`);
  if (p.minWindKt !== undefined) query = query.where('s.peak_wind_kt', '>=', p.minWindKt);
  if (cursor) query = query.where(keyset(sort, 's.sid', cursor.key, cursor.lastId));
  query = query
    .orderBy(sql.raw(sort.key), sort.ascending ? 'asc' : 'desc')
    .orderBy('s.sid', 'asc')
    .limit(limit + 1);

  const r = await catalogue(rq, 'listStorms', [q(query)]);
  if (r.done) return r.done;
  const rows = r.rows[0]!;
  const items = [...rows].slice(0, limit).map(stormSummary);
  let nextCursor: string | undefined;
  if (rows.length > limit) {
    const last = rows.row(limit - 1);
    nextCursor = encodeCursor(sort.wire, sort.kind, last.s('sort_key'), last.s('s_sid'));
  }
  const body: Schemas['StormPage'] = { items, ...(nextCursor ? { nextCursor } : {}) };
  return sendJSON(rq, body, r.etag, nextCursor);
}

/** GET /v1/storms/{sid}: summary, peak, per-agency intensity, landfalls, sources. */
export async function getStorm(rq: Rq, path: Record<string, string>): Promise<Response> {
  const { sid } = bind('getStorm', rq, path);
  const detail = db
    .selectFrom('catalog.storm as s')
    .leftJoin('catalog.pagasa_name as pn', 'pn.sid', 's.sid')
    .select([
      's.sid',
      's.name',
      's.season',
      's.basin',
      's.number',
      's.atcf_id',
      ts('s.started_at').as('started_at'),
      ts('s.ended_at').as('ended_at'),
      sql<string>`extract(epoch FROM s.ended_at - s.started_at) / 3600.0`.as('duration_hours'),
      's.fix_count',
      sql<string>`coalesce(array_to_json(s.landfall_countries)::text, '[]')`.as('landfall_countries'),
      's.replay_available',
      's.name_ja',
      'pn.pagasa_name',
      'pn.source_url as pagasa_url',
      's.peak_wind_kt',
      's.peak_wind_agency',
      's.min_pressure_hpa',
      ts('s.peak_at').as('peak_at'),
      lon('s.peak_position').as('peak_lon'),
      lat('s.peak_position').as('peak_lat'),
      's.jtwc_max_wind_kt',
      's.jtwc_min_pressure_hpa',
      's.jma_max_wind_kt',
      's.jma_min_pressure_hpa',
      's.wmo_max_wind_kt',
      's.wmo_min_pressure_hpa',
      sql<string>`(SELECT ibtracs_version FROM catalog.dataset_version ORDER BY version DESC LIMIT 1)`.as('ibtracs_version'),
    ])
    .where('s.sid', '=', sid);
  const landfalls = db
    .selectFrom('catalog.storm_landfall')
    .select(['country', ts('at').as('at'), 'place_id', lon('position').as('lon'), lat('position').as('lat')])
    .where('sid', '=', sid)
    .orderBy('seq');

  const r = await catalogue(rq, 'getStorm', [q(detail), q(landfalls)]);
  if (r.done) return r.done;
  if (r.rows[0]!.length === 0) throw missing('No such storm.');
  const d = r.rows[0]!.row(0);

  // Lifetime extremes per agency. In the WP basin "wmo" is JMA, so it is listed only when JMA itself is absent.
  const intensity: Schemas['AgencyIntensity'][] = [];
  const agency = (name: Schemas['AgencyIntensity']['agency'], minutes: 1 | 10, wind: string, pressure: string) => {
    if (d.n(wind) === null && d.n(pressure) === null) return false;
    intensity.push({ agency: name, windAveragingMinutes: minutes, maxWindKt: d.num(wind), minPressureHpa: d.num(pressure) });
    return true;
  };
  agency('jtwc', 1, 'jtwc_max_wind_kt', 'jtwc_min_pressure_hpa');
  if (!agency('jma', 10, 'jma_max_wind_kt', 'jma_min_pressure_hpa')) agency('wmo', 10, 'wmo_max_wind_kt', 'wmo_min_pressure_hpa');

  const version = d.n('ibtracs_version') ?? 'v04r01';
  const sources: Schemas['DataSource'][] = [
    {
      id: `ibtracs-${slug(version)}`,
      name: `IBTrACS ${version} (NOAA NCEI)`,
      url: 'https://www.ncei.noaa.gov/products/international-best-track-archive',
      license: 'Public domain (NOAA)',
    },
  ];
  if (d.n('pagasa_name') !== null && d.n('pagasa_url') !== null) {
    sources.push({ id: 'pagasa-names', name: 'PAGASA local name crosswalk', url: d.s('pagasa_url') });
  }

  const body: Schemas['StormDetail'] = {
    sid: d.s('sid'),
    name: d.s('name'),
    ...localNames(d.n('pagasa_name'), d.n('name_ja')),
    season: Number(d.s('season')),
    basin: d.s('basin') as Schemas['Basin'],
    number: d.num('number'),
    atcfId: d.opt('atcf_id'),
    startedAt: d.s('started_at'),
    endedAt: d.s('ended_at'),
    durationHours: Number(d.s('duration_hours')),
    fixCount: Number(d.s('fix_count')),
    landfallCountries: JSON.parse(d.s('landfall_countries')),
    peak: {
      windKt: d.num('peak_wind_kt'),
      agency: d.opt('peak_wind_agency') as Schemas['Agency'] | undefined,
      pressureHpa: d.num('min_pressure_hpa'),
      at: d.opt('peak_at'),
      ...(d.n('peak_lon') !== null ? { position: lonLat(d.s('peak_lon'), d.s('peak_lat')) } : {}),
    },
    intensity,
    landfalls: [...r.rows[1]!].map((l) => ({
      country: l.s('country') as Schemas['CountryCode'],
      at: l.s('at'),
      position: lonLat(l.s('lon'), l.s('lat')),
      placeId: l.opt('place_id'),
    })),
    sources,
    replayAvailable: d.bool('replay_available'),
  };
  return sendJSON(rq, body, r.etag);
}

/** Lowercase, every run of characters outside [a-z0-9] as one "-" (v04r01 → v04r01). */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** GET /v1/storms/{sid}/track: best-track fixes as a GeoJSON FeatureCollection. */
export async function getStormTrack(rq: Rq, path: Record<string, string>): Promise<Response> {
  const { sid } = bind('getStormTrack', rq, path);
  const track = db
    .selectFrom('catalog.storm_fix')
    .select([
      ts('observed_at').as('at'),
      'wind_kt',
      'wind_agency',
      'gust_kt',
      'pressure_hpa',
      'nature',
      'sshs_category',
      'jma_grade',
      'dist_to_land_km',
      'speed_kt',
      'direction_deg',
      lon('position').as('lon'),
      lat('position').as('lat'),
    ])
    .where('sid', '=', sid)
    .orderBy('observed_at');
  const r = await catalogue(rq, 'getStormTrack', [exists(sid), q(track)]);
  if (r.done) return r.done;
  if (!r.rows[0]!.row(0).bool('e')) throw missing('No such storm.');
  const body: Schemas['StormTrack'] = {
    type: 'FeatureCollection',
    sid,
    resolution: 'best-track',
    features: [...r.rows[1]!].map((f) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: lonLat(f.s('lon'), f.s('lat')) },
      properties: {
        at: f.s('at'),
        windKt: f.num('wind_kt'),
        windAgency: f.opt('wind_agency') as Schemas['Agency'] | undefined,
        gustKt: f.num('gust_kt'),
        pressureHpa: f.num('pressure_hpa'),
        nature: f.opt('nature') as Schemas['TrackPointProperties']['nature'],
        sshsCategory: f.num('sshs_category'),
        jmaGrade: f.num('jma_grade'),
        distanceToLandKm: f.num('dist_to_land_km'),
        speedKt: f.num('speed_kt'),
        directionDeg: f.num('direction_deg'),
      },
    })),
  };
  return sendJSON(rq, body, r.etag, undefined, 'application/geo+json');
}

/** GET /v1/storms/{sid}/places: places this storm passed within radiusKm of, closest first. */
export async function listStormPlaces(rq: Rq, path: Record<string, string>): Promise<Response> {
  const p = bind('listStormPlaces', rq, path);
  const radius = (p.radiusKm ?? 200) as Radius;
  const limit = p.limit ?? 50;
  const cursor = decodeCursor(p.cursor, 'closest', 'number');
  let query = db
    .selectFrom('catalog.place_storm_exposure as e')
    .innerJoin('catalog.place as p', 'p.place_id', 'e.place_id')
    .select(placeColumns)
    .select([
      sql<string>`e.closest_approach_km::text`.as('km'),
      ts('e.closest_approach_at').as('at'),
      sql.raw<string>(`e.max_wind_kt_r${radius}`).as('wind'),
      sql.raw<string>(`e.max_gust_kt_r${radius}`).as('gust'),
      sql.raw<string>(`e.hours_r${radius}`).as('hours'),
    ])
    .where('e.sid', '=', p.sid)
    .where(sql<boolean>`e.closest_approach_km <= ${radius}::int`);
  if (p.country !== undefined) query = query.where('p.country', '=', p.country);
  if (cursor) query = query.where(keyset({ key: 'e.closest_approach_km', ascending: true, cast: '::numeric' }, 'e.place_id', cursor.key, cursor.lastId));
  query = query.orderBy('e.closest_approach_km', 'asc').orderBy('e.place_id', 'asc').limit(limit + 1);

  const r = await catalogue(rq, 'listStormPlaces', [exists(p.sid), q(query)]);
  if (r.done) return r.done;
  if (!r.rows[0]!.row(0).bool('e')) throw missing('No such storm.');
  const rows = r.rows[1]!;
  let nextCursor: string | undefined;
  if (rows.length > limit) {
    const last = rows.row(limit - 1);
    nextCursor = encodeCursor('closest', 'number', last.s('km'), last.s('p_id'));
  }
  const body: Schemas['PlaceHitPage'] = {
    items: [...rows].slice(0, limit).map((row) => ({ place: placeSummary(row), ...exposure(row) })),
    radiusKm: radius,
    ...(nextCursor ? { nextCursor } : {}),
  };
  return sendJSON(rq, body, r.etag, nextCursor);
}
