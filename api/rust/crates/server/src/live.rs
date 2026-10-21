//! Live storms: the snapshot, the SSE stream (CONTRACT-GUIDE §7) and the test hook that appends events.
//!
//! Live payloads are written by the pipeline through `live.apply_event` (already contract-shaped JSON) and are passed
//! through as stored, like the other backends do: a tolerant reader keeps fields a newer pipeline adds.

use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::Extension;
use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::response::Response;
use futures_util::Stream;
use http::{HeaderValue, Method, header};
use serde::Serialize;
use serde_json::value::RawValue;

use crate::app::{self, App};
use crate::neon::{Query, Rows};
use crate::sql;
use crate::web::{self, Ctx, JSON, Problem};

type Reply = Result<Response, Response>;

fn snapshot_sql() -> String {
    format!(
        "SELECT r.seq, CASE WHEN r.seq > 0 THEN {} ELSE {} END AS as_of, \
         (SELECT coalesce(jsonb_agg(a.storm ORDER BY a.live_id), '[]'::jsonb) FROM live.active_storm a)::text AS storms \
         FROM live.revision r WHERE r.singleton",
        sql::ts("r.updated_at"),
        sql::ts("now()")
    )
}

const REVISION_SQL: &str = "SELECT seq FROM live.revision WHERE singleton";
/// The resume window: oldest retained seq - 1 <= id <= revision.
const IN_WINDOW_SQL: &str = "SELECT $1::bigint BETWEEN coalesce((SELECT min(seq) FROM live.live_event), r.seq + 1) - 1 \
     AND r.seq AS ok FROM live.revision r WHERE r.singleton";
const EVENTS_SQL: &str =
    "SELECT seq, type, payload::text AS payload FROM live.live_event WHERE seq > $1::bigint ORDER BY seq LIMIT 1000";

/// `LiveSnapshot`, with the stored storms passed through.
#[derive(Serialize)]
struct Snapshot<'a> {
    #[serde(rename = "asOf")]
    as_of: &'a str,
    seq: i64,
    storms: &'a RawValue,
}

fn snapshot_json(rows: &Rows) -> Result<(i64, Vec<u8>), Problem> {
    let row = rows.at(0);
    let storms: &RawValue = serde_json::from_str(row.str("storms")).map_err(|_| app::internal())?;
    let seq = row.int("seq");
    let body = serde_json::to_vec(&Snapshot {
        as_of: row.str("as_of"),
        seq,
        storms,
    })
    .map_err(|_| app::internal())?;
    Ok((seq, body))
}

/// GET /v1/live/storms: `no-cache` with ETag `W/"s{seq}"`.
#[worker::send]
pub async fn snapshot(State(app): State<Arc<App>>, Extension(ctx): Extension<Arc<Ctx>>) -> Reply {
    let rows = app
        .read(vec![Query::new(snapshot_sql())])
        .await
        .map_err(|e| Response::from(app::db_fail(&ctx, e)))?;
    let (seq, body) = snapshot_json(&rows[0])?;
    let etag = format!("W/\"s{seq}\"");
    if ctx.etag_matches(&etag) {
        return Ok(web::not_modified(&etag));
    }
    let mut res = Response::new(Body::from(body));
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(JSON));
    res.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&etag).expect("etag is a header value"),
    );
    Ok(res)
}

// --- the stream ------------------------------------------------------------------------------------------------

/// Stream limits on Workers. Each poll is one subrequest (one HTTPS round trip to Neon), and a Worker invocation may
/// make 50: the opening read, at most 44 polls (every 2 s, well inside the 5 s delivery rule) and the rate-limit
/// check stay under it. The stream ends after 90 s and the browser reconnects with Last-Event-ID, resuming where it
/// left off; with no stream open, nothing touches the database.
const POLL_EVERY: Duration = Duration::from_secs(2);
const MAX_POLLS: u32 = 44;
const LIFETIME_MS: f64 = 90_000.0;
const HEARTBEAT_MS: f64 = 15_000.0;
const MAX_STREAMS: usize = 50;

/// Open streams in this isolate (an isolate-wide count, not request state).
static STREAMS: AtomicUsize = AtomicUsize::new(0);

struct StreamSlot;

