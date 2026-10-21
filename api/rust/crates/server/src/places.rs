//! Places and "typhoons that hit my town": search, nearest, one place, the storms that passed it, and the same
//! question for an arbitrary point.

use std::sync::Arc;

use axum::Extension;
use axum::extract::State;
use axum::response::Response;
use contract as c;

use crate::app::{App, bad_row};
use crate::neon::{Query, Rows};
use crate::rows::{self, R};
use crate::sql::{self, Args, Sort};
use crate::web::{self, Ctx, Cursor, JSON, KeyKind, Problem};

type Reply = Result<Response, Response>;

const SEARCH_PARAMS: &[&str] = &["q", "country", "limit"];
const POINT_PARAMS: &[&str] = &["lat", "lon"];
const HIT_PARAMS: &[&str] = &["radiusKm", "minWindKt", "from", "to", "sort", "cursor", "limit"];
const POINT_HIT_PARAMS: &[&str] = &[
    "lat",
    "lon",
    "radiusKm",
    "minWindKt",
    "from",
    "to",
    "sort",
    "cursor",
    "limit",
];

fn hit_sort(wire: &str) -> Option<Sort> {
    Some(match wire {
        "closest" => Sort::num("closest", "h.km", true),
        "peak-wind-desc" => Sort::num("peak-wind-desc", "coalesce(h.wind, -1)", false),
        "peak-gust-desc" => Sort::num("peak-gust-desc", "coalesce(h.gust, -1)", false),
        "date-desc" => Sort {
            wire: "date-desc",
            key: "h.at",
            ascending: false,
            cast: "::timestamptz",
            render: sql::ts("h.at"),
            kind: KeyKind::Timestamp,
        },
        _ => return None,
    })
}

/// The `{placeId}` path segment, checked against `^(PH-[0-9]{10}|JP-[0-9]{5})$`.
fn place_id(ctx: &Ctx) -> Result<String, Problem> {
    let s = ctx.path.split('/').nth(3).unwrap_or("");
    if web::place_id_shape(s) {
        Ok(s.to_string())
    } else {
        Err(Problem::invalid(
            "#/path/placeId",
            "must match ^(PH-[0-9]{10}|JP-[0-9]{5})$",
        ))
    }
}

/// GET /v1/places/search. Exact name, then prefix, then substring; ties by population, then id.
#[worker::send]
pub async fn search(State(app): State<Arc<App>>, Extension(ctx): Extension<Arc<Ctx>>) -> Reply {
    web::non_empty(&ctx, SEARCH_PARAMS)?;
    let q = web::string(&ctx, "q", 1, 64)?.ok_or_else(|| Problem::invalid("#/query/q", "is required"))?;
    let country = web::country(&ctx)?;
    let limit = web::limit(&ctx, 10, 50)?;
    let mut a = Args::default();
    let qp = a.add(q);
    let like = a.add(sql::like_escape(q));
    let filter = country
        .map(|cc| format!(" AND p.country = {}", a.add(cc)))
        .unwrap_or_default();
    let lp = a.add(limit);
    let sql = format!(
        "SELECT {} FROM catalog.place p WHERE p.search_text LIKE '%' || lower({like}) || '%' ESCAPE '\\'{filter} \
         ORDER BY CASE WHEN lower(p.name) = lower({qp}) OR p.name_ja = {qp} THEN 0 \
         WHEN lower(p.name) LIKE lower({like}) || '%' ESCAPE '\\' OR p.name_ja LIKE {like} || '%' ESCAPE '\\' THEN 1 \
         ELSE 2 END, p.population DESC NULLS LAST, p.place_id LIMIT {lp}::int",
        sql::place_columns()
    );
    let (res, etag) = app.catalogue(&ctx, SEARCH_PARAMS, vec![Query::with(sql, a.0)]).await?;
    let items = res[0]
        .iter()
        .map(|r| rows::place_summary(&r))
        .collect::<R<Vec<_>>>()
        .map_err(|b| bad_row(&ctx, b))?;
    Ok(web::json(&c::PlaceSearchResults { items }, JSON, Some(etag), None))
}

