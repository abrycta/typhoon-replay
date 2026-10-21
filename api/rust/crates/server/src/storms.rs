//! Storms: the catalogue list, one storm, its best track and the places it passed.

use std::sync::Arc;

use axum::Extension;
use axum::extract::State;
use axum::response::Response;
use contract as c;

use crate::app::{App, bad_row};
use crate::neon::Query;
use crate::rows::{self, R};
use crate::sql::{self, Args, Sort};
use crate::web::{self, Ctx, GEO_JSON, JSON, KeyKind, Problem};

type Reply = Result<Response, Response>;

pub const LIST_PARAMS: &[&str] = &[
    "q",
    "season",
    "from",
    "to",
    "basin",
    "country",
    "minWindKt",
    "sort",
    "cursor",
    "limit",
];
pub const PLACES_PARAMS: &[&str] = &["radiusKm", "country", "cursor", "limit"];

fn storm_sort(wire: &str) -> Option<Sort> {
    Some(match wire {
        "season-desc" => Sort::num("season-desc", "s.season", false),
        "peak-wind-desc" => Sort::num("peak-wind-desc", "coalesce(s.peak_wind_kt, -1)", false),
        "name" => Sort {
            wire: "name",
            key: r#"upper(s.name) COLLATE "C""#,
            ascending: true,
            cast: "::text",
            render: "upper(s.name)".into(),
            kind: KeyKind::String,
        },
        _ => return None,
    })
}

/// The `{sid}` path segment, checked against `^[0-9]{7}[NS][0-9]{5}$`.
pub fn sid(ctx: &Ctx) -> Result<String, Problem> {
    let s = ctx.path.split('/').nth(3).unwrap_or("");
    if web::sid_shape(s) {
        Ok(s.to_string())
    } else {
        Err(Problem::invalid("#/path/sid", "must match ^[0-9]{7}[NS][0-9]{5}$"))
    }
}

const EXISTS: &str = "SELECT EXISTS (SELECT 1 FROM catalog.storm WHERE sid = $1) AS e";

/// GET /v1/storms.
#[worker::send]
pub async fn list(State(app): State<Arc<App>>, Extension(ctx): Extension<Arc<Ctx>>) -> Reply {
    web::non_empty(&ctx, LIST_PARAMS)?;
    let q = web::string(&ctx, "q", 2, 64)?;
    let season = web::int(&ctx, "season", 1840, 2100)?;
    let from = web::int(&ctx, "from", 1840, 2100)?;
    let to = web::int(&ctx, "to", 1840, 2100)?;
    let min_wind = web::int(&ctx, "minWindKt", 0, 200)?;
    let cursor = web::cursor_param(&ctx)?;
    let basin = web::one_of(&ctx, "basin", &["WP", "EP", "NA", "NI", "SI", "SP", "SA"])?;
    let country = web::country(&ctx)?;
    let limit = web::limit(&ctx, 50, 100)?;
    if season.is_some() && (from.is_some() || to.is_some()) {
        let mut p = Problem::new(web::VALIDATION, "season cannot be combined with from/to.");
        p.errors
            .push(("#/query/season".into(), "cannot be combined with from/to".into()));
        return Err(p.into());
    }
    let sort = web::one_of(&ctx, "sort", &["season-desc", "peak-wind-desc", "name"])?.unwrap_or("season-desc");
    let sort = storm_sort(sort).expect("checked above");
    let cur = web::decode_cursor(cursor, sort.wire, sort.kind)?;

    let mut a = Args::default();
    let mut sql = format!(
        "SELECT {}, {} AS sort_key FROM {} WHERE true",
        sql::storm_columns(),
        sort.render,
        sql::STORM_FROM
    );
    if let Some(q) = q {
        let p = a.add(sql::like_escape(q));
        sql.push_str(&format!(r" AND s.search_text LIKE '%' || lower({p}) || '%' ESCAPE '\'"));
    }
    for (cond, v) in [
        ("s.season =", season),
        ("s.season >=", from),
        ("s.season <=", to),
        ("s.peak_wind_kt >=", min_wind),
    ] {
        if let Some(v) = v {
            let p = a.add(v);
            sql.push_str(&format!(" AND {cond} {p}::int"));
        }
    }
    if let Some(b) = basin {
        let p = a.add(b);
        sql.push_str(&format!(" AND s.basin = {p}"));
    }
    if let Some(cc) = country {
        let p = a.add(cc);
        sql.push_str(&format!(" AND s.landfall_countries @> ARRAY[{p}::text]"));
    }
    if let Some(cur) = &cur {
        sql::keyset(&mut sql, &mut a, &sort, "s.sid", cur);
    }
    let lp = a.add(limit + 1);
    sql.push_str(&format!(
        " ORDER BY {} {}, s.sid ASC LIMIT {lp}::int",
        sort.key,
        sort.dir()
    ));

    let (res, etag) = app.catalogue(&ctx, LIST_PARAMS, vec![Query::with(sql, a.0)]).await?;
    let rows = &res[0];
    let n = rows.len().min(limit as usize);
    let items = rows
        .iter()
        .take(n)
        .map(|r| rows::storm_summary(&r))
        .collect::<R<Vec<_>>>()
        .map_err(|b| bad_row(&ctx, b))?;
    let next = (rows.len() > n).then(|| {
        let last = rows.at(n - 1);
        web::encode_cursor(sort.wire, sort.kind, last.str("sort_key"), last.str("s_sid"))
    });
    let link = next.as_deref().map(|c| app.next_link(&ctx, c));
    Ok(web::json(
        &c::StormPage {
            items,
            next_cursor: next,
        },
        JSON,
        Some(etag),
        link,
    ))
}