impl StreamSlot {
    fn acquire() -> Option<Self> {
        STREAMS
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_STREAMS).then_some(n + 1)
            })
            .ok()
            .map(|_| StreamSlot)
    }
}

impl Drop for StreamSlot {
    fn drop(&mut self) {
        STREAMS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Marks a streaming response, so `lib.rs` hands the body to the runtime as a stream instead of collecting it.
#[derive(Clone, Copy)]
pub struct Streaming;

fn event_id(raw: &str, pointer: &str) -> Result<i64, Problem> {
    if raw.is_empty() || raw.len() > 19 || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Problem::invalid(pointer, "must be 1-19 digits"));
    }
    // Beyond any seq: outside the window, so the client gets a snapshot.
    Ok(raw.parse().unwrap_or(i64::MAX))
}

/// Appends the events after `after` as SSE frames; returns the newest seq written.
fn write_events(out: &mut String, rows: &Rows, mut after: i64) -> i64 {
    for e in rows.iter() {
        let seq = e.int("seq");
        if seq <= after {
            continue;
        }
        out.push_str(&format!(
            "id: {seq}\nevent: {}\ndata: {}\n\n",
            e.str("type"),
            e.str("payload")
        ));
        after = seq;
    }
    after
}

/// GET /v1/live/stream (SSE). The Last-Event-ID header wins over `?lastEventId=`.
#[worker::send]
pub async fn stream(State(app): State<Arc<App>>, Extension(ctx): Extension<Arc<Ctx>>) -> Reply {
    web::non_empty(&ctx, &["lastEventId"])?;
    let mut last = match ctx.first("lastEventId") {
        Some(v) => Some(event_id(v, "#/query/lastEventId")?),
        None => None,
    };
    if let Some(h) = &ctx.last_event_id {
        last = Some(event_id(h, "#/header/Last-Event-ID")?);
    }
    let slot = StreamSlot::acquire().ok_or_else(|| {
        Problem::new(
            web::STREAM_CAPACITY,
            "Too many live streams on this instance; retry shortly.",
        )
        .header("Retry-After", "10")
    })?;

    // Snapshot or resume is decided before the stream opens (one round trip), so a failing database gives a problem.
    let mut queries = vec![Query::new(snapshot_sql())];
    if let Some(id) = last {
        let p = vec![Some(id.to_string())];
        queries.push(Query::with(IN_WINDOW_SQL, p.clone()));
        queries.push(Query::with(EVENTS_SQL, p));
    }
    let rows = app
        .read(queries)
        .await
        .map_err(|e| Response::from(app::db_fail(&ctx, e)))?;
    let mut first = String::from("retry: 10000\n");
    let resumed = last.is_some() && !rows[1].is_empty() && rows[1].at(0).bool("ok");
    let sent = if resumed {
        first.push('\n');
        write_events(&mut first, &rows[2], last.unwrap_or_default())
    } else {
        let (seq, body) = snapshot_json(&rows[0])?;
        first.push_str(&format!("id: {seq}\nevent: snapshot\ndata: "));
        first.push_str(std::str::from_utf8(&body).unwrap_or("{}"));
        first.push_str("\n\n");
        seq
    };

    let now = worker::Date::now().as_millis() as f64;
    let state = Poller {
        app,
        sent,
        started: now,
        last_write: now,
        polls: 0,
        first: Some(first),
        _slot: slot,
    };
    let body = Body::from_stream(SendStream(Box::pin(futures_util::stream::unfold(state, Poller::next))));
    let mut res = Response::new(body);
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(web::CACHE_LIVE));
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    res.extensions_mut().insert(Streaming);
    Ok(res)
}

struct Poller {
    app: Arc<App>,
    sent: i64,
    started: f64,
    last_write: f64,
    polls: u32,
    first: Option<String>,
    _slot: StreamSlot,
}

