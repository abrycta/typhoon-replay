// Package app implements the contract's operations: the generated api.ServerInterface, wired by a small router that
// matches the contract's 15 paths (and answers 404/405 as problem+json) before handing each request to the generated
// wrapper, which binds and types every parameter.
package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/abrycta/typhoon-replay/api/go/internal/api"
	"github.com/abrycta/typhoon-replay/api/go/internal/neon"
	"github.com/abrycta/typhoon-replay/api/go/internal/web"
)

// Config comes only from the environment, with the names every backend shares (CONTRACT-GUIDE §11).
type Config struct {
	DatabaseURL      string      // DATABASE_URL (Neon pooled URL)
	NeonHTTPURL      string      // NEON_HTTP_URL: optional SQL-over-HTTP endpoint (local proxy in CI)
	SiteOrigin       string      // TR_SITE_ORIGIN
	TestHooks        bool        // TR_TEST_HOOKS
	Limiter          web.Limiter // per-IP limit; nil when TR_RATE_LIMIT_PER_MINUTE=0
	MaxStreams       int         // TR_MAX_STREAMS (at least 50)
	MaxPerClient     int         // TR_MAX_STREAMS_PER_CLIENT; 0: no per-client cap
	EdgeSecret       string      // TR_EDGE_SECRET
	Commit           string      // TR_COMMIT
	MinSchemaVersion string
	ID               web.Identity
	OpenAPI          []byte // the contract bundle, served unchanged
}

// Server is the backend: one per Workers isolate.
type Server struct {
	cfg       Config
	db        *neon.Client
	dbErr     error
	wrapper   *api.ServerInterfaceWrapper
	startedAt string
	streams   *streamCounter

	mu        sync.Mutex
	version   int64
	versionAt time.Time
}

// New builds the server. A bad DATABASE_URL does not stop it: /healthz still answers and /readyz reports it.
func New(cfg Config) *Server {
	db, err := neon.New(cfg.DatabaseURL, cfg.NeonHTTPURL)
	s := &Server{
		cfg: cfg, db: db, dbErr: err,
		startedAt: time.Now().UTC().Format("2006-01-02T15:04:05Z"),
		streams:   &streamCounter{max: max(50, cfg.MaxStreams), perClient: cfg.MaxPerClient},
	}
	s.wrapper = &api.ServerInterfaceWrapper{Handler: s, ErrorHandlerFunc: bindError}
	return s
}

type ctxKey struct{}

func ctxOf(r *http.Request) *web.Ctx { return r.Context().Value(ctxKey{}).(*web.Ctx) }

// route is a contract path: the operation it serves and, for parameters that must not be empty, their names.
type route struct {
	op       func(w http.ResponseWriter, r *http.Request)
	nonEmpty []string
}

var (
	allowGet  = "GET, HEAD, OPTIONS"
	allowPost = "POST, OPTIONS"
)

// match finds the operation for a path and sets its path parameters. ok is false for unknown paths.
func (s *Server) match(r *http.Request, path string) (route, bool) {
	w := s.wrapper
	switch path {
	case "/healthz":
		return route{op: w.GetHealth}, true
	case "/readyz":
		return route{op: w.GetReadiness}, true
	case "/v1/meta":
		return route{op: w.GetMeta}, true
	case "/v1/openapi.json":
		return route{op: w.GetOpenApiDocument}, true
	case "/v1/storms":
		return route{w.ListStorms, []string{"q", "season", "from", "to", "basin", "country", "minWindKt", "sort", "cursor", "limit"}}, true
	case "/v1/places/search":
		return route{w.SearchPlaces, []string{"q", "country", "limit"}}, true
	case "/v1/places/nearest":
		return route{w.GetNearestPlace, []string{"lat", "lon"}}, true
	case "/v1/hits":
		return route{w.ListPointStorms, []string{"lat", "lon", "radiusKm", "minWindKt", "from", "to", "sort", "cursor", "limit"}}, true
	case "/v1/live/storms":
		return route{op: w.GetLiveSnapshot}, true
	case "/v1/live/stream":
		return route{w.StreamLiveEvents, []string{"lastEventId"}}, true
	}
	segs := strings.Split(strings.TrimPrefix(path, "/"), "/")
	if len(segs) < 3 || segs[0] != "v1" || segs[2] == "" {
		return route{}, false
	}
	switch {
	case segs[1] == "storms" && len(segs) == 3:
		r.SetPathValue("sid", segs[2])
		return route{op: w.GetStorm}, true
	case segs[1] == "storms" && len(segs) == 4 && segs[3] == "track":
		r.SetPathValue("sid", segs[2])
		return route{op: w.GetStormTrack}, true
	case segs[1] == "storms" && len(segs) == 4 && segs[3] == "places":
		r.SetPathValue("sid", segs[2])
		return route{w.ListStormPlaces, []string{"radiusKm", "country", "cursor", "limit"}}, true
	case segs[1] == "places" && len(segs) == 3:
		r.SetPathValue("placeId", segs[2])
		return route{op: w.GetPlace}, true
	case segs[1] == "places" && len(segs) == 4 && segs[3] == "storms":
		r.SetPathValue("placeId", segs[2])
		return route{w.ListPlaceStorms, []string{"radiusKm", "minWindKt", "from", "to", "sort", "cursor", "limit"}}, true
	}
	return route{}, false
}