/// GET /v1/places/nearest. The place containing the point, else the nearest within 50 km.
#[worker::send]
pub async fn nearest(State(app): State<Arc<App>>, Extension(ctx): Extension<Arc<Ctx>>) -> Reply {
    web::non_empty(&ctx, POINT_PARAMS)?;
    let lat = web::coordinate(&ctx, "lat", 90.0)?;
    let lon = web::coordinate(&ctx, "lon", 180.0)?;
    let sql = format!(
        "WITH pt AS (SELECT ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326)::geography AS g) SELECT {}, \
         ST_Covers(p.geom, pt.g) AS contains, round((ST_Distance(p.geom, pt.g) / 1000.0)::numeric, 1)::text AS km \
         FROM catalog.place p, pt WHERE ST_DWithin(p.geom, pt.g, 50000) ORDER BY ST_Distance(p.geom, pt.g), p.place_id LIMIT 1",
        sql::place_columns()
    );
    let (res, etag) = app
        .catalogue(&ctx, POINT_PARAMS, vec![Query::with(sql, vec![Some(lon), Some(lat)])])
        .await?;
    if res[0].is_empty() {
        return Err(Problem::missing("No covered place within 50 km of this point.").into());
    }
    let row = res[0].at(0);
    let contains = row.bool("contains");
    let body = c::NearestPlace {
        place: rows::place_summary(&row).map_err(|b| bad_row(&ctx, b))?,
        contains,
        distance_km: if contains { 0.0 } else { row.num("km") },
    };
    Ok(web::json(&body, JSON, Some(etag), None))
}

/// GET /v1/places/{placeId}, with the display-simplified boundary (inside the 64 KB cap).
#[worker::send]
pub async fn detail(State(app): State<Arc<App>>, Extension(ctx): Extension<Arc<Ctx>>) -> Reply {
    let id = place_id(&ctx)?;
    let g = "p.geom_display::geometry";
    let sql = format!(
        "SELECT {}, p.population, p.area_km2, round(ST_XMin({g})::numeric, 4) AS min_lon, \
         round(ST_YMin({g})::numeric, 4) AS min_lat, round(ST_XMax({g})::numeric, 4) AS max_lon, \
         round(ST_YMax({g})::numeric, 4) AS max_lat, ST_AsGeoJSON(ST_Multi({g}), 4) AS geojson \
         FROM catalog.place p WHERE p.place_id = $1",
        sql::place_columns()
    );
    let (res, etag) = app.catalogue(&ctx, &[], vec![Query::with(sql, vec![Some(id)])]).await?;
    if res[0].is_empty() {
        return Err(Problem::missing("No such place.").into());
    }
    let row = res[0].at(0);
    let body = (|| -> R<c::PlaceDetail> {
        let s = rows::place_summary(&row)?;
        Ok(c::PlaceDetail {
            id: s.id.to_string().parse().map_err(|_| rows::Bad("place id".into()))?,
            country: s.country,
            kind: s.kind,
            name: s.name,
            name_ja: s.name_ja,
            admin1: s.admin1,
            admin1_ja: s.admin1_ja,
            admin2: s.admin2,
            centroid: s.centroid,
            population: row.opt_int("population"),
            area_km2: row.num("area_km2"),
            bbox: [
                row.num("min_lon"),
                row.num("min_lat"),
                row.num("max_lon"),
                row.num("max_lat"),
            ],
            geometry: serde_json::from_str(row.str("geojson")).map_err(|_| rows::Bad("geometry".into()))?,
        })
    })()
    .map_err(|b| bad_row(&ctx, b))?;
    Ok(web::json(&body, JSON, Some(etag), None))
}

/// A validated hit query (both hit operations share it).
struct HitRequest {
    radius: i64,
    min_wind: Option<i64>,
    from: Option<i64>,
    to: Option<i64>,
    sort: Sort,
    cursor: Option<Cursor>,
    limit: i64,
}

fn hit_request(ctx: &Ctx) -> Result<HitRequest, Problem> {
    let radius = web::radius(ctx)?;
    let min_wind = web::int(ctx, "minWindKt", 0, 200)?;
    let from = web::int(ctx, "from", 1840, 2100)?;
    let to = web::int(ctx, "to", 1840, 2100)?;
    let cursor = web::cursor_param(ctx)?;
    let limit = web::limit(ctx, 50, 100)?;
    let wire = web::one_of(
        ctx,
        "sort",
        &["closest", "peak-wind-desc", "peak-gust-desc", "date-desc"],
    )?
    .unwrap_or("closest");
    let sort = hit_sort(wire).expect("checked above");
    let cursor = web::decode_cursor(cursor, sort.wire, sort.kind)?;
    Ok(HitRequest {
        radius,
        min_wind,
        from,
        to,
        sort,
        cursor,
        limit,
    })
}