impl Poller {
    async fn next(mut self) -> Option<(Result<Bytes, std::io::Error>, Self)> {
        if let Some(first) = self.first.take() {
            return Some((Ok(Bytes::from(first)), self));
        }
        loop {
            let now = worker::Date::now().as_millis() as f64;
            if self.polls >= MAX_POLLS || now - self.started >= LIFETIME_MS {
                return None;
            }
            worker::Delay::from(POLL_EVERY).await;
            self.polls += 1;
            let mut out = String::new();
            let p = vec![Some(self.sent.to_string())];
            if let Ok(rows) = self
                .app
                .read(vec![Query::new(REVISION_SQL), Query::with(EVENTS_SQL, p)])
                .await
                && !rows[0].is_empty()
                && rows[0].at(0).int("seq") > self.sent
            {
                self.sent = write_events(&mut out, &rows[1], self.sent);
            }
            let now = worker::Date::now().as_millis() as f64;
            if out.is_empty() && now - self.last_write >= HEARTBEAT_MS {
                out.push_str(":\n\n");
            }
            if !out.is_empty() {
                self.last_write = now;
                return Some((Ok(Bytes::from(out)), self));
            }
        }
    }
}

/// Workers run one thread per isolate, so a `!Send` stream (JS timers, fetch) is safe to hand to axum's `Body`.
struct SendStream<S>(Pin<Box<S>>);

// SAFETY: wasm32 on Workers is single-threaded; the stream never crosses a thread.
unsafe impl<S> Send for SendStream<S> {}

impl<S: Stream> Stream for SendStream<S> {
    type Item = S::Item;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<S::Item>> {
        self.0.as_mut().poll_next(cx)
    }
}

// --- test hook ---------------------------------------------------------------------------------------------------

const MAX_BODY: usize = 64 * 1024;

/// POST /v1/_test/live-events `{type, payload}` → 201 `{seq}` through `live.apply_event` (the ingestion job's own
/// write path). Only with TR_TEST_HOOKS=1; otherwise 404 not-found.
#[worker::send]
pub async fn hook(State(app): State<Arc<App>>, Extension(ctx): Extension<Arc<Ctx>>, req: Request) -> Reply {
    if ctx.method == Method::OPTIONS {
        return Ok(crate::options("POST, OPTIONS"));
    }
    if ctx.method != Method::POST {
        let detail = format!("Method {} is not supported here.", ctx.method);
        return Err(Problem::new(web::METHOD_NOT_ALLOWED, detail)
            .header("Allow", "POST, OPTIONS")
            .into());
    }
    let too_large =
        || Problem::new(web::PAYLOAD_TOO_LARGE, "Request bodies are limited to 64 KB.").header("Connection", "close");
    if ctx.content_length.is_some_and(|n| n > MAX_BODY as u64) {
        return Err(too_large().into());
    }
    let body = axum::body::to_bytes(req.into_body(), MAX_BODY)
        .await
        .map_err(|_| Response::from(too_large()))?;
    if !ctx.content_type.to_ascii_lowercase().starts_with("application/json") {
        return Err(Problem::new(web::UNSUPPORTED_MEDIA_TYPE, "Request bodies must be application/json.").into());
    }
    if !app.cfg.test_hooks {
        return Err(Problem::missing("No such resource.").into());
    }
    #[derive(serde::Deserialize)]
    struct In<'a> {
        #[serde(rename = "type")]
        kind: Option<String>,
        #[serde(borrow)]
        payload: Option<&'a RawValue>,
    }
    let input: In = serde_json::from_slice(&body)
        .map_err(|_| Problem::invalid("#/body", "is not valid JSON for this operation"))?;
    let kind = input.kind.filter(|k| k == "storm-upserted" || k == "storm-removed");
    let kind = kind.ok_or_else(|| Problem::invalid("#/body/type", "must be storm-upserted or storm-removed"))?;
    let payload = input.payload.map(RawValue::get).unwrap_or("null");
    let has_live_id = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(payload)
        .ok()
        .is_some_and(|m| m.get("liveId").is_some_and(serde_json::Value::is_string));
    if !has_live_id {
        return Err(Problem::invalid("#/body/payload", "must be an object with liveId").into());
    }
    let q = Query::with(
        "SELECT live.apply_event($1, $2::jsonb) AS seq",
        vec![Some(kind), Some(payload.to_string())],
    );
    let rows = app
        .write(vec![q])
        .await
        .map_err(|e| Response::from(app::db_fail(&ctx, e)))?;
    let seq = rows[0].at(0).int("seq");
    let mut res = Response::new(Body::from(format!("{{\"seq\":{seq}}}")));
    *res.status_mut() = http::StatusCode::CREATED;
    res.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(JSON));
    Ok(res)
}
