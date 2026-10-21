//! Database rows → the contract's types (typify-generated, `contract` crate). Columns come from
//! `sql::storm_columns` / `sql::place_columns`; optional members stay `None` and are omitted, never `null`. Text from
//! the database is parsed into the contract's enums and patterned strings, so a value outside the contract fails
//! here (500 internal) instead of reaching a client.

use std::str::FromStr;

use chrono::{DateTime, Utc};
use contract as c;

use crate::neon::Row;

/// A value the contract does not allow: the request fails with 500 internal and the log names the column.
#[derive(Debug)]
pub struct Bad(pub String);

pub type R<T> = Result<T, Bad>;

pub fn parse<T: FromStr>(row: &Row, col: &str) -> R<T> {
    let v = row.str(col);
    v.parse()
        .map_err(|_| Bad(format!("column {col}: {v:?} is outside the contract")))
}

pub fn opt_parse<T: FromStr>(row: &Row, col: &str) -> R<Option<T>> {
    row.opt(col)
        .map(|v| {
            v.parse()
                .map_err(|_| Bad(format!("column {col}: {v:?} is outside the contract")))
        })
        .transpose()
}

pub fn time(row: &Row, col: &str) -> R<DateTime<Utc>> {
    let v = row.str(col);
    DateTime::parse_from_rfc3339(v)
        .map(|t| t.with_timezone(&Utc))
        .map_err(|_| Bad(format!("column {col}: bad timestamp")))
}

pub fn opt_time(row: &Row, col: &str) -> R<Option<DateTime<Utc>>> {
    if row.opt(col).is_none() {
        Ok(None)
    } else {
        time(row, col).map(Some)
    }
}

/// `[lon, lat]` (rounded to 4 decimals in SQL), longitude normalised to (-180, 180].
pub fn lon_lat(row: &Row, lon: &str, lat: &str) -> c::LonLat {
    let mut x = row.num(lon);
    if x <= -180.0 {
        x += 360.0;
    } else if x > 180.0 {
        x -= 360.0;
    }
    c::LonLat([(x * 1e4).round() / 1e4, row.num(lat)])
}

pub fn local_names(ph: Option<&str>, ja: Option<&str>) -> Option<c::LocalNames> {
    (ph.is_some() || ja.is_some()).then(|| c::LocalNames {
        ph: ph.map(Into::into),
        ja: ja.map(Into::into),
    })
}

fn countries(json: &str) -> R<Vec<c::CountryCode>> {
    serde_json::from_str(json).map_err(|_| Bad("landfall countries outside the contract".into()))
}

pub fn storm_summary(r: &Row) -> R<c::StormSummary> {
    Ok(c::StormSummary {
        sid: parse(r, "s_sid")?,
        name: r.str("s_name").into(),
        local_names: local_names(r.opt("s_name_ph"), r.opt("s_name_ja")),
        season: r.int("s_season"),
        basin: parse(r, "s_basin")?,
        started_at: time(r, "s_started_at")?,
        ended_at: time(r, "s_ended_at")?,
        peak_wind_kt: r.opt_num("s_peak_wind_kt"),
        peak_wind_agency: opt_parse(r, "s_peak_wind_agency")?,
        min_pressure_hpa: r.opt_num("s_min_pressure_hpa"),
        landfall_countries: countries(r.str("s_landfall_countries"))?,
    })
}

pub fn place_summary(r: &Row) -> R<c::PlaceSummary> {
    Ok(c::PlaceSummary {
        id: parse(r, "p_id")?,
        country: parse(r, "p_country")?,
        kind: parse(r, "p_kind")?,
        name: r.str("p_name").into(),
        name_ja: r.opt("p_name_ja").map(Into::into),
        admin1: r.str("p_admin1").into(),
        admin1_ja: r.opt("p_admin1_ja").map(Into::into),
        admin2: r.opt("p_admin2").map(Into::into),
        centroid: lon_lat(r, "p_lon", "p_lat"),
    })
}

/// The closest-approach numbers of a StormHit / PlaceHit (columns km, at, wind, gust, hours).
pub struct Exposure {
    pub km: f64,
    pub at: DateTime<Utc>,
    pub wind: Option<f64>,
    pub gust: Option<f64>,
    pub hours: f64,
}

pub fn exposure(r: &Row) -> R<Exposure> {
    Ok(Exposure {
        km: r.num("km"),
        at: time(r, "at")?,
        wind: r.opt_num("wind"),
        gust: r.opt_num("gust"),
        hours: r.num("hours"),
    })
}

pub fn storm_hit(r: &Row) -> R<c::StormHit> {
    let e = exposure(r)?;
    Ok(c::StormHit {
        storm: storm_summary(r)?,
        closest_approach_km: e.km,
        closest_approach_at: e.at,
        max_wind_kt_within_radius: e.wind,
        max_gust_kt_within_radius: e.gust,
        hours_within_radius: e.hours,
    })
}

pub fn place_hit(r: &Row) -> R<c::PlaceHit> {
    let e = exposure(r)?;
    Ok(c::PlaceHit {
        place: place_summary(r)?,
        closest_approach_km: e.km,
        closest_approach_at: e.at,
        max_wind_kt_within_radius: e.wind,
        max_gust_kt_within_radius: e.gust,
        hours_within_radius: e.hours,
    })
}

pub fn radius(km: i64) -> c::RadiusKm {
    c::RadiusKm::try_from(km).expect("radius bands come from the contract")
}