/// GET /v1/storms/{sid}.
#[worker::send]
pub async fn detail(State(app): State<Arc<App>>, Extension(ctx): Extension<Arc<Ctx>>) -> Reply {
    let sid = sid(&ctx)?;
    let detail = format!(
        "SELECT s.sid, s.name, s.season, s.basin, s.number, s.atcf_id, {} AS started_at, {} AS ended_at, \
         extract(epoch FROM s.ended_at - s.started_at) / 3600.0 AS duration_hours, s.fix_count, \
         coalesce(array_to_json(s.landfall_countries)::text, '[]') AS landfall_countries, s.replay_available, \
         s.name_ja, pn.pagasa_name, pn.source_url AS pagasa_url, s.peak_wind_kt, s.peak_wind_agency, s.min_pressure_hpa, \
         {} AS peak_at, {} AS peak_lon, {} AS peak_lat, s.jtwc_max_wind_kt, s.jtwc_min_pressure_hpa, s.jma_max_wind_kt, \
         s.jma_min_pressure_hpa, s.wmo_max_wind_kt, s.wmo_min_pressure_hpa, \
         (SELECT ibtracs_version FROM catalog.dataset_version ORDER BY version DESC LIMIT 1) AS ibtracs_version \
         FROM catalog.storm s LEFT JOIN catalog.pagasa_name pn ON pn.sid = s.sid WHERE s.sid = $1",
        sql::ts("s.started_at"),
        sql::ts("s.ended_at"),
        sql::ts("s.peak_at"),
        sql::lon("s.peak_position"),
        sql::lat("s.peak_position"),
    );
    let landfalls = format!(
        "SELECT country, {} AS at, place_id, {} AS lon, {} AS lat FROM catalog.storm_landfall WHERE sid = $1 ORDER BY seq",
        sql::ts("at"),
        sql::lon("position"),
        sql::lat("position"),
    );
    let p = vec![Some(sid.clone())];
    let (res, etag) = app
        .catalogue(
            &ctx,
            &[],
            vec![Query::with(detail, p.clone()), Query::with(landfalls, p)],
        )
        .await?;
    if res[0].is_empty() {
        return Err(Problem::missing("No such storm.").into());
    }
    let body = storm_detail(&res[0], &res[1]).map_err(|b| bad_row(&ctx, b))?;
    Ok(web::json(&body, JSON, Some(etag), None))
}