// ServeHTTP is the request pipeline: request id and §4 headers, rate limit, routing (404/405), the empty-parameter
// rule, then the generated wrapper. Panics become 500 internal; database outages 503 not-ready.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	c := web.NewCtx(w, r, s.cfg.ID)
	defer func() {
		if p := recover(); p != nil {
			logLine("error", "panic", c, started)
			if c.Status == 0 {
				c.Fail(&web.Problem{Type: web.Internal, Detail: "Unexpected error; see requestId in the logs."})
			}
		}
		logLine("info", "request", c, started)
	}()
	r = r.WithContext(context.WithValue(r.Context(), ctxKey{}, c))
	c.R = r

	if !web.EdgeOnly(c, s.cfg.EdgeSecret) {
		return
	}
	if p := web.RateLimit(c, s.cfg.Limiter, s.cfg.EdgeSecret); p != nil {
		c.Fail(p)
		return
	}
	if c.Path == "/v1/_test/live-events" {
		s.testHook(c)
		return
	}
	rt, ok := s.match(r, c.Path)
	if !ok {
		c.Fail(web.Missing("No such resource."))
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
	case http.MethodOptions:
		c.W.Header().Set("Allow", allowGet)
		c.Send(http.StatusNoContent, "text/plain; charset=utf-8", nil, nil)
		return
	default:
		c.Fail(&web.Problem{Type: web.MethodNotAllowed, Detail: "Method " + r.Method + " is not supported here.",
			Headers: map[string]string{"Allow": allowGet}})
		return
	}
	for _, name := range rt.nonEmpty {
		for _, v := range c.Query[name] {
			if v == "" {
				c.Fail(web.Invalid("#/query/"+name, "must not be empty"))
				return
			}
		}
	}
	// The generated binding reads r.URL.Query(): hand it the leniently parsed values, first value of each name.
	r.URL.RawQuery = firstValues(c.Query)
	r.Header.Del("If-None-Match")
	rt.op(w, r)
}

func firstValues(q map[string][]string) string {
	var b strings.Builder
	for k, v := range q {
		if b.Len() > 0 {
			b.WriteByte('&')
		}
		b.WriteString(web.PercentEncode(k))
		b.WriteByte('=')
		b.WriteString(web.PercentEncode(v[0]))
	}
	return b.String()
}

// bindError maps the generated wrapper's binding errors to 400 validation with a field pointer.
func bindError(w http.ResponseWriter, r *http.Request, err error) {
	c := ctxOf(r)
	var (
		required *api.RequiredParamError
		format   *api.InvalidParamFormatError
		header   *api.RequiredHeaderError
		many     *api.TooManyValuesForParamError
		unmarsh  *api.UnmarshalingParamError
	)
	switch {
	case errors.As(err, &required):
		c.Fail(web.Invalid("#/query/"+required.ParamName, "is required"))
	case errors.As(err, &format):
		c.Fail(web.Invalid(pointer(format.ParamName), "has an invalid value"))
	case errors.As(err, &header):
		c.Fail(web.Invalid("#/header/"+header.ParamName, "is required"))
	case errors.As(err, &many):
		c.Fail(web.Invalid(pointer(many.ParamName), "has too many values"))
	case errors.As(err, &unmarsh):
		c.Fail(web.Invalid(pointer(unmarsh.ParamName), "has an invalid value"))
	default:
		c.Fail(&web.Problem{Type: web.Validation, Detail: "The request could not be bound."})
	}
}

func pointer(param string) string {
	switch param {
	case "sid", "placeId":
		return "#/path/" + param
	case "If-None-Match", "Last-Event-ID":
		return "#/header/" + param
	}
	return "#/query/" + param
}

