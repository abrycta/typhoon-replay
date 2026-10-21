//! The contract's HTTP rules every operation shares (CONTRACT-GUIDE §4–§8): the request context, problem documents,
//! replies, lenient query parsing, data-derived ETags, interchangeable cursors and parameter checks.

use std::collections::HashMap;

use axum::body::Body;
use axum::response::{IntoResponse, Response};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// One request in flight. Built once in `lib.rs` from the incoming request and handed to handlers as an extension;
/// nothing request-scoped lives in a global.
#[derive(Debug, Clone)]
pub struct Ctx {
    pub method: Method,
    /// The path as served under the backend root, escaped form (e.g. `/v1/storms`).
    pub path: String,
    /// The query string as received.
    pub raw_query: String,
    /// Every value of every well-formed query parameter, in arrival order.
    pub query: HashMap<String, Vec<String>>,
    pub request_id: String,
    /// All `If-None-Match` headers joined with "," (a client or proxy may split the list over several headers).
    pub if_none_match: String,
    pub forwarded_prefix: String,
    pub last_event_id: Option<String>,
    pub content_type: String,
    pub accept_encoding: String,
    pub content_length: Option<u64>,
}

impl Ctx {
    pub fn new(method: Method, uri: &http::Uri, headers: &HeaderMap) -> Self {
        let get = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string()
        };
        let raw_query = uri.query().unwrap_or("").to_string();
        Ctx {
            method,
            path: uri.path().to_string(),
            query: parse_query(&raw_query),
            raw_query,
            request_id: resolve_request_id(&get("x-request-id")),
            if_none_match: headers
                .get_all(header::IF_NONE_MATCH)
                .iter()
                .filter_map(|v| v.to_str().ok())
                .collect::<Vec<_>>()
                .join(","),
            forwarded_prefix: forwarded_prefix(&get("x-forwarded-prefix")),
            last_event_id: headers
                .get("last-event-id")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string),
            content_type: get("content-type"),
            accept_encoding: get("accept-encoding"),
            content_length: headers
                .get(header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse().ok()),
        }
    }

    /// The first value of a query parameter, if sent.
    pub fn first(&self, name: &str) -> Option<&str> {
        self.query.get(name).and_then(|v| v.first()).map(String::as_str)
    }

    /// The problem `instance`: path and query as received.
    pub fn instance(&self) -> String {
        if self.raw_query.is_empty() {
            self.path.clone()
        } else {
            format!("{}?{}", self.path, self.raw_query)
        }
    }

    /// Weak comparison of `If-None-Match` (or `*`) against our tag.
    pub fn etag_matches(&self, etag: &str) -> bool {
        etag_matches(&self.if_none_match, etag)
    }
}

// --- problems (RFC 9457, CONTRACT-GUIDE §8) ---------------------------------------------------------------------

/// A stable problem code with its fixed status and title.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Kind {
    pub status: u16,
    pub code: &'static str,
    pub title: &'static str,
}

pub const VALIDATION: Kind = Kind {
    status: 400,
    code: "validation",
    title: "Request validation failed",
};
pub const INVALID_CURSOR: Kind = Kind {
    status: 400,
    code: "invalid-cursor",
    title: "Invalid cursor",
};
pub const NOT_FOUND: Kind = Kind {
    status: 404,
    code: "not-found",
    title: "Not found",
};
pub const METHOD_NOT_ALLOWED: Kind = Kind {
    status: 405,
    code: "method-not-allowed",
    title: "Method not allowed",
};
pub const PAYLOAD_TOO_LARGE: Kind = Kind {
    status: 413,
    code: "payload-too-large",
    title: "Payload too large",
};
pub const UNSUPPORTED_MEDIA_TYPE: Kind = Kind {
    status: 415,
    code: "unsupported-media-type",
    title: "Unsupported media type",
};
pub const RATE_LIMITED: Kind = Kind {
    status: 429,
    code: "rate-limited",
    title: "Too many requests",
};
pub const INTERNAL: Kind = Kind {
    status: 500,
    code: "internal",
    title: "Internal server error",
};
pub const NOT_READY: Kind = Kind {
    status: 503,
    code: "not-ready",
    title: "Service not ready",
};
pub const STREAM_CAPACITY: Kind = Kind {
    status: 503,
    code: "stream-capacity",
    title: "Too many live streams",
};

