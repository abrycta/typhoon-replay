//! SQL over Neon's serverless HTTP endpoint (`POST https://{host}/sql`) through the Workers fetch API.
//!
//! SQLx (the recorded Rust stack) needs Tokio sockets, which Workers lack, so every request is one HTTPS round trip:
//! a batch that Neon runs in one transaction, read-only unless asked otherwise, starting with
//! `SET LOCAL statement_timeout = 5000` (CONTRACT-GUIDE §11: 5 s, no session state). Values come back as Postgres
//! text (`Neon-Raw-Text-Output`), so numbers keep their exact decimal form. No connection outlives a request, so
//! Neon's compute can scale to zero (docs/architecture/DECISIONS.md, "Neon over HTTP, not Hyperdrive").

use serde::Deserialize;
use serde_json::value::RawValue;
use worker::{Fetch, Headers, Method, Request, RequestInit};

/// One database, reached over HTTP.
#[derive(Clone, Debug)]
pub struct Neon {
    endpoint: String,
    conn: String,
}

/// A statement and its parameters (`$1`, `$2`, ...), passed as text; `None` is SQL NULL. Cast in SQL where the type
/// matters.
#[derive(Debug, Clone)]
pub struct Query {
    pub sql: String,
    pub params: Vec<Option<String>>,
}

impl Query {
    pub fn new(sql: impl Into<String>) -> Self {
        Self {
            sql: sql.into(),
            params: Vec::new(),
        }
    }
    pub fn with(sql: impl Into<String>, params: Vec<Option<String>>) -> Self {
        Self {
            sql: sql.into(),
            params,
        }
    }
}

/// One statement's result: column names and text values.
#[derive(Debug, Deserialize)]
pub struct Rows {
    #[serde(default)]
    fields: Vec<Field>,
    #[serde(default)]
    rows: Vec<Vec<Option<String>>>,
}

#[derive(Debug, Deserialize)]
struct Field {
    name: String,
}

/// One row of a result.
#[derive(Clone, Copy)]
pub struct Row<'a> {
    rows: &'a Rows,
    i: usize,
}

impl Rows {
    pub fn len(&self) -> usize {
        self.rows.len()
    }
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
    pub fn at(&self, i: usize) -> Row<'_> {
        Row { rows: self, i }
    }
    pub fn iter(&self) -> impl Iterator<Item = Row<'_>> {
        (0..self.rows.len()).map(move |i| self.at(i))
    }
    fn col(&self, name: &str) -> usize {
        self.fields
            .iter()
            .position(|f| f.name == name)
            .unwrap_or_else(|| panic!("neon: no column {name}"))
    }
}

impl<'a> Row<'a> {
    /// A nullable column.
    pub fn opt(&self, name: &str) -> Option<&'a str> {
        self.rows.rows[self.i][self.rows.col(name)].as_deref()
    }
    /// A column that is never NULL ("" if it is).
    pub fn str(&self, name: &str) -> &'a str {
        self.opt(name).unwrap_or("")
    }
    pub fn int(&self, name: &str) -> i64 {
        self.str(name).parse().unwrap_or(0)
    }
    pub fn opt_int(&self, name: &str) -> Option<i64> {
        self.opt(name).and_then(|v| v.parse().ok())
    }
    pub fn num(&self, name: &str) -> f64 {
        self.str(name).parse().unwrap_or(0.0)
    }
    pub fn opt_num(&self, name: &str) -> Option<f64> {
        self.opt(name).and_then(|v| v.parse().ok())
    }
    /// A boolean column (Postgres text "t"/"f").
    pub fn bool(&self, name: &str) -> bool {
        self.str(name) == "t"
    }
}

/// A failed batch. `unavailable` (network, a compute still resuming, connection limits) maps to 503 not-ready;
/// anything else is 500 internal, never with SQL in the body.
#[derive(Debug)]
pub struct DbError {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub unavailable: bool,
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "neon: {} {} {}", self.status, self.code, self.message)
    }
}

const TIMEOUT: &str = "SET LOCAL statement_timeout = 5000";

