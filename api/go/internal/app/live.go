package app

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/abrycta/typhoon-replay/api/go/internal/api"
	"github.com/abrycta/typhoon-replay/api/go/internal/jsonw"
	"github.com/abrycta/typhoon-replay/api/go/internal/neon"
	"github.com/abrycta/typhoon-replay/api/go/internal/web"
)

var snapshotSQL = `SELECT r.seq, CASE WHEN r.seq > 0 THEN ` + ts("r.updated_at") + ` ELSE ` + ts("now()") + ` END AS as_of, ` +
	`(SELECT coalesce(jsonb_agg(a.storm ORDER BY a.live_id), '[]'::jsonb) FROM live.active_storm a)::text AS storms ` +
	`FROM live.revision r WHERE r.singleton`

const (
	revisionSQL = `SELECT seq FROM live.revision WHERE singleton`
	// The resume window: oldest retained seq - 1 <= id <= revision.
	inWindowSQL = `SELECT $1::bigint BETWEEN coalesce((SELECT min(seq) FROM live.live_event), r.seq + 1) - 1 AND r.seq AS ok ` +
		`FROM live.revision r WHERE r.singleton`
	eventsSQL = `SELECT seq, type, payload::text AS payload FROM live.live_event WHERE seq > $1::bigint ORDER BY seq LIMIT 1000`
)

// GetLiveSnapshot: GET /v1/live/storms, no-cache with ETag W/"s{seq}".
func (s *Server) GetLiveSnapshot(w http.ResponseWriter, r *http.Request, p api.GetLiveSnapshotParams) {
	c := ctxOf(r)
	res, err := s.read(c, neon.Q(snapshotSQL))
	if err != nil {
		fail(c, err)
		return
	}
	row := res[0].At(0)
	etag := `W/"s` + row.S("seq") + `"`
	if web.ETagMatches(c.IfNoneMatch, etag) {
		c.NotModified(etag)
		return
	}
	c.Send(http.StatusOK, "application/json; charset=utf-8", snapshotJSON(row), map[string]string{"ETag": etag})
}

func snapshotJSON(row neon.Row) []byte {
	var b jsonw.W
	b.Obj().S("asOf", row.S("as_of")).N("seq", row.S("seq")).Key("storms").Raw(row.S("storms")).End()
	return b.Bytes()
}

// Stream limits (CONTRACT-GUIDE §7). One shared poller (livePoller) checks live.revision and fetches new events in one
// HTTPS round trip to Neon every 2 s, well inside the 5 s delivery rule, however many streams are open; with no
// stream open, nothing touches the database. A stream ends after 30 min
// (the browser reconnects with Last-Event-ID and resumes), and at most maxStreams are open at once, at most perClient
// of them from one client address (so one client cannot fill every slot).
const (
	pollEvery      = 2 * time.Second
	heartbeatEvery = 15 * time.Second
	streamLifetime = 30 * time.Minute
	retryMs        = 10000
)

type streamCounter struct {
	mu        sync.Mutex
	n         int
	max       int
	perClient int // 0: no per-client cap
	byClient  map[string]int
}

// acquire takes a slot for client: nil, or the problem to answer (stream-capacity, or rate-limited for a client that
// already holds perClient streams).
func (sc *streamCounter) acquire(client string) *web.Problem {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	if sc.n >= sc.max {
		return &web.Problem{Type: web.StreamCapacity, Detail: "Too many live streams on this instance; retry shortly.",
			Headers: map[string]string{"Retry-After": "10"}}
	}
	if sc.perClient > 0 && sc.byClient[client] >= sc.perClient {
		return &web.Problem{Type: web.RateLimited, Detail: "Too many live streams from this address; close one first.",
			Headers: map[string]string{"Retry-After": "10"}}
	}
	if sc.byClient == nil {
		sc.byClient = map[string]int{}
	}
	sc.n++
	sc.byClient[client]++
	return nil
}

func (sc *streamCounter) release(client string) {
	sc.mu.Lock()
	sc.n--
	if sc.byClient[client]--; sc.byClient[client] <= 0 {
		delete(sc.byClient, client)
	}
	sc.mu.Unlock()
}