// fail maps a query error: an unreachable database is 503 not-ready with Retry-After (Neon resuming from scale to
// zero); anything else is 500 internal, never with SQL in the body.
func fail(c *web.Ctx, err error) {
	var p *web.Problem
	if errors.As(err, &p) {
		c.Fail(p)
		return
	}
	logError(c, err)
	if neon.IsUnavailable(err) {
		c.Fail(&web.Problem{Type: web.NotReady, Detail: "The database is waking up; retry shortly.",
			Headers: map[string]string{"Retry-After": "10"}})
		return
	}
	c.Fail(&web.Problem{Type: web.Internal, Detail: "Unexpected error; see requestId in the logs."})
}

// read runs queries in one read-only transaction (one HTTPS round trip to Neon).
func (s *Server) read(c *web.Ctx, qs ...neon.Query) ([]*neon.Rows, error) {
	if s.dbErr != nil {
		return nil, &neon.Error{Message: s.dbErr.Error(), Unavailable: true}
	}
	return s.db.Read(c.R.Context(), qs...)
}

const versionTTL = 5 * time.Second

func (s *Server) cachedVersion() (int64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.version, !s.versionAt.IsZero() && time.Since(s.versionAt) < versionTTL
}

func (s *Server) setVersion(v int64) {
	s.mu.Lock()
	s.version, s.versionAt = v, time.Now()
	s.mu.Unlock()
}

// catalogue serves a catalogue read. A conditional request (the edge revalidating) is answered 304 from the dataset
// version cached for 5 s, without the database; otherwise the dataset version and the operation's queries run in one
// transaction (one round trip), the ETag is derived from it, and a matching If-None-Match still gets a 304.
// done is true when the response was already written.
func (s *Server) catalogue(c *web.Ctx, recognised []string, qs ...neon.Query) (rows []*neon.Rows, etag string, done bool) {
	inm := c.IfNoneMatch
	if inm != "" {
		if v, ok := s.cachedVersion(); ok {
			if etag = web.CatalogueETag(v, c.Path, c.Query, recognised...); web.ETagMatches(inm, etag) {
				c.NotModified(etag)
				return nil, etag, true
			}
		}
	}
	res, err := s.read(c, append([]neon.Query{neon.Q(datasetVersionSQL)}, qs...)...)
	if err != nil {
		fail(c, err)
		return nil, "", true
	}
	v := res[0].At(0).I("v")
	s.setVersion(v)
	etag = web.CatalogueETag(v, c.Path, c.Query, recognised...)
	if web.ETagMatches(inm, etag) {
		c.NotModified(etag)
		return nil, etag, true
	}
	return res[1:], etag, false
}

// sendJSON writes a 200 with an ETag and, for pages, the Link to the next page.
func (s *Server) sendJSON(c *web.Ctx, body []byte, etag, nextCursor string, contentType ...string) {
	extra := map[string]string{"ETag": etag}
	if nextCursor != "" {
		extra["Link"] = s.nextLink(c, nextCursor)
	}
	ct := "application/json; charset=utf-8"
	if len(contentType) > 0 {
		ct = contentType[0]
	}
	c.Send(http.StatusOK, ct, body, extra)
}

// nextLink is <{site origin}{X-Forwarded-Prefix}{path}?{query without cursor}&cursor=...>; rel="next" (§5).
func (s *Server) nextLink(c *web.Ctx, cursor string) string {
	var q []string
	if raw := c.RawQuery; raw != "" {
		for _, pair := range strings.Split(raw, "&") {
			if pair != "" && pair != "cursor" && !strings.HasPrefix(pair, "cursor=") {
				q = append(q, pair)
			}
		}
	}
	q = append(q, "cursor="+cursor)
	base := s.cfg.SiteOrigin + web.ForwardedPrefix(c.R.Header.Get("X-Forwarded-Prefix"))
	return "<" + base + c.Path + "?" + strings.Join(q, "&") + `>; rel="next"`
}

func logLine(level, msg string, c *web.Ctx, started time.Time) {
	line, _ := json.Marshal(map[string]any{
		"ts": time.Now().UTC().Format(time.RFC3339Nano), "level": level, "msg": msg, "requestId": c.RequestID,
		"impl": c.ID.Impl, "method": c.R.Method, "path": c.Path, "status": c.Status,
		"durMs": time.Since(started).Milliseconds(),
	})
	println(string(line))
}

func logError(c *web.Ctx, err error) {
	line, _ := json.Marshal(map[string]any{
		"ts": time.Now().UTC().Format(time.RFC3339Nano), "level": "warn", "msg": err.Error(), "requestId": c.RequestID,
		"impl": c.ID.Impl, "path": c.Path,
	})
	println(string(line))
}