/// The problem `type` base (contract 2.0.2).
pub const TYPE_BASE: &str = "https://replay.krtmtthw.dev/problems/";

/// Any failure that reaches the client as a problem document. Rendered in `lib.rs` (`finish`), which knows the
/// request's `instance` and `requestId`.
#[derive(Debug, Clone)]
pub struct Problem {
    pub kind: Kind,
    pub detail: String,
    pub errors: Vec<(String, String)>,
    pub headers: Vec<(&'static str, String)>,
}

impl Problem {
    pub fn new(kind: Kind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
            errors: Vec::new(),
            headers: Vec::new(),
        }
    }
    pub fn header(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }
    /// 400 validation for one input.
    pub fn invalid(pointer: &str, detail: &str) -> Self {
        let mut p = Self::new(VALIDATION, format!("{} {detail}", pointer.trim_start_matches("#/")));
        p.errors.push((pointer.to_string(), detail.to_string()));
        p
    }
    /// 400 invalid-cursor.
    pub fn bad_cursor(detail: &str) -> Self {
        let mut p = Self::new(INVALID_CURSOR, detail);
        p.errors.push(("#/query/cursor".into(), detail.into()));
        p
    }
    pub fn missing(detail: &str) -> Self {
        Self::new(NOT_FOUND, detail)
    }

    /// The document, as the contract's `Problem` schema.
    pub fn document(&self, instance: String, request_id: &str) -> Vec<u8> {
        let doc = contract::Problem {
            type_: format!("{TYPE_BASE}{}", self.kind.code),
            title: self.kind.title.to_string(),
            status: self.kind.status as i64,
            detail: Some(self.detail.clone()).filter(|d| !d.trim().is_empty()),
            instance: Some(instance),
            code: self.kind.code.parse().expect("problem codes come from the contract"),
            request_id: request_id
                .parse()
                .unwrap_or_else(|_| uuid_v7().parse().expect("UUIDv7 is a request id")),
            errors: self
                .errors
                .iter()
                .take(50)
                .map(|(pointer, detail)| contract::ProblemFieldError {
                    pointer: pointer.clone(),
                    detail: detail.clone(),
                })
                .collect(),
        };
        serde_json::to_vec(&doc).expect("problem serialises")
    }
}

impl IntoResponse for Problem {
    fn into_response(self) -> Response {
        let mut res = Response::new(Body::empty());
        *res.status_mut() = StatusCode::from_u16(self.kind.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        res.extensions_mut().insert(self);
        res
    }
}

pub type Result<T, E = Problem> = std::result::Result<T, E>;

// --- replies -------------------------------------------------------------------------------------------------

pub const JSON: &str = "application/json; charset=utf-8";
pub const GEO_JSON: &str = "application/geo+json";

/// A successful JSON response: serialised from a contract type, with its ETag and, for pages, the next-page Link.
pub fn json<T: Serialize>(
    body: &T,
    content_type: &'static str,
    etag: Option<String>,
    link: Option<String>,
) -> Response {
    let bytes = serde_json::to_vec(body).expect("contract types serialise");
    let mut res = Response::new(Body::from(bytes));
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    if let Some(e) = etag.and_then(|e| HeaderValue::from_str(&e).ok()) {
        h.insert(header::ETAG, e);
    }
    if let Some(l) = link.and_then(|l| HeaderValue::from_str(&l).ok()) {
        h.insert(header::LINK, l);
    }
    res
}

/// 304 for a matching If-None-Match: same ETag (Cache-Control is added in `finish`), no body.
pub fn not_modified(etag: &str) -> Response {
    let mut res = Response::new(Body::empty());
    *res.status_mut() = StatusCode::NOT_MODIFIED;
    if let Ok(e) = HeaderValue::from_str(etag) {
        res.headers_mut().insert(header::ETAG, e);
    }
    res
}

// --- caching (CONTRACT-GUIDE §6) -----------------------------------------------------------------------------

pub const CACHE_CATALOGUE: &str = "public, max-age=300, stale-while-revalidate=86400";
pub const CACHE_META: &str = "public, max-age=60";
pub const CACHE_LIVE: &str = "no-cache";
pub const CACHE_NO_STORE: &str = "no-store";

/// Storms, places, hits and place search.
pub fn is_catalogue(path: &str) -> bool {
    path == "/v1/storms" || path.starts_with("/v1/storms/") || path.starts_with("/v1/places/") || path == "/v1/hits"
}

/// Cache-Control by resource class: errors are `no-store`, except a 404 on a catalogue read.
pub fn cache_control(status: u16, method: &Method, path: &str) -> &'static str {
    if status >= 400 {
        return if status == 404 && (method == Method::GET || method == Method::HEAD) && is_catalogue(path) {
            CACHE_META
        } else {
            CACHE_NO_STORE
        };
    }
    match path {
        "/healthz" | "/readyz" => CACHE_NO_STORE,
        "/v1/meta" | "/v1/openapi.json" => CACHE_META,
        p if p.starts_with("/v1/live/") => CACHE_LIVE,
        p if is_catalogue(p) => CACHE_CATALOGUE,
        _ => CACHE_NO_STORE,
    }
}