/// Completes a `hits` CTE (columns sid, km, at, wind, gust, hours) into the page query.
fn storm_hits(cte: &str, a: &mut Args, h: &HitRequest) -> String {
    let mut sql = format!(
        "WITH {cte} SELECT {}, h.km::text AS km, {} AS at, h.wind, h.gust, h.hours, {} AS sort_key FROM hits h \
         JOIN catalog.storm s ON s.sid = h.sid LEFT JOIN catalog.pagasa_name pn ON pn.sid = s.sid WHERE true",
        sql::storm_columns(),
        sql::ts("h.at"),
        h.sort.render
    );
    if let Some(w) = h.min_wind {
        let p = a.add(w);
        sql.push_str(&format!(" AND h.wind >= {p}::int"));
    }
    if let Some(cur) = &h.cursor {
        sql::keyset(&mut sql, a, &h.sort, "s.sid", cur);
    }
    let lp = a.add(h.limit + 1);
    sql.push_str(&format!(
        " ORDER BY {} {}, s.sid ASC LIMIT {lp}::int",
        h.sort.key,
        h.sort.dir()
    ));
    sql
}

fn hit_page(app: &App, ctx: &Ctx, rows: &Rows, h: &HitRequest, etag: String) -> Reply {
    let n = rows.len().min(h.limit as usize);
    let items = rows
        .iter()
        .take(n)
        .map(|r| rows::storm_hit(&r))
        .collect::<R<Vec<_>>>()
        .map_err(|b| bad_row(ctx, b))?;
    let next = (rows.len() > n).then(|| {
        let last = rows.at(n - 1);
        web::encode_cursor(h.sort.wire, h.sort.kind, last.str("sort_key"), last.str("s_sid"))
    });
    let link = next.as_deref().map(|c| app.next_link(ctx, c));
    let body = c::StormHitPage {
        items,
        next_cursor: next,
        radius_km: rows::radius(h.radius),
    };
    Ok(web::json(&body, JSON, Some(etag), link))
}

/// GET /v1/places/{placeId}/storms, from the precomputed `catalog.place_storm_exposure` bands.
#[worker::send]
pub async fn storms(State(app): State<Arc<App>>, Extension(ctx): Extension<Arc<Ctx>>) -> Reply {
    let id = place_id(&ctx)?;
    web::non_empty(&ctx, HIT_PARAMS)?;
    let h = hit_request(&ctx)?;
    let r = h.radius;
    let mut a = Args::default();
    let id_p = a.add(&id);
    let radius_p = a.add(r);
    let mut cte = format!(
        "hits AS (SELECT e.sid, e.closest_approach_km AS km, e.closest_approach_at AS at, e.max_wind_kt_r{r} AS wind, \
         e.max_gust_kt_r{r} AS gust, e.hours_r{r} AS hours FROM catalog.place_storm_exposure e \
         WHERE e.place_id = {id_p} AND e.closest_approach_km <= {radius_p}::int"
    );
    for (cond, v) in [("e.season >=", h.from), ("e.season <=", h.to)] {
        if let Some(v) = v {
            let p = a.add(v);
            cte.push_str(&format!(" AND {cond} {p}::int"));
        }
    }
    cte.push(')');
    let main = storm_hits(&cte, &mut a, &h);
    let exists = "SELECT EXISTS (SELECT 1 FROM catalog.place WHERE place_id = $1) AS e";
    let (res, etag) = app
        .catalogue(
            &ctx,
            HIT_PARAMS,
            vec![Query::with(exists, vec![Some(id)]), Query::with(main, a.0)],
        )
        .await?;
    if !res[0].at(0).bool("e") {
        return Err(Problem::missing("No such place.").into());
    }
    hit_page(&app, &ctx, &res[1], &h, etag)
}

/// GET /v1/hits: the same question for an arbitrary point (geodesic distance on geography).
#[worker::send]
pub async fn point(State(app): State<Arc<App>>, Extension(ctx): Extension<Arc<Ctx>>) -> Reply {
    web::non_empty(&ctx, POINT_HIT_PARAMS)?;
    let lat = web::coordinate(&ctx, "lat", 90.0)?;
    let lon = web::coordinate(&ctx, "lon", 180.0)?;
    let h = hit_request(&ctx)?;
    let mut a = Args(vec![Some(lon), Some(lat), Some((h.radius * 1000).to_string())]);
    let mut seasons = String::new();
    for (cond, v) in [("s.season >=", h.from), ("s.season <=", h.to)] {
        if let Some(v) = v {
            let p = a.add(v);
            seasons.push_str(&format!(" AND {cond} {p}::int"));
        }
    }
    let main = storm_hits(&sql::POINT_HITS_CTE.replace("%SEASONS%", &seasons), &mut a, &h);
    // The planner over-estimates the interpolated rows and would JIT-compile the plan (about 1 s of LLVM time for a
    // 60 ms query). SET LOCAL lasts only for this transaction.
    let (res, etag) = app
        .catalogue(
            &ctx,
            POINT_HIT_PARAMS,
            vec![Query::new("SET LOCAL jit = off"), Query::with(main, a.0)],
        )
        .await?;
    hit_page(&app, &ctx, &res[1], &h, etag)
}
