// Kysely, used only to build and compile SQL: a typed view of the contract's schema (contracts/db/migrations), with a
// dummy driver. Statements are compiled to {sql, parameters} and sent to Neon over HTTP (platform/neon.ts).
//
// Postgres formats what the contract fixes, so TypeScript only copies text: timestamps as RFC 3339 UTC whole
// seconds, coordinates rounded to 4 decimals, country lists as JSON (ported from the Java reference's CatalogRows).
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type Compilable,
  type RawBuilder,
} from 'kysely';
import type { Query } from '../platform/neon';

type Geo = unknown;

/** The tables the API reads (catalog, live) and the dbmate version table. Columns as in contracts/db/migrations. */
export interface DB {
  'catalog.dataset_version': { version: number; published_at: string; ibtracs_version: string };
  'catalog.current_dataset_version': { version: number };
  'catalog.storm': {
    sid: string;
    season: number;
    basin: string;
    number: number | null;
    name: string;
    name_ja: string | null;
    atcf_id: string | null;
    started_at: string;
    ended_at: string;
    fix_count: number;
    peak_wind_kt: number | null;
    peak_wind_agency: string | null;
    peak_at: string | null;
    peak_position: Geo;
    min_pressure_hpa: number | null;
    jtwc_max_wind_kt: number | null;
    jtwc_min_pressure_hpa: number | null;
    jma_max_wind_kt: number | null;
    jma_min_pressure_hpa: number | null;
    wmo_max_wind_kt: number | null;
    wmo_min_pressure_hpa: number | null;
    landfall_countries: string[];
    track: Geo;
    replay_available: boolean;
    search_text: string;
  };
  'catalog.pagasa_name': { sid: string; pagasa_name: string; source_url: string | null };
  'catalog.storm_landfall': { sid: string; seq: number; country: string; at: string; position: Geo; place_id: string | null };
  'catalog.storm_fix': {
    sid: string;
    observed_at: string;
    position: Geo;
    wind_kt: number | null;
    wind_agency: string | null;
    pressure_hpa: number | null;
    gust_kt: number | null;
    jma_grade: number | null;
    sshs_category: number | null;
    nature: string | null;
    dist_to_land_km: number | null;
    speed_kt: number | null;
    direction_deg: number | null;
  };
  'catalog.place': {
    place_id: string;
    country: string;
    kind: string;
    name: string;
    name_ja: string | null;
    admin1: string;
    admin1_ja: string | null;
    admin2: string | null;
    population: number | null;
    area_km2: string;
    centroid: Geo;
    geom: Geo;
    geom_display: Geo;
    search_text: string;
  };
  'catalog.place_storm_exposure': {
    place_id: string;
    sid: string;
    season: number;
    closest_approach_km: string;
    closest_approach_at: string;
  } & Record<`${'max_wind_kt' | 'max_gust_kt' | 'hours'}_r${Radius}`, number | null>;
  'live.revision': { singleton: boolean; seq: string; updated_at: string };
  'live.live_event': { seq: string; type: string; live_id: string; payload: unknown };
  'live.active_storm': { live_id: string; storm: unknown };
  'public.schema_migrations': { version: string };
}

export type Radius = 50 | 100 | 200 | 300 | 500;

export const db = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

export { sql };

/** Compile a Kysely query or raw statement for the Neon batch. */
export const q = (c: Compilable | RawBuilder<unknown>): Query => {
  // Query builders ignore the argument; raw statements need it (the dummy executor only supplies the compiler).
  const { sql: text, parameters } = (c as RawBuilder<unknown>).compile(db);
  return { sql: text, parameters };
};

/** A timestamptz as 2013-11-08T00:00:00Z. */
export const ts = (expr: RawBuilder<unknown> | string): RawBuilder<string> =>
  sql<string>`to_char(${typeof expr === 'string' ? sql.raw(expr) : expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
export const lon = (geo: string) => sql<string>`round(ST_X(${sql.raw(geo)}::geometry)::numeric, 4)`;
export const lat = (geo: string) => sql<string>`round(ST_Y(${sql.raw(geo)}::geometry)::numeric, 4)`;

/** StormSummary columns over `catalog.storm s LEFT JOIN catalog.pagasa_name pn`. */
export const stormColumns = [
  sql<string>`s.sid`.as('s_sid'),
  sql<string>`s.name`.as('s_name'),
  sql<string>`s.season`.as('s_season'),
  sql<string>`s.basin`.as('s_basin'),
  ts('s.started_at').as('s_started_at'),
  ts('s.ended_at').as('s_ended_at'),
  sql<string>`s.peak_wind_kt`.as('s_peak_wind_kt'),
  sql<string>`s.peak_wind_agency`.as('s_peak_wind_agency'),
  sql<string>`s.min_pressure_hpa`.as('s_min_pressure_hpa'),
  sql<string>`coalesce(array_to_json(s.landfall_countries)::text, '[]')`.as('s_landfall_countries'),
  sql<string>`s.name_ja`.as('s_name_ja'),
  sql<string>`pn.pagasa_name`.as('s_name_ph'),
] as const;

/** PlaceSummary columns over `catalog.place p`. */
export const placeColumns = [
  sql<string>`p.place_id`.as('p_id'),
  sql<string>`p.country`.as('p_country'),
  sql<string>`p.kind`.as('p_kind'),
  sql<string>`p.name`.as('p_name'),
  sql<string>`p.name_ja`.as('p_name_ja'),
  sql<string>`p.admin1`.as('p_admin1'),
  sql<string>`p.admin1_ja`.as('p_admin1_ja'),
  sql<string>`p.admin2`.as('p_admin2'),
  lon('p.centroid').as('p_lon'),
  lat('p.centroid').as('p_lat'),
] as const;

/** The newest catalog.dataset_version (0 before the first publish): the first statement of every catalogue batch. */
export const datasetVersion = sql<string>`SELECT coalesce((SELECT version FROM catalog.current_dataset_version), 0) AS v`;

/** Escape LIKE wildcards in user input (\ is the escape character). */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** One fixed sort order: its wire name, ORDER BY key, direction, the cast of its keyset parameter, its key renderer. */
export interface SortSpec {
  wire: string;
  key: string;
  ascending: boolean;
  cast: string;
  render: string;
  kind: 'number' | 'string' | 'timestamp';
}

/** "After the cursor": (key > k OR (key = k AND id > lastId)), with < for descending sorts. */
export function keyset(s: Pick<SortSpec, 'key' | 'ascending' | 'cast'>, idColumn: string, key: string, lastId: string) {
  const k = sql.raw(s.key);
  const cmp = sql.raw(s.ascending ? '>' : '<');
  const cast = sql.raw(s.cast);
  return sql<boolean>`(${k} ${cmp} ${key}${cast} OR (${k} = ${key}${cast} AND ${sql.raw(idColumn)} > ${lastId}))`;
}