/// `W/"d{datasetVersion}-{resourceKey}"`: derived from the request and the dataset, never from response bytes, so
/// every backend emits the same tag for the same resource.
pub fn catalogue_etag(dataset_version: i64, ctx: &Ctx, recognised: &[&str]) -> String {
    format!(
        "W/\"d{dataset_version}-{}\"",
        resource_key(&canonical_request(&ctx.path, &ctx.query, recognised))
    )
}

/// The path, then `?` and the recognised parameters that were sent, sorted by name then value, RFC 3986
/// percent-encoded, joined by `&`. Unknown parameters are dropped; defaults are not filled in.
pub fn canonical_request(path: &str, query: &HashMap<String, Vec<String>>, recognised: &[&str]) -> String {
    let mut pairs: Vec<(&str, &str)> = recognised
        .iter()
        .flat_map(|name| query.get(*name).into_iter().flatten().map(move |v| (*name, v.as_str())))
        .collect();
    if pairs.is_empty() {
        return path.to_string();
    }
    // Values compare as UTF-16 code units, like the Java reference's String.compareTo.
    pairs.sort_by(|a, b| a.0.cmp(b.0).then_with(|| a.1.encode_utf16().cmp(b.1.encode_utf16())));
    let joined: Vec<String> = pairs
        .iter()
        .map(|(k, v)| format!("{}={}", percent_encode(k), percent_encode(v)))
        .collect();
    format!("{path}?{}", joined.join("&"))
}