// StreamLiveEvents: GET /v1/live/stream (SSE). The Last-Event-ID header wins over ?lastEventId=.
func (s *Server) StreamLiveEvents(w http.ResponseWriter, r *http.Request, p api.StreamLiveEventsParams) {
	c := ctxOf(r)
	var last *int64
	if p.LastEventId != nil {
		v, prob := eventID(*p.LastEventId, "#/query/lastEventId")
		if prob != nil {
			c.Fail(prob)
			return
		}
		last = &v
	}
	if p.LastEventID != nil {
		v, prob := eventID(*p.LastEventID, "#/header/Last-Event-ID")
		if prob != nil {
			c.Fail(prob)
			return
		}
		last = &v
	}
	client := web.ClientIP(r, s.cfg.EdgeSecret)
	if prob := s.streams.acquire(client); prob != nil {
		c.Fail(prob)
		return
	}
	defer s.streams.release(client)

	// Snapshot or resume is decided before the stream opens, so a failing database gives a problem response.
	var first strings.Builder
	first.WriteString("retry: " + strconv.Itoa(retryMs) + "\n")
	var sent int64
	resumed := false
	if last != nil {
		res, err := s.read(c, neon.Q(inWindowSQL, *last), neon.Q(eventsSQL, *last))
		if err != nil {
			fail(c, err)
			return
		}
		if res[0].Len() > 0 && res[0].At(0).B("ok") {
			resumed = true
			sent = *last
			first.WriteString("\n")
			sent = writeEvents(&first, res[1], sent)
		}
	}
	if !resumed {
		res, err := s.read(c, neon.Q(snapshotSQL))
		if err != nil {
			fail(c, err)
			return
		}
		row := res[0].At(0)
		sent = row.I("seq")
		first.WriteString("id: " + row.S("seq") + "\nevent: snapshot\ndata: ")
		first.Write(snapshotJSON(row))
		first.WriteString("\n\n")
	}

	h := w.Header()
	h.Set("X-Backend-Impl", s.cfg.ID.Impl)
	h.Set("X-Backend-Version", s.cfg.ID.ImplVersion)
	h.Set("X-Contract-Version", s.cfg.ID.ContractVersion)
	h.Set("X-Request-Id", c.RequestID)
	h.Set("Vary", "Accept-Encoding")
	h.Set("Cache-Control", "no-cache")
	h.Set("Content-Type", "text/event-stream; charset=utf-8")
	h.Set("X-Accel-Buffering", "no")
	h.Set("X-Content-Type-Options", "nosniff")
	c.Status = http.StatusOK
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	if _, err := io.WriteString(w, first.String()); err != nil {
		return
	}
	if flusher != nil {
		flusher.Flush()
	}

	sub := s.live.subscribe(sent)
	defer s.live.unsubscribe(sub)
	lastWrite := time.Now()
	ctx := r.Context()
	end := time.NewTimer(streamLifetime)
	defer end.Stop()
	heartbeat := time.NewTicker(pollEvery)
	defer heartbeat.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-end.C:
			return
		case <-sub.wake:
			var out strings.Builder
			s.live.next(sub, &out)
			if out.Len() == 0 {
				continue
			}
			if _, err := io.WriteString(w, out.String()); err != nil {
				return
			}
			lastWrite = time.Now()
		case <-heartbeat.C:
			if time.Since(lastWrite) < heartbeatEvery {
				continue
			}
			if _, err := io.WriteString(w, ":\n\n"); err != nil {
				return
			}
			lastWrite = time.Now()
		}
		if flusher != nil {
			flusher.Flush()
		}
	}
}

// writeEvents appends the events after `after` as SSE frames; it returns the newest seq written.
func writeEvents(b *strings.Builder, rows *neon.Rows, after int64) int64 {
	for i := 0; i < rows.Len(); i++ {
		e := rows.At(i)
		seq := e.I("seq")
		if seq <= after {
			continue
		}
		b.WriteString("id: " + e.S("seq") + "\nevent: " + e.S("type") + "\ndata: " + e.S("payload") + "\n\n")
		after = seq
	}
	return after
}

func eventID(raw, pointer string) (int64, *web.Problem) {
	if len(raw) < 1 || len(raw) > 19 || strings.Trim(raw, "0123456789") != "" {
		return 0, web.Invalid(pointer, "must be 1-19 digits")
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return math.MaxInt64, nil // beyond any seq: outside the window, so the client gets a snapshot
	}
	return v, nil
}

const maxBody = 64 * 1024

// testHook: POST /v1/_test/live-events {type, payload} → 201 {seq}, through live.apply_event (the ingestion job's
// own write path). Only with TR_TEST_HOOKS=1; otherwise 404 not-found.
func (s *Server) testHook(c *web.Ctx) {
	r := c.R
	if r.Method != http.MethodPost {
		c.Fail(&web.Problem{Type: web.MethodNotAllowed, Detail: "Method " + r.Method + " is not supported here.",
			Headers: map[string]string{"Allow": allowPost}})
		return
	}
	tooLarge := &web.Problem{Type: web.PayloadTooLarge, Detail: "Request bodies are limited to 64 KB.",
		Headers: map[string]string{"Connection": "close"}}
	if r.ContentLength > maxBody {
		c.Fail(tooLarge)
		return
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if len(body) > maxBody {
		c.Fail(tooLarge)
		return
	}
	if ct := strings.ToLower(r.Header.Get("Content-Type")); !strings.HasPrefix(ct, "application/json") {
		c.Fail(&web.Problem{Type: web.UnsupportedMediaType, Detail: "Request bodies must be application/json."})
		return
	}
	if !s.cfg.TestHooks {
		c.Fail(web.Missing("No such resource."))
		return
	}
	var in struct {
		Type    *string         `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(body, &in); err != nil {
		c.Fail(web.Invalid("#/body", "is not valid JSON for this operation"))
		return
	}
	if in.Type == nil || (*in.Type != "storm-upserted" && *in.Type != "storm-removed") {
		c.Fail(web.Invalid("#/body/type", "must be storm-upserted or storm-removed"))
		return
	}
	var payload map[string]json.RawMessage
	var liveID string
	if json.Unmarshal(in.Payload, &payload) != nil || json.Unmarshal(payload["liveId"], &liveID) != nil {
		c.Fail(web.Invalid("#/body/payload", "must be an object with liveId"))
		return
	}
	if s.dbErr != nil {
		fail(c, &neon.Error{Message: s.dbErr.Error(), Unavailable: true})
		return
	}
	res, err := s.db.Write(r.Context(), neon.Q(`SELECT live.apply_event($1, $2::jsonb) AS seq`, *in.Type, string(in.Payload)))
	if err != nil {
		fail(c, err)
		return
	}
	var b jsonw.W
	b.Obj().N("seq", res[0].At(0).S("seq")).End()
	c.Send(http.StatusCreated, "application/json; charset=utf-8", b.Bytes(), nil)
}
