//! SQL shared by the catalogue queries, ported from the Java reference (CatalogRows, StormQueries, PlaceQueries,
//! HitQueries). Postgres formats what the contract fixes: timestamps as RFC 3339 UTC whole seconds, coordinates
//! rounded to 4 decimals, country lists as JSON.

use crate::web::{Cursor, KeyKind};

/// A timestamptz expression as `2013-11-08T00:00:00Z`.
pub fn ts(expr: &str) -> String {
    format!(r#"to_char({expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')"#)
}
pub fn lon(geo: &str) -> String {
    format!("round(ST_X({geo}::geometry)::numeric, 4)")
}
pub fn lat(geo: &str) -> String {
    format!("round(ST_Y({geo}::geometry)::numeric, 4)")
}

pub const STORM_FROM: &str = "catalog.storm s LEFT JOIN catalog.pagasa_name pn ON pn.sid = s.sid";

pub fn storm_columns() -> String {
    format!(
        "s.sid AS s_sid, s.name AS s_name, s.season AS s_season, s.basin AS s_basin, {} AS s_started_at, \
         {} AS s_ended_at, s.peak_wind_kt AS s_peak_wind_kt, s.peak_wind_agency AS s_peak_wind_agency, \
         s.min_pressure_hpa AS s_min_pressure_hpa, \
         coalesce(array_to_json(s.landfall_countries)::text, '[]') AS s_landfall_countries, s.name_ja AS s_name_ja, \
         pn.pagasa_name AS s_name_ph",
        ts("s.started_at"),
        ts("s.ended_at")
    )
}

pub fn place_columns() -> String {
    format!(
        "p.place_id AS p_id, p.country AS p_country, p.kind AS p_kind, p.name AS p_name, p.name_ja AS p_name_ja, \
         p.admin1 AS p_admin1, p.admin1_ja AS p_admin1_ja, p.admin2 AS p_admin2, {} AS p_lon, {} AS p_lat",
        lon("p.centroid"),
        lat("p.centroid")
    )
}

/// The newest `catalog.dataset_version` (0 before the first publish).
pub const DATASET_VERSION: &str = "SELECT coalesce((SELECT version FROM catalog.current_dataset_version), 0) AS v";

/// Query parameters numbered `$1`, `$2`, ... in the order they are added.
#[derive(Default)]
pub struct Args(pub Vec<Option<String>>);

impl Args {
    pub fn add(&mut self, v: impl ToString) -> String {
        self.0.push(Some(v.to_string()));
        format!("${}", self.0.len())
    }
}

/// LIKE wildcards in user input escaped (`\` is the escape character).
pub fn like_escape(s: &str) -> String {
    s.replace('\\', r"\\").replace('%', r"\%").replace('_', r"\_")
}

/// One fixed sort order: the ORDER BY key, its direction, the cast of its keyset parameter, and the expression that
/// renders the key for the next cursor.
#[derive(Debug, Clone)]
pub struct Sort {
    pub wire: &'static str,
    pub key: &'static str,
    pub ascending: bool,
    pub cast: &'static str,
    pub render: String,
    pub kind: KeyKind,
}

impl Sort {
    pub fn num(wire: &'static str, key: &'static str, ascending: bool) -> Self {
        Sort {
            wire,
            key,
            ascending,
            cast: "::numeric",
            render: format!("{key}::text"),
            kind: KeyKind::Number,
        }
    }
    pub fn dir(&self) -> &'static str {
        if self.ascending { "ASC" } else { "DESC" }
    }
}

/// "After the cursor": `(key > k OR (key = k AND id > lastId))`, `<` for descending sorts.
pub fn keyset(sql: &mut String, a: &mut Args, sort: &Sort, id_column: &str, cur: &Cursor) {
    let cmp = if sort.ascending { ">" } else { "<" };
    let kp = format!("{}{}", a.add(&cur.key), sort.cast);
    let lp = a.add(&cur.last_id);
    let key = sort.key;
    sql.push_str(&format!(
        " AND ({key} {cmp} {kp} OR ({key} = {kp} AND {id_column} > {lp}))"
    ));
}

/// Candidate storms whose best-track line passes within the radius of the point (GiST on storm.track), their fixes
/// interpolated to hourly points, then aggregated as the pipeline does for the precomputed bands. `%SEASONS%` is
/// replaced with the season filter on `s`. Parameters: $1 lon, $2 lat, $3 radius in metres.
pub const POINT_HITS_CTE: &str = r#"pt AS (SELECT ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326)::geography AS g),
cand AS (
  SELECT s.sid FROM catalog.storm s, pt
  WHERE s.track IS NOT NULL AND ST_DWithin(s.track, pt.g, $3::float8) %SEASONS%
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
  FROM hourly h, pt WHERE ST_DWithin(h.pos, pt.g, $3::float8)
),
hits AS (
  SELECT sid, round(min(km)::numeric, 1) AS km, (array_agg(at ORDER BY km, at))[1] AS at,
         max(wind_kt) AS wind, max(gust_kt) AS gust, count(*) AS hours
  FROM dist GROUP BY sid
)"#;