/// The first 16 hex digits of SHA-256 over the canonical request string.
pub fn resource_key(canonical: &str) -> String {
    let digest = Sha256::digest(canonical.as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// RFC 3986: unreserved characters literal, every other UTF-8 byte as `%XX` (uppercase).
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn etag_matches(if_none_match: &str, etag: &str) -> bool {
    let ours = etag.strip_prefix("W/").unwrap_or(etag);
    if_none_match
        .split(',')
        .map(str::trim)
        .any(|c| c == "*" || (!c.is_empty() && c.strip_prefix("W/").unwrap_or(c) == ours))
}

// --- request ids, prefixes, query parsing ------------------------------------------------------------------------

/// Echo the inbound X-Request-Id when it is 1–64 chars of `[A-Za-z0-9._-]`, else a new UUIDv7.
pub fn resolve_request_id(inbound: &str) -> String {
    let ok = (1..=64).contains(&inbound.len())
        && inbound
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'));
    if ok { inbound.to_string() } else { uuid_v7() }
}

/// A time-ordered random UUID (RFC 9562).
pub fn uuid_v7() -> String {
    let mut b = [0u8; 16];
    getrandom(&mut b[6..]);
    let ms = worker::Date::now().as_millis();
    b[..6].copy_from_slice(&ms.to_be_bytes()[2..]);
    b[6] = 0x70 | (b[6] & 0x0F);
    b[8] = 0x80 | (b[8] & 0x3F);
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

fn getrandom(buf: &mut [u8]) {
    // crypto.getRandomValues through the Workers runtime.
    use worker::js_sys::{Function, Reflect, Uint8Array, global};
    let arr = Uint8Array::new_with_length(buf.len() as u32);
    let crypto = Reflect::get(&global(), &"crypto".into()).ok();
    let f = crypto
        .as_ref()
        .and_then(|c| Reflect::get(c, &"getRandomValues".into()).ok());
    if let (Some(c), Some(f)) = (crypto, f.and_then(|f| f.dyn_into::<Function>().ok()))
        && f.call1(&c, &arr).is_ok()
    {
        arr.copy_to(buf);
    }
}

use worker::wasm_bindgen::JsCast as _;

/// `X-Forwarded-Prefix` (e.g. `/api/rust`) when well formed: 1–4 segments of `[A-Za-z0-9._-]`.
pub fn forwarded_prefix(v: &str) -> String {
    let v = v.trim_end_matches('/');
    let Some(rest) = v.strip_prefix('/') else {
        return String::new();
    };
    let segs: Vec<&str> = rest.split('/').collect();
    let ok = segs.len() <= 4
        && segs.iter().all(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
        });
    if ok { v.to_string() } else { String::new() }
}

/// The query string as `application/x-www-form-urlencoded` UTF-8, leniently: a chunk with an empty name or broken
/// percent-encoding is dropped, never an error (the contract is a tolerant reader). `;` is an ordinary character.
pub fn parse_query(raw: &str) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for chunk in raw.split('&').filter(|c| !c.is_empty()) {
        let (name, value) = chunk.split_once('=').unwrap_or((chunk, ""));
        if let (Some(n), Some(v)) = (form_decode(name), form_decode(value))
            && !n.is_empty()
        {
            out.entry(n).or_default().push(v);
        }
    }
    out
}

fn form_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' => {
                let hex = bytes.get(i + 1..i + 3)?;
                let hi = (hex[0] as char).to_digit(16)?;
                let lo = (hex[1] as char).to_digit(16)?;
                out.push((hi * 16 + lo) as u8);
                i += 2;
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8(out).ok()
}

// --- cursors (CONTRACT-GUIDE §5) -----------------------------------------------------------------------------

/// What a cursor's keyset value must look like.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    Number,
    String,
    Timestamp,
}

/// base64url (no padding) of the UTF-8 JSON array `[1, "<sort>", <keysetValue>, "<lastId>"]`. `key` keeps a
/// number's decimal form as sent (compared as numeric in SQL, so `27` and `27.0` are the same cursor).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    pub key: String,
    pub last_id: String,
}

/// Checks a cursor against the expected sort: malformed, or made for another sort, is 400 invalid-cursor.
pub fn decode_cursor(raw: Option<&str>, sort: &str, kind: KeyKind) -> Result<Option<Cursor>> {
    let Some(raw) = raw else { return Ok(None) };
    let bad_json = || Problem::bad_cursor("cursor is not base64url JSON");
    let data = URL_SAFE_NO_PAD
        .decode(raw.trim_end_matches('='))
        .map_err(|_| bad_json())?;
    let parts: Vec<serde_json::Value> = serde_json::from_slice(&data).map_err(|_| bad_json())?;
    if parts.len() != 4 {
        return Err(Problem::bad_cursor("cursor has the wrong shape"));
    }
    if parts[0].as_f64() != Some(1.0) {
        return Err(Problem::bad_cursor("unknown cursor version"));
    }
    if parts[1].as_str() != Some(sort) {
        return Err(Problem::bad_cursor("cursor was made for another sort"));
    }
    let key = match (kind, &parts[2]) {
        (KeyKind::Number, serde_json::Value::Number(n)) => n.to_string(),
        (KeyKind::Number, _) => return Err(Problem::bad_cursor("cursor keyset must be a number")),
        (KeyKind::String, serde_json::Value::String(s)) => s.clone(),
        (KeyKind::String, _) => return Err(Problem::bad_cursor("cursor keyset must be a string")),
        (KeyKind::Timestamp, serde_json::Value::String(s)) if chrono::DateTime::parse_from_rfc3339(s).is_ok() => {
            s.clone()
        }
        (KeyKind::Timestamp, _) => return Err(Problem::bad_cursor("cursor keyset must be an RFC 3339 timestamp")),
    };
    match parts[3].as_str() {
        Some(last) if !last.is_empty() && last.chars().count() <= 64 => Ok(Some(Cursor {
            key,
            last_id: last.into(),
        })),
        _ => Err(Problem::bad_cursor("cursor id must be a string")),
    }
}