#[derive(Deserialize)]
struct Batch {
    results: Vec<Box<RawValue>>,
}

#[derive(Deserialize, Default)]
struct WireError {
    #[serde(default)]
    message: String,
    #[serde(default)]
    code: String,
}

impl Neon {
    /// From `DATABASE_URL`; `endpoint` overrides the HTTP endpoint (`NEON_HTTP_URL`: Neon's open-source proxy in CI
    /// and local runs). By default it is `https://{host}/sql`.
    pub fn new(database_url: &str, endpoint: Option<&str>) -> Result<Self, String> {
        if database_url.is_empty() {
            return Err("DATABASE_URL is not set".into());
        }
        let endpoint = match endpoint.filter(|e| !e.is_empty()) {
            Some(e) => e.to_string(),
            None => {
                let url = worker::Url::parse(database_url).map_err(|_| "DATABASE_URL is not a postgres URL")?;
                let host = url
                    .host_str()
                    .filter(|h| !h.is_empty())
                    .ok_or("DATABASE_URL has no host")?;
                format!("https://{host}/sql")
            }
        };
        Ok(Self {
            endpoint,
            conn: database_url.to_string(),
        })
    }

    /// The queries in one read-only transaction: one HTTPS round trip, one result per query.
    pub async fn read(&self, queries: Vec<Query>) -> Result<Vec<Rows>, DbError> {
        self.batch(true, queries).await
    }

    /// The queries in one read-write transaction (the test hook only).
    pub async fn write(&self, queries: Vec<Query>) -> Result<Vec<Rows>, DbError> {
        self.batch(false, queries).await
    }

    async fn batch(&self, read_only: bool, queries: Vec<Query>) -> Result<Vec<Rows>, DbError> {
        let n = queries.len();
        let mut wire = Vec::with_capacity(n + 1);
        wire.push(serde_json::json!({ "query": TIMEOUT, "params": [] }));
        for q in queries {
            wire.push(serde_json::json!({ "query": q.sql, "params": q.params }));
        }
        let body = serde_json::json!({ "queries": wire }).to_string();

        let unavailable = |message: String| DbError {
            status: 0,
            code: String::new(),
            message,
            unavailable: true,
        };
        let headers = Headers::new();
        for (k, v) in [
            ("Content-Type", "application/json"),
            ("Neon-Connection-String", self.conn.as_str()),
            ("Neon-Raw-Text-Output", "true"),
            ("Neon-Array-Mode", "true"),
            ("Neon-Batch-Read-Only", if read_only { "true" } else { "false" }),
            ("Neon-Batch-Isolation-Level", "ReadCommitted"),
        ] {
            headers.set(k, v).map_err(|e| unavailable(e.to_string()))?;
        }
        let mut init = RequestInit::new();
        init.with_method(Method::Post)
            .with_headers(headers)
            .with_body(Some(body.into()));
        let req = Request::new_with_init(&self.endpoint, &init).map_err(|e| unavailable(e.to_string()))?;
        let mut res = Fetch::Request(req)
            .send()
            .await
            .map_err(|e| unavailable(e.to_string()))?;
        let status = res.status_code();
        let text = res.text().await.map_err(|e| unavailable(e.to_string()))?;
        if status != 200 {
            let we: WireError = serde_json::from_str(&text).unwrap_or_default();
            let unavailable = status >= 500
                || status == 429
                || we.code.starts_with("08")
                || we.code == "53300"
                || we.code.starts_with("57P0");
            return Err(DbError {
                status,
                code: we.code,
                message: we.message,
                unavailable,
            });
        }
        let bad = |m: &str| DbError {
            status,
            code: String::new(),
            message: m.into(),
            unavailable: false,
        };
        let batch: Batch = serde_json::from_str(&text).map_err(|_| bad("bad response"))?;
        if batch.results.len() != n + 1 {
            return Err(bad("unexpected result count"));
        }
        batch
            .results
            .iter()
            .skip(1)
            .map(|r| serde_json::from_str::<Rows>(r.get()).map_err(|_| bad("bad result")))
            .collect()
    }
}
