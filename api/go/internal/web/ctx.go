// Package web holds the contract's HTTP rules that every operation shares: the §4 headers, problem documents,
// lenient query parsing, data-derived ETags, interchangeable cursors and the per-IP rate limit (CONTRACT-GUIDE).
package web

import (
	"bytes"
	"compress/gzip"
	"net/http"
	"strings"
	"sync"
)

// Identity is what every response reports about this backend (CONTRACT-GUIDE §4).
type Identity struct {
	Impl            string
	ImplVersion     string
	ContractVersion string
}

// Ctx is one request in flight.
type Ctx struct {
	W         http.ResponseWriter
	R         *http.Request
	ID        Identity
	RequestID string
	// Path is the path as served under the backend root, e.g. /v1/storms (escaped form, as Java's getRequestURI).
	Path string
	// IfNoneMatch is the If-None-Match header as received. ServeHTTP removes it from the request before the generated
	// binding runs, which would split its comma-separated list into "too many values".
	IfNoneMatch string
	// RawQuery is the query string as received.
	RawQuery string
	// Query holds every value of every well-formed query parameter, in arrival order.
	Query  map[string][]string
	sticky map[string]string
	Status int
}

// NewCtx resolves the request id and parses the query string leniently.
func NewCtx(w http.ResponseWriter, r *http.Request, id Identity) *Ctx {
	return &Ctx{
		W: w, R: r, ID: id,
		RequestID:   ResolveRequestID(r.Header.Get("X-Request-Id")),
		Path:        r.URL.EscapedPath(),
		RawQuery:    r.URL.RawQuery,
		IfNoneMatch: strings.Join(r.Header.Values("If-None-Match"), ","),
		Query:       ParseQuery(r.URL.RawQuery),
	}
}

// First returns the first value of a query parameter and whether it was sent.
func (c *Ctx) First(name string) (string, bool) {
	v, ok := c.Query[name]
	if !ok || len(v) == 0 {
		return "", false
	}
	return v[0], true
}

// Instance is the path and query as received: the problem `instance`.
func (c *Ctx) Instance() string {
	if c.RawQuery == "" {
		return c.Path
	}
	return c.Path + "?" + c.RawQuery
}

// Sticky sets a header that also survives on problem responses (the rate-limit headers).
func (c *Ctx) Sticky(name, value string) {
	if c.sticky == nil {
		c.sticky = map[string]string{}
	}
	c.sticky[name] = value
}

// standard sets the §4 headers and the Cache-Control of the resource class.
func (c *Ctx) standard(cacheControl string) http.Header {
	h := c.W.Header()
	h.Set("X-Backend-Impl", c.ID.Impl)
	h.Set("X-Backend-Version", c.ID.ImplVersion)
	h.Set("X-Contract-Version", c.ID.ContractVersion)
	h.Set("X-Request-Id", c.RequestID)
	h.Set("Vary", "Accept-Encoding")
	h.Set("Cache-Control", cacheControl)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("X-Xss-Protection", "0")
	for k, v := range c.sticky {
		h.Set(k, v)
	}
	return h
}

// gzipMin: bodies over 1 KB are compressed when the client accepts it (CONTRACT-GUIDE §4).
const gzipMin = 1024

// Send writes a successful response.
func (c *Ctx) Send(status int, contentType string, body []byte, extra map[string]string) {
	h := c.standard(CacheControlFor(c.Path))
	for k, v := range extra {
		h.Set(k, v)
	}
	h.Set("Content-Type", contentType)
	c.write(status, body)
}

func (c *Ctx) write(status int, body []byte) {
	h := c.W.Header()
	head := c.R.Method == http.MethodHead
	if len(body) > gzipMin && acceptsGzip(c.R.Header.Get("Accept-Encoding")) {
		body = gzipped(body)
		h.Set("Content-Encoding", "gzip")
	}
	if !head {
		h.Set("Content-Length", itoa(len(body)))
	}
	c.Status = status
	c.W.WriteHeader(status)
	if !head && status != http.StatusNotModified {
		_, _ = c.W.Write(body)
	}
}

// NotModified is the 304 for a matching If-None-Match: same ETag and Cache-Control, no body.
func (c *Ctx) NotModified(etag string) {
	h := c.standard(CacheControlFor(c.Path))
	h.Set("ETag", etag)
	c.Status = http.StatusNotModified
	c.W.WriteHeader(http.StatusNotModified)
}

// Fail writes a problem document. Any success headers prepared earlier are not set yet (handlers set them only in
// Send), so only the §4 headers, the sticky ones and the problem's own headers go out.
func (c *Ctx) Fail(p *Problem) {
	h := c.standard(CacheControlForError(p.Type.Status, c.R.Method, c.Path))
	for k, v := range p.Headers {
		h.Set(k, v)
	}
	h.Set("Content-Type", "application/problem+json")
	c.write(p.Type.Status, p.body(c.Instance(), c.RequestID))
}

var gzipWriters = sync.Pool{New: func() any {
	w, _ := gzip.NewWriterLevel(nil, gzip.DefaultCompression)
	return w
}}

// gzipped compresses a response body (Render bills outbound bytes; the edge stores entries decoded).
func gzipped(body []byte) []byte {
	var buf bytes.Buffer
	zw := gzipWriters.Get().(*gzip.Writer)
	zw.Reset(&buf)
	_, _ = zw.Write(body)
	_ = zw.Close()
	gzipWriters.Put(zw)
	return buf.Bytes()
}

func acceptsGzip(ae string) bool {
	for _, part := range strings.Split(ae, ",") {
		coding, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		coding = strings.TrimSpace(coding)
		if strings.EqualFold(coding, "gzip") || coding == "*" {
			q := strings.ReplaceAll(params, " ", "")
			return !(q == "q=0" || q == "q=0." || strings.HasPrefix(q, "q=0.0") && strings.Trim(q[4:], "0") == "")
		}
	}
	return false
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// Cache-Control by resource class (CONTRACT-GUIDE §6).
const (
	CacheCatalogue = "public, max-age=300, stale-while-revalidate=86400"
	CacheMeta      = "public, max-age=60"
	CacheLive      = "no-cache"
	CacheNoStore   = "no-store"
	CacheNotFound  = "public, max-age=60"
)

// CacheControlFor is the Cache-Control of a successful (2xx/3xx) response to path.
func CacheControlFor(path string) string {
	switch {
	case path == "/healthz" || path == "/readyz":
		return CacheNoStore
	case path == "/v1/meta" || path == "/v1/openapi.json":
		return CacheMeta
	case strings.HasPrefix(path, "/v1/live/"):
		return CacheLive
	case IsCatalogue(path):
		return CacheCatalogue
	}
	return CacheNoStore
}

// CacheControlForError: no-store, except a 404 on a catalogue read.
func CacheControlForError(status int, method, path string) string {
	if status == 404 && method == http.MethodGet && IsCatalogue(path) {
		return CacheNotFound
	}
	return CacheNoStore
}

// IsCatalogue: storms, places, hits and place search.
func IsCatalogue(path string) bool {
	return path == "/v1/storms" || strings.HasPrefix(path, "/v1/storms/") || strings.HasPrefix(path, "/v1/places/") ||
		path == "/v1/hits"
}