/// The cursor for the page after the row with keyset value `key` and id `last_id`; numbers in their shortest form.
pub fn encode_cursor(sort: &str, kind: KeyKind, key: &str, last_id: &str) -> String {
    let key = if kind == KeyKind::Number {
        serde_json::Value::Number(tidy(key).parse().unwrap_or_else(|_| 0.into()))
    } else {
        serde_json::Value::String(key.into())
    };
    let json = serde_json::to_vec(&serde_json::json!([1, sort, key, last_id])).expect("cursor serialises");
    URL_SAFE_NO_PAD.encode(json)
}

/// Drops trailing fractional zeros from a decimal ("12.40" → "12.4", "11.0000" → "11", "-0.0" → "0").
pub fn tidy(s: &str) -> String {
    if s.contains(['e', 'E']) {
        return s.to_string();
    }
    let mut t = s;
    if t.contains('.') {
        t = t.trim_end_matches('0').trim_end_matches('.');
    }
    if t == "-0" { "0".into() } else { t.to_string() }
}

// --- parameter checks (the contract's schemas: ranges, enums, patterns, lengths) ---------------------------------

/// The empty-parameter rule: a sent parameter must not be empty.
pub fn non_empty(ctx: &Ctx, names: &[&str]) -> Result<()> {
    for name in names {
        if ctx.query.get(*name).is_some_and(|vs| vs.iter().any(String::is_empty)) {
            return Err(Problem::invalid(&format!("#/query/{name}"), "must not be empty"));
        }
    }
    Ok(())
}

/// An optional integer parameter within [min, max].
pub fn int(ctx: &Ctx, name: &str, min: i64, max: i64) -> Result<Option<i64>> {
    let Some(raw) = ctx.first(name) else { return Ok(None) };
    let pointer = format!("#/query/{name}");
    let v: i64 = raw
        .parse()
        .map_err(|_| Problem::invalid(&pointer, "has an invalid value"))?;
    if v < min || v > max {
        return Err(Problem::invalid(&pointer, &format!("must be between {min} and {max}")));
    }
    Ok(Some(v))
}

/// An optional string parameter, its length in code points within [min, max].
pub fn string<'a>(ctx: &'a Ctx, name: &str, min: usize, max: usize) -> Result<Option<&'a str>> {
    let Some(v) = ctx.first(name) else { return Ok(None) };
    let n = v.chars().count();
    if n < min || n > max {
        return Err(Problem::invalid(
            &format!("#/query/{name}"),
            &format!("length must be between {min} and {max}"),
        ));
    }
    Ok(Some(v))
}

/// An optional enum parameter.
pub fn one_of<'a>(ctx: &'a Ctx, name: &str, allowed: &[&str]) -> Result<Option<&'a str>> {
    match ctx.first(name) {
        None => Ok(None),
        Some(v) if allowed.contains(&v) => Ok(Some(v)),
        Some(_) => Err(Problem::invalid(
            &format!("#/query/{name}"),
            &format!("must be one of {}", allowed.join(", ")),
        )),
    }
}

/// `country`: PH or JP.
pub fn country(ctx: &Ctx) -> Result<Option<&str>> {
    one_of(ctx, "country", &["PH", "JP"])
}

/// `radiusKm`: one of the precomputed bands (default 200).
pub fn radius(ctx: &Ctx) -> Result<i64> {
    Ok(one_of(ctx, "radiusKm", &["50", "100", "200", "300", "500"])
        .map_err(|_| Problem::invalid("#/query/radiusKm", "must be one of 50, 100, 200, 300, 500"))?
        .map_or(200, |v| v.parse().expect("radius band")))
}

/// `limit`: the page size (default `def`, 1..max).
pub fn limit(ctx: &Ctx, def: i64, max: i64) -> Result<i64> {
    Ok(int(ctx, "limit", 1, max)?.unwrap_or(def))
}

