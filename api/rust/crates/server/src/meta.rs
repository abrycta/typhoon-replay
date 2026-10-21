//! Probes, `/v1/meta` and the contract bundle.

use std::sync::Arc;

use axum::Extension;
use axum::extract::State;
use axum::response::Response;
use contract as c;

use crate::app::{self, App, CONTRACT_VERSION, IMPL, IMPL_VERSION, MIN_SCHEMA_VERSION};
use crate::neon::Query;
use crate::web::{self, Ctx, JSON, Problem};

const META_SQL: &str = "SELECT (SELECT max(version) FROM public.schema_migrations) AS schema_version, \
     coalesce((SELECT version FROM catalog.current_dataset_version), 0) AS dataset_version";

type Reply = Result<Response, Response>;

/// `W/"c{contractVersion}-{impl}-{implVersion}"` (CONTRACT-GUIDE §6).
fn bundle_etag() -> String {
    format!("W/\"c{CONTRACT_VERSION}-{IMPL}-{IMPL_VERSION}\"")
}

/// GET /healthz: liveness, no database access.
pub async fn health() -> Response {
    web::json(
        &c::Health {
            impl_: c::Impl::Rust,
            status: c::HealthStatus::Ok,
        },
        JSON,
        None,
        None,
    )
}

/// GET /readyz: the database answers and its schema is at least minSchemaVersion.
#[worker::send]
pub async fn readiness(State(app): State<Arc<App>>, Extension(ctx): Extension<Arc<Ctx>>) -> Reply {
    let applied = match app.read(vec![Query::new(META_SQL)]).await {
        Ok(rows) => rows[0].at(0).str("schema_version").to_string(),
        Err(e) => {
            app::log_warn(&ctx, &e.to_string());
            String::new()
        }
    };
    if applied.is_empty() || applied.as_str() < MIN_SCHEMA_VERSION {
        let detail = if applied.is_empty() {
            "Database unreachable or not migrated.".to_string()
        } else {
            format!("Database schema is older than {MIN_SCHEMA_VERSION}.")
        };
        return Err(Problem::new(web::NOT_READY, detail).header("Retry-After", "5").into());
    }
    let body = c::Readiness {
        impl_: c::Impl::Rust,
        status: c::ReadinessStatus::Ready,
        schema_version: applied.parse().map_err(|_| Response::from(app::internal()))?,
        min_schema_version: MIN_SCHEMA_VERSION
            .parse()
            .expect("minSchemaVersion matches the contract"),
    };
    Ok(web::json(&body, JSON, None, None))
}

/// GET /v1/meta. The ETag carries the dataset version, since the body does (contract 2.0.1).
#[worker::send]
pub async fn meta(State(app): State<Arc<App>>, Extension(ctx): Extension<Arc<Ctx>>) -> Reply {
    let rows = app
        .read(vec![Query::new(META_SQL)])
        .await
        .map_err(|e| Response::from(app::db_fail(&ctx, e)))?;
    let row = rows[0].at(0);
    let version = row.int("dataset_version");
    let etag = format!("W/\"c{CONTRACT_VERSION}-{IMPL}-{IMPL_VERSION}-d{version}\"");
    if ctx.etag_matches(&etag) {
        return Ok(web::not_modified(&etag));
    }
    let schema = Some(row.str("schema_version"))
        .filter(|s| !s.is_empty())
        .unwrap_or("00000000000000");
    let body = c::Meta {
        impl_: c::Impl::Rust,
        impl_version: IMPL_VERSION.into(),
        contract_version: CONTRACT_VERSION.parse().expect("contract version matches the contract"),
        schema_version: schema.parse().map_err(|_| Response::from(app::internal()))?,
        dataset_version: version,
        commit: app.cfg.commit.clone(),
        started_at: app.started_at.parse().map_err(|_| Response::from(app::internal()))?,
    };
    Ok(web::json(&body, JSON, Some(etag), None))
}

/// GET /v1/openapi.json: the contract bundle byte for byte.
pub async fn openapi(Extension(ctx): Extension<Arc<Ctx>>) -> Response {
    let etag = bundle_etag();
    if ctx.etag_matches(&etag) {
        return web::not_modified(&etag);
    }
    let mut res = Response::new(axum::body::Body::from(app::OPENAPI));
    let h = res.headers_mut();
    h.insert(http::header::CONTENT_TYPE, http::HeaderValue::from_static(JSON));
    h.insert(
        http::header::ETAG,
        http::HeaderValue::from_str(&etag).expect("etag is a header value"),
    );
    res
}
