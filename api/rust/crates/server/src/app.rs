//! Per-request application state and the read path every catalogue operation shares.

use axum::response::Response;

use crate::neon::{DbError, Neon, Query, Rows};
use crate::rows::Bad;
use crate::web::{self, Ctx, Problem};

pub const IMPL: &str = "rust";
pub const IMPL_VERSION: &str = env!("CARGO_PKG_VERSION");
/// The contract this build implements (`impl.json` `claimedContract`).
pub const CONTRACT_VERSION: &str = "2.0.2";
/// The oldest database schema this build runs against (`impl.json` `minSchemaVersion`).
pub const MIN_SCHEMA_VERSION: &str = "20261021000500";
/// The contract bundle, served byte for byte at `/v1/openapi.json`.
pub const OPENAPI: &[u8] = include_bytes!("../../../../../contracts/dist/openapi.json");

/// Configuration, from the Worker's vars and secrets (the names every backend shares, CONTRACT-GUIDE §11).
#[derive(Debug, Clone)]
pub struct Config {
    pub site_origin: String,
    pub test_hooks: bool,
    pub commit: String,
    pub edge_secret: String,
    pub rate_limit: bool,
}

/// Built per request from the Worker's `Env` (no request-scoped globals).
#[derive(Debug, Clone)]
pub struct App {
    pub cfg: Config,
    db: Result<Neon, String>,
    pub started_at: String,
}

impl App {
    pub fn new(cfg: Config, db: Result<Neon, String>, started_at: String) -> Self {
        Self { cfg, db, started_at }
    }

    /// One read-only transaction (one HTTPS round trip to Neon).
    pub async fn read(&self, queries: Vec<Query>) -> Result<Vec<Rows>, DbError> {
        match &self.db {
            Ok(db) => db.read(queries).await,
            Err(e) => Err(DbError {
                status: 0,
                code: String::new(),
                message: e.clone(),
                unavailable: true,
            }),
        }
    }

    pub async fn write(&self, queries: Vec<Query>) -> Result<Vec<Rows>, DbError> {
        match &self.db {
            Ok(db) => db.write(queries).await,
            Err(e) => Err(DbError {
                status: 0,
                code: String::new(),
                message: e.clone(),
                unavailable: true,
            }),
        }
    }

    /// A catalogue read in one round trip: the dataset version and the operation's queries run in one transaction;
    /// the dataset ETag comes from it, and a matching If-None-Match gets a 304 without a body.
    pub async fn catalogue(
        &self,
        ctx: &Ctx,
        recognised: &[&str],
        queries: Vec<Query>,
    ) -> Result<(Vec<Rows>, String), Response> {
        let mut all = Vec::with_capacity(queries.len() + 1);
        all.push(Query::new(crate::sql::DATASET_VERSION));
        all.extend(queries);
        let mut res = self.read(all).await.map_err(|e| Response::from(db_fail(ctx, e)))?;
        let version = res[0].at(0).int("v");
        let etag = web::catalogue_etag(version, ctx, recognised);
        if ctx.etag_matches(&etag) {
            return Err(web::not_modified(&etag));
        }
        res.remove(0);
        Ok((res, etag))
    }

    /// `<{site origin}{X-Forwarded-Prefix}{path}?{query without cursor}&cursor=...>; rel="next"` (§5).
    pub fn next_link(&self, ctx: &Ctx, cursor: &str) -> String {
        let mut q: Vec<&str> = ctx
            .raw_query
            .split('&')
            .filter(|p| !p.is_empty() && *p != "cursor" && !p.starts_with("cursor="))
            .collect();
        let tail = format!("cursor={cursor}");
        q.push(&tail);
        format!(
            "<{}{}{}?{}>; rel=\"next\"",
            self.cfg.site_origin,
            ctx.forwarded_prefix,
            ctx.path,
            q.join("&")
        )
    }
}

/// A database failure: unreachable is 503 not-ready with Retry-After (Neon resuming from scale to zero); anything
/// else is 500 internal, never with SQL in the body.
pub fn db_fail(ctx: &Ctx, err: DbError) -> Problem {
    log_warn(ctx, &err.to_string());
    if err.unavailable {
        Problem::new(web::NOT_READY, "The database is waking up; retry shortly.").header("Retry-After", "10")
    } else {
        internal()
    }
}

/// A row the contract does not allow.
pub fn bad_row(ctx: &Ctx, bad: Bad) -> Problem {
    log_warn(ctx, &bad.0);
    internal()
}

pub fn internal() -> Problem {
    Problem::new(web::INTERNAL, "Unexpected error; see requestId in the logs.")
}

impl From<Problem> for Response {
    fn from(p: Problem) -> Self {
        axum::response::IntoResponse::into_response(p)
    }
}

pub fn log_warn(ctx: &Ctx, msg: &str) {
    let line = serde_json::json!({
        "ts": now_rfc3339(), "level": "warn", "msg": msg, "requestId": ctx.request_id, "impl": IMPL, "path": ctx.path,
    });
    worker::console_log!("{line}");
}

pub fn now_rfc3339() -> String {
    let ms = worker::Date::now().as_millis() as i64;
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