/// `cursor`: `^[A-Za-z0-9_-]{1,512}$`.
pub fn cursor_param(ctx: &Ctx) -> Result<Option<&str>> {
    match ctx.first("cursor") {
        Some(c)
            if !(1..=512).contains(&c.len())
                || !c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') =>
        {
            Err(Problem::invalid("#/query/cursor", "must match ^[A-Za-z0-9_-]{1,512}$"))
        }
        other => Ok(other),
    }
}

/// `^[0-9]{7}[NS][0-9]{5}$`.
pub fn sid_shape(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 13
        && b.iter().enumerate().all(|(i, c)| {
            if i == 7 {
                *c == b'N' || *c == b'S'
            } else {
                c.is_ascii_digit()
            }
        })
}

/// `^(PH-[0-9]{10}|JP-[0-9]{5})$`.
pub fn place_id_shape(s: &str) -> bool {
    let digits = |d: &str, n: usize| d.len() == n && d.bytes().all(|c| c.is_ascii_digit());
    s.strip_prefix("PH-").is_some_and(|d| digits(d, 10)) || s.strip_prefix("JP-").is_some_and(|d| digits(d, 5))
}

/// A required lat/lon parameter: a plain decimal (optionally with an exponent) within [-limit, limit], returned as
/// text for SQL so no rounding happens on the way.
pub fn coordinate(ctx: &Ctx, name: &str, limit: f64) -> Result<String> {
    let pointer = format!("#/query/{name}");
    let raw = ctx
        .first(name)
        .ok_or_else(|| Problem::invalid(&pointer, "is required"))?;
    if !is_decimal(raw) {
        return Err(Problem::invalid(&pointer, "must be a number"));
    }
    match raw.parse::<f64>() {
        Ok(f) if f.is_finite() && (-limit..=limit).contains(&f) => Ok(format!("{f}")),
        _ => Err(Problem::invalid(
            &pointer,
            &format!("must be between -{limit} and {limit}"),
        )),
    }
}

/// `[+-]? (digits [. digits?] | . digits) ([eE] [+-]? digits)?`
fn is_decimal(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    if matches!(b.first(), Some(b'+' | b'-')) {
        i += 1;
    }
    let mut digits = 0;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
        digits += 1;
    }
    if i < b.len() && b[i] == b'.' {
        i += 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == b.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_request_sorts_encodes_and_drops_unknown() {
        let q = parse_query("season=2013&limit=5&unknown=x&q=ha%20i+yan");
        let got = canonical_request("/v1/storms", &q, &["q", "season", "limit"]);
        assert_eq!(got, "/v1/storms?limit=5&q=ha%20i%20yan&season=2013");
        assert_eq!(resource_key(&got).len(), 16);
    }

    #[test]
    fn cursor_round_trip_matches_the_other_backends() {
        let enc = encode_cursor("closest", KeyKind::Number, "12.40", "PH-0831600000");
        assert_eq!(enc, "WzEsImNsb3Nlc3QiLDEyLjQsIlBILTA4MzE2MDAwMDAiXQ");
        let c = decode_cursor(Some(&enc), "closest", KeyKind::Number).unwrap().unwrap();
        assert_eq!((c.key.as_str(), c.last_id.as_str()), ("12.4", "PH-0831600000"));
        assert_eq!(
            decode_cursor(Some(&enc), "date-desc", KeyKind::Timestamp)
                .unwrap_err()
                .kind,
            INVALID_CURSOR
        );
    }

    #[test]
    fn weak_etag_comparison() {
        assert!(etag_matches(r#""nope", "d1-abc""#, r#"W/"d1-abc""#));
        assert!(!etag_matches(r#"W/"d2-abc""#, r#"W/"d1-abc""#));
        assert!(etag_matches("*", r#"W/"x""#));
    }

    #[test]
    fn query_parsing_is_lenient() {
        let q = parse_query("a=%zz&=x&b=1;2&c&d=%E5%8F%B0");
        assert!(!q.contains_key("a"));
        assert_eq!(
            (q["b"][0].as_str(), q["c"][0].as_str(), q["d"][0].as_str()),
            ("1;2", "", "台")
        );
    }

    #[test]
    fn tidy_numbers() {
        assert_eq!(
            (tidy("11.0000"), tidy("12.40"), tidy("-0.0"), tidy("27")),
            ("11".into(), "12.4".into(), "0".into(), "27".into())
        );
    }
}
