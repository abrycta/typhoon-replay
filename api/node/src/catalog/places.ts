// Places and "typhoons that hit my town": GET /v1/places/search, /v1/places/nearest, /v1/places/{placeId},
// /v1/places/{placeId}/storms (precomputed bands) and /v1/hits (an arbitrary point, computed in PostGIS).
import type { AliasedRawBuilder } from 'kysely';
import type { components } from '../generated/contract';
import { decodeCursor, encodeCursor, type Cursor } from '../platform/cursor';
import type { Rq } from '../platform/http';
import { bind } from '../platform/params';
import { missing } from '../platform/problem';
import type { Rows } from '../platform/neon';
import { catalogue, exposure, lonLat, placeSummary, sendJSON, stormSummary } from './read';
import { db, keyset, likeEscape, placeColumns, q, sql, stormColumns, ts, type Radius, type SortSpec } from './sql';

type Schemas = components['schemas'];

const HIT_SORTS: Record<string, SortSpec> = {
  closest: { wire: 'closest', key: 'h.km', ascending: true, cast: '::numeric', render: 'h.km::text', kind: 'number' },
  'peak-wind-desc': {
    wire: 'peak-wind-desc',
    key: 'coalesce(h.wind, -1)',
    ascending: false,
    cast: '::numeric',
    render: 'coalesce(h.wind, -1)::text',
    kind: 'number',
  },
  'peak-gust-desc': {
    wire: 'peak-gust-desc',
    key: 'coalesce(h.gust, -1)',
    ascending: false,
    cast: '::numeric',
    render: 'coalesce(h.gust, -1)::text',
    kind: 'number',
  },
  'date-desc': {
    wire: 'date-desc',
    key: 'h.at',
    ascending: false,
    cast: '::timestamptz',
    render: `to_char(h.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
    kind: 'timestamp',
  },
};

/** GET /v1/places/search: exact name, then prefix, then substring; ties by population, then id. */
export async function searchPlaces(rq: Rq): Promise<Response> {
  const p = bind('searchPlaces', rq);
  const like = likeEscape(p.q);
  let query = db
    .selectFrom('catalog.place as p')
    .select(placeColumns)
    .where(sql<boolean>`p.search_text LIKE '%' || lower(${like}) || '%' ESCAPE '\\'`);
  if (p.country !== undefined) query = query.where('p.country', '=', p.country);
  query = query
    .orderBy(
      sql`CASE WHEN lower(p.name) = lower(${p.q}) OR p.name_ja = ${p.q} THEN 0
               WHEN lower(p.name) LIKE lower(${like}) || '%' ESCAPE '\\' OR p.name_ja LIKE ${like} || '%' ESCAPE '\\' THEN 1
               ELSE 2 END`,
    )
    .orderBy(sql`p.population DESC NULLS LAST`)
    .orderBy('p.place_id')
    .limit(p.limit ?? 10);
  const r = await catalogue(rq, 'searchPlaces', [q(query)]);
  if (r.done) return r.done;
  const body: Schemas['PlaceSearchResults'] = { items: [...r.rows[0]!].map(placeSummary) };
  return sendJSON(rq, body, r.etag);
}

const point = (lon: number, lat: number) => sql`ST_SetSRID(ST_MakePoint(${String(lon)}::float8, ${String(lat)}::float8), 4326)::geography`;

/** GET /v1/places/nearest: the place containing the point, else the nearest within 50 km. */
export async function getNearestPlace(rq: Rq): Promise<Response> {
  const p = bind('getNearestPlace', rq);
  const query = db
    .selectFrom(['catalog.place as p', sql<{ g: unknown }>`(SELECT ${point(p.lon, p.lat)} AS g)`.as('pt')])
    .select(placeColumns)
    .select([
      sql<string>`ST_Covers(p.geom, pt.g)`.as('contains'),
      sql<string>`round((ST_Distance(p.geom, pt.g) / 1000.0)::numeric, 1)::text`.as('km'),
    ])
    .where(sql<boolean>`ST_DWithin(p.geom, pt.g, 50000)`)
    .orderBy(sql`ST_Distance(p.geom, pt.g)`)
    .orderBy('p.place_id')
    .limit(1);
  const r = await catalogue(rq, 'getNearestPlace', [q(query)]);
  if (r.done) return r.done;
  if (r.rows[0]!.length === 0) throw missing('No covered place within 50 km of this point.');
  const row = r.rows[0]!.row(0);
  const contains = row.bool('contains');
  const body: Schemas['NearestPlace'] = { place: placeSummary(row), contains, distanceKm: contains ? 0 : Number(row.s('km')) };
  return sendJSON(rq, body, r.etag);
}

/** GET /v1/places/{placeId}: properties and the display-simplified boundary (inside the 64 KB cap). */
export async function getPlace(rq: Rq, path: Record<string, string>): Promise<Response> {
  const { placeId } = bind('getPlace', rq, path);
  const query = db
    .selectFrom('catalog.place as p')
    .select(placeColumns)
    .select([
      'p.population',
      'p.area_km2',
      sql<string>`round(ST_XMin(p.geom_display::geometry)::numeric, 4)`.as('min_lon'),
      sql<string>`round(ST_YMin(p.geom_display::geometry)::numeric, 4)`.as('min_lat'),
      sql<string>`round(ST_XMax(p.geom_display::geometry)::numeric, 4)`.as('max_lon'),
      sql<string>`round(ST_YMax(p.geom_display::geometry)::numeric, 4)`.as('max_lat'),
      sql<string>`ST_AsGeoJSON(p.geom_display::geometry, 4)`.as('geojson'),
    ])
    .where('p.place_id', '=', placeId);
  const r = await catalogue(rq, 'getPlace', [q(query)]);
  if (r.done) return r.done;
  if (r.rows[0]!.length === 0) throw missing('No such place.');
  const row = r.rows[0]!.row(0);
  const detail: Omit<Schemas['PlaceDetail'], 'geometry'> = {
    ...placeSummary(row),
    population: row.num('population'),
    areaKm2: Number(row.s('area_km2')),
    bbox: [row.s('min_lon'), row.s('min_lat'), row.s('max_lon'), row.s('max_lat')].map(Number) as Schemas['PlaceDetail']['bbox'],
  };
  // The boundary is spliced in as the GeoJSON text PostGIS wrote: no parse and re-serialise of up to tens of KB.
  const json = JSON.stringify(detail);
  return sendJSON(rq, `${json.slice(0, -1)},"geometry":${row.s('geojson')}}`, r.etag);
}

interface HitRequest {
  radius: Radius;
  sort: SortSpec;
  cursor?: Cursor;
  limit: number;
  minWindKt?: number;
}

function hitRequest(p: { radiusKm?: number; sort?: string; cursor?: string; limit?: number; minWindKt?: number }): HitRequest {
  const sort = HIT_SORTS[p.sort ?? 'closest']!;
  return {
    radius: (p.radiusKm ?? 200) as Radius,
    sort,
    cursor: decodeCursor(p.cursor, sort.wire, sort.kind),
    limit: p.limit ?? 50,
    minWindKt: p.minWindKt,
  };
}

type HitColumns = { sid: string; km: string; at: string; wind: number | null; gust: number | null; hours: number };

/** The page query over a hits relation `h` (columns sid, km, at, wind, gust, hours). */
function stormHits(source: AliasedRawBuilder<HitColumns, 'h'>, h: HitRequest) {
  let query = db
    .selectFrom(source)
    .innerJoin('catalog.storm as s', 's.sid', 'h.sid')
    .leftJoin('catalog.pagasa_name as pn', 'pn.sid', 's.sid')
    .select(stormColumns)
    .select([
      sql<string>`h.km::text`.as('km'),
      ts('h.at').as('at'),
      'h.wind',
      'h.gust',
      'h.hours',
      sql.raw<string>(h.sort.render).as('sort_key'),
    ]);
  if (h.minWindKt !== undefined) query = query.where(sql<boolean>`h.wind >= ${h.minWindKt}::int`);
  if (h.cursor) query = query.where(keyset(h.sort, 's.sid', h.cursor.key, h.cursor.lastId));
  return query
    .orderBy(sql.raw(h.sort.key), h.sort.ascending ? 'asc' : 'desc')
    .orderBy('s.sid', 'asc')
    .limit(h.limit + 1);
}

function hitPage(rows: Rows, h: HitRequest): { body: Schemas['StormHitPage']; nextCursor?: string } {
  let nextCursor: string | undefined;
  if (rows.length > h.limit) {
    const last = rows.row(h.limit - 1);
    nextCursor = encodeCursor(h.sort.wire, h.sort.kind, last.s('sort_key'), last.s('s_sid'));
  }
  const items = [...rows].slice(0, h.limit).map((row) => ({ storm: stormSummary(row), ...exposure(row) }));
  return { body: { items, radiusKm: h.radius, ...(nextCursor ? { nextCursor } : {}) }, nextCursor };
}

/** GET /v1/places/{placeId}/storms: from the precomputed catalog.place_storm_exposure bands. */
export async function listPlaceStorms(rq: Rq, path: Record<string, string>): Promise<Response> {
  const p = bind('listPlaceStorms', rq, path);
  const h = hitRequest(p);
  const r = h.radius;
  const seasons = sql.join(
    [
      ...(p.from !== undefined ? [sql`AND e.season >= ${p.from}::int`] : []),
      ...(p.to !== undefined ? [sql`AND e.season <= ${p.to}::int`] : []),
    ],
    sql` `,
  );
  const source = sql<HitColumns>`(
    SELECT e.sid, e.closest_approach_km AS km, e.closest_approach_at AS at, ${sql.raw(`e.max_wind_kt_r${r}`)} AS wind,
           ${sql.raw(`e.max_gust_kt_r${r}`)} AS gust, ${sql.raw(`e.hours_r${r}`)} AS hours
    FROM catalog.place_storm_exposure e
    WHERE e.place_id = ${p.placeId} AND e.closest_approach_km <= ${r}::int ${seasons})`.as('h');
  const exists = sql`SELECT EXISTS (SELECT 1 FROM catalog.place WHERE place_id = ${p.placeId}) AS e`;
  const res = await catalogue(rq, 'listPlaceStorms', [q(exists), q(stormHits(source, h))]);
  if (res.done) return res.done;
  if (!res.rows[0]!.row(0).bool('e')) throw missing('No such place.');
  const page = hitPage(res.rows[1]!, h);
  return sendJSON(rq, page.body, res.etag, page.nextCursor);
}

/**
 * GET /v1/hits: the same question for an arbitrary point. Candidate storms whose best-track line passes within the
 * radius (GiST on storm.track); their fixes interpolated to hourly points, then aggregated as the pipeline does for the
 * precomputed bands (geodesic distance on geography).
 */
export async function listPointStorms(rq: Rq): Promise<Response> {
  const p = bind('listPointStorms', rq);
  const h = hitRequest(p);
  const metres = String(h.radius * 1000);
  const seasons = sql.join(
    [
      ...(p.from !== undefined ? [sql`AND s.season >= ${p.from}::int`] : []),
      ...(p.to !== undefined ? [sql`AND s.season <= ${p.to}::int`] : []),
    ],
    sql` `,
  );
  const source = sql<HitColumns>`(
    WITH pt AS (SELECT ${point(p.lon, p.lat)} AS g),
    cand AS (
      SELECT s.sid FROM catalog.storm s, pt
      WHERE s.track IS NOT NULL AND ST_DWithin(s.track, pt.g, ${metres}::float8) ${seasons}
    ),
    ordered AS (
      SELECT f.sid, f.observed_at, ST_X(f.position::geometry) AS lon, ST_Y(f.position::geometry) AS lat,
             f.wind_kt, f.gust_kt,
             lead(f.observed_at) OVER w AS t2, lead(ST_X(f.position::geometry)) OVER w AS lon2,
             lead(ST_Y(f.position::geometry)) OVER w AS lat2, lead(f.wind_kt) OVER w AS wind2,
             lead(f.gust_kt) OVER w AS gust2
      FROM catalog.storm_fix f JOIN cand ON cand.sid = f.sid
      WINDOW w AS (PARTITION BY f.sid ORDER BY f.observed_at)
    ),
    hourly AS (
      SELECT o.sid, o.observed_at + make_interval(hours => hh) AS at,
             ST_SetSRID(ST_MakePoint(o.lon + (o.lon2 - o.lon) * ff.f, o.lat + (o.lat2 - o.lat) * ff.f), 4326)::geography AS pos,
             round(o.wind_kt + (o.wind2 - o.wind_kt) * ff.f)::smallint AS wind_kt,
             round(o.gust_kt + (o.gust2 - o.gust_kt) * ff.f)::smallint AS gust_kt
      FROM ordered o
      CROSS JOIN LATERAL generate_series(0, (extract(epoch FROM o.t2 - o.observed_at) / 3600)::int - 1) AS hh
      CROSS JOIN LATERAL (SELECT hh / (extract(epoch FROM o.t2 - o.observed_at) / 3600) AS f) ff
      WHERE o.t2 IS NOT NULL
      UNION ALL
      SELECT * FROM (
        SELECT DISTINCT ON (f.sid) f.sid, f.observed_at, f.position, f.wind_kt, f.gust_kt
        FROM catalog.storm_fix f JOIN cand ON cand.sid = f.sid ORDER BY f.sid, f.observed_at DESC) last_fix
    ),
    dist AS (
      SELECT h.sid, h.at, h.wind_kt, h.gust_kt, ST_Distance(h.pos, pt.g) / 1000.0 AS km
      FROM hourly h, pt WHERE ST_DWithin(h.pos, pt.g, ${metres}::float8)
    )
    SELECT sid, round(min(km)::numeric, 1) AS km, (array_agg(at ORDER BY km, at))[1] AS at,
           max(wind_kt) AS wind, max(gust_kt) AS gust, count(*) AS hours
    FROM dist GROUP BY sid)`.as('h');
  // The planner over-estimates the interpolated rows and JIT-compiles the plan (about 1 s of LLVM time for a 60 ms
  // query). SET LOCAL lasts only for this transaction.
  const res = await catalogue(rq, 'listPointStorms', [q(sql`SET LOCAL jit = off`), q(stormHits(source, h))]);
  if (res.done) return res.done;
  const page = hitPage(res.rows[1]!, h);
  return sendJSON(rq, page.body, res.etag, page.nextCursor);
}