fn storm_detail(d: &crate::neon::Rows, landfalls: &crate::neon::Rows) -> R<c::StormDetail> {
    let d = d.at(0);
    // Lifetime extremes per agency. In the WP basin "wmo" is JMA, so it is listed only when JMA itself is absent.
    let mut intensity = Vec::new();
    let agency = |name: &str, minutes: i64, wind: &str, pressure: &str| {
        let (w, p) = (d.opt_num(wind), d.opt_num(pressure));
        (w.is_some() || p.is_some()).then(|| c::AgencyIntensity {
            agency: name.parse().expect("agency from the contract"),
            wind_averaging_minutes: minutes.try_into().expect("1 or 10 minutes"),
            max_wind_kt: w,
            min_pressure_hpa: p,
        })
    };
    intensity.extend(agency("jtwc", 1, "jtwc_max_wind_kt", "jtwc_min_pressure_hpa"));
    match agency("jma", 10, "jma_max_wind_kt", "jma_min_pressure_hpa") {
        Some(jma) => intensity.push(jma),
        None => intensity.extend(agency("wmo", 10, "wmo_max_wind_kt", "wmo_min_pressure_hpa")),
    }
    let landfalls = landfalls
        .iter()
        .map(|l| {
            Ok(c::Landfall {
                country: rows::parse(&l, "country")?,
                at: rows::time(&l, "at")?,
                position: rows::lon_lat(&l, "lon", "lat"),
                place_id: rows::opt_parse(&l, "place_id")?,
            })
        })
        .collect::<R<Vec<_>>>()?;
    let version = d.opt("ibtracs_version").unwrap_or("v04r01");
    let mut sources = vec![c::DataSource {
        id: format!("ibtracs-{}", slug(version))
            .parse()
            .map_err(|_| rows::Bad("source id".into()))?,
        name: format!("IBTrACS {version} (NOAA NCEI)"),
        url: "https://www.ncei.noaa.gov/products/international-best-track-archive".into(),
        license: Some("Public domain (NOAA)".into()),
    }];
    if let (Some(_), Some(url)) = (d.opt("pagasa_name"), d.opt("pagasa_url")) {
        sources.push(c::DataSource {
            id: "pagasa-names".parse().expect("source id"),
            name: "PAGASA local name crosswalk".into(),
            url: url.into(),
            license: None,
        });
    }
    Ok(c::StormDetail {
        sid: rows::parse(&d, "sid")?,
        name: d.str("name").into(),
        local_names: rows::local_names(d.opt("pagasa_name"), d.opt("name_ja")),
        season: d.int("season"),
        basin: rows::parse(&d, "basin")?,
        number: d.opt_int("number"),
        atcf_id: d.opt("atcf_id").map(Into::into),
        started_at: rows::time(&d, "started_at")?,
        ended_at: rows::time(&d, "ended_at")?,
        duration_hours: d.num("duration_hours"),
        fix_count: d.int("fix_count"),
        landfall_countries: serde_json::from_str(d.str("landfall_countries"))
            .map_err(|_| rows::Bad("countries".into()))?,
        peak: c::StormPeak {
            wind_kt: d.opt_num("peak_wind_kt"),
            agency: rows::opt_parse(&d, "peak_wind_agency")?,
            pressure_hpa: d.opt_num("min_pressure_hpa"),
            at: rows::opt_time(&d, "peak_at")?,
            position: d.opt("peak_lon").map(|_| rows::lon_lat(&d, "peak_lon", "peak_lat")),
        },
        intensity,
        landfalls,
        sources,
        replay_available: d.bool("replay_available"),
    })
}

/// Lowercase, every run of characters outside `[a-z0-9]` replaced with one "-".
fn slug(s: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in s.to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            out.push(ch);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    out
}

/// GET /v1/storms/{sid}/track: best-track fixes as a GeoJSON FeatureCollection.
#[worker::send]
pub async fn track(State(app): State<Arc<App>>, Extension(ctx): Extension<Arc<Ctx>>) -> Reply {
    let sid = sid(&ctx)?;
    let track = format!(
        "SELECT {} AS at, wind_kt, wind_agency, gust_kt, pressure_hpa, nature, sshs_category, jma_grade, \
         dist_to_land_km, speed_kt, direction_deg, {} AS lon, {} AS lat FROM catalog.storm_fix WHERE sid = $1 \
         ORDER BY observed_at",
        sql::ts("observed_at"),
        sql::lon("position"),
        sql::lat("position"),
    );
    let p = vec![Some(sid.clone())];
    let (res, etag) = app
        .catalogue(&ctx, &[], vec![Query::with(EXISTS, p.clone()), Query::with(track, p)])
        .await?;
    if !res[0].at(0).bool("e") {
        return Err(Problem::missing("No such storm.").into());
    }
    let features = res[1]
        .iter()
        .map(|f| {
            Ok(c::TrackFeature {
                type_: c::TrackFeatureType::Feature,
                geometry: c::PointGeometry {
                    type_: c::PointGeometryType::Point,
                    coordinates: rows::lon_lat(&f, "lon", "lat"),
                },
                properties: c::TrackPointProperties {
                    at: rows::time(&f, "at")?,
                    wind_kt: f.opt_num("wind_kt"),
                    wind_agency: rows::opt_parse(&f, "wind_agency")?,
                    gust_kt: f.opt_num("gust_kt"),
                    pressure_hpa: f.opt_num("pressure_hpa"),
                    nature: rows::opt_parse(&f, "nature")?,
                    sshs_category: f.opt_int("sshs_category"),
                    jma_grade: f.opt_int("jma_grade"),
                    distance_to_land_km: f.opt_num("dist_to_land_km"),
                    speed_kt: f.opt_num("speed_kt"),
                    direction_deg: f.opt_num("direction_deg"),
                },
            })
        })
        .collect::<R<Vec<_>>>()
        .map_err(|b| bad_row(&ctx, b))?;
    let body = c::StormTrack {
        type_: c::StormTrackType::FeatureCollection,
        sid: sid.parse().map_err(|_| Response::from(crate::app::internal()))?,
        resolution: c::StormTrackResolution::BestTrack,
        features,
    };
    Ok(web::json(&body, GEO_JSON, Some(etag), None))
}

/// GET /v1/storms/{sid}/places: places within radiusKm of the track, closest first.
#[worker::send]
pub async fn places(State(app): State<Arc<App>>, Extension(ctx): Extension<Arc<Ctx>>) -> Reply {
    let sid = sid(&ctx)?;
    web::non_empty(&ctx, PLACES_PARAMS)?;
    let radius = web::radius(&ctx)?;
    let cursor = web::cursor_param(&ctx)?;
    let country = web::country(&ctx)?;
    let limit = web::limit(&ctx, 50, 100)?;
    let sort = Sort::num("closest", "e.closest_approach_km", true);
    let cur = web::decode_cursor(cursor, sort.wire, sort.kind)?;

    let mut a = Args::default();
    let sid_p = a.add(&sid);
    let radius_p = a.add(radius);
    let mut sql = format!(
        "SELECT {}, e.closest_approach_km::text AS km, {} AS at, e.max_wind_kt_r{radius} AS wind, \
         e.max_gust_kt_r{radius} AS gust, e.hours_r{radius} AS hours \
         FROM catalog.place_storm_exposure e JOIN catalog.place p ON p.place_id = e.place_id \
         WHERE e.sid = {sid_p} AND e.closest_approach_km <= {radius_p}::int",
        sql::place_columns(),
        sql::ts("e.closest_approach_at"),
    );
    if let Some(cc) = country {
        let p = a.add(cc);
        sql.push_str(&format!(" AND p.country = {p}"));
    }
    if let Some(cur) = &cur {
        sql::keyset(&mut sql, &mut a, &sort, "e.place_id", cur);
    }
    let lp = a.add(limit + 1);
    sql.push_str(&format!(
        " ORDER BY e.closest_approach_km ASC, e.place_id ASC LIMIT {lp}::int"
    ));
    let (res, etag) = app
        .catalogue(
            &ctx,
            PLACES_PARAMS,
            vec![Query::with(EXISTS, vec![Some(sid)]), Query::with(sql, a.0)],
        )
        .await?;
    if !res[0].at(0).bool("e") {
        return Err(Problem::missing("No such storm.").into());
    }
    let rows = &res[1];
    let n = rows.len().min(limit as usize);
    let items = rows
        .iter()
        .take(n)
        .map(|r| rows::place_hit(&r))
        .collect::<R<Vec<_>>>()
        .map_err(|b| bad_row(&ctx, b))?;
    let next = (rows.len() > n).then(|| {
        let last = rows.at(n - 1);
        web::encode_cursor(sort.wire, sort.kind, last.str("km"), last.str("p_id"))
    });
    let link = next.as_deref().map(|c| app.next_link(&ctx, c));
    let body = c::PlaceHitPage {
        items,
        next_cursor: next,
        radius_km: rows::radius(radius),
    };
    Ok(web::json(&body, JSON, Some(etag), link))
}
