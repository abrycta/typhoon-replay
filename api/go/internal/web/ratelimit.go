package web

import (
	"crypto/subtle"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Limiter takes one request from the client's budget and reports whether it may proceed. The edge proxy's per-IP
// limit is the first guard; this one protects the public onrender.com URL.
type Limiter func(key string) bool

// TokenBucket is a per-IP limiter with greedy refill, like the Java backend's (perMinute requests, burst perMinute).
func TokenBucket(perMinute int) Limiter {
	type bucket struct {
		tokens float64
		at     time.Time
	}
	var (
		mu      sync.Mutex
		buckets = map[string]*bucket{}
		swept   time.Time
	)
	capacity, perSec := float64(perMinute), float64(perMinute)/60
	return func(key string) bool {
		now := time.Now()
		mu.Lock()
		defer mu.Unlock()
		if now.Sub(swept) > 2*time.Minute {
			for k, b := range buckets {
				if now.Sub(b.at) > 2*time.Minute {
					delete(buckets, k)
				}
			}
			swept = now
		}
		b := buckets[key]
		if b == nil {
			b = &bucket{tokens: capacity, at: now}
			buckets[key] = b
		}
		b.tokens = min(capacity, b.tokens+now.Sub(b.at).Seconds()*perSec)
		b.at = now
		if b.tokens < 1 {
			return false
		}
		b.tokens--
		return true
	}
}

// RateLimit applies the limiter to the request's client (not to the probes) and returns a 429 problem when it refuses.
func RateLimit(c *Ctx, limiter Limiter, edgeSecret string) *Problem {
	if limiter == nil || c.Path == "/healthz" || c.Path == "/readyz" {
		return nil
	}
	if limiter(ClientIP(c.R, edgeSecret)) {
		return nil
	}
	return &Problem{Type: RateLimited, Detail: "Too many requests from this address; retry later.",
		Headers: map[string]string{"Retry-After": "60"}}
}

// FromEdge reports whether the request carries the edge proxy's secret (X-Edge-Secret, TR_EDGE_SECRET).
func FromEdge(r *http.Request, edgeSecret string) bool {
	if edgeSecret == "" {
		return false
	}
	sent := strings.TrimSpace(r.Header.Get("X-Edge-Secret"))
	return sent != "" && subtle.ConstantTimeCompare([]byte(sent), []byte(edgeSecret)) == 1
}

var forbiddenBody = []byte(`{"type":"about:blank","title":"Forbidden","status":403,` +
	`"detail":"Requests must come through the site's edge proxy."}`)

// EdgeOnly: when TR_EDGE_SECRET is set, /v1/* answers only requests that carry it (the edge proxy adds it). A direct
// call to the Render URL would skip the edge cache and its per-IP limit and spend Render's shared egress, so it gets a
// small 403 and EdgeOnly returns false. /healthz and /readyz stay open; with no secret configured nothing is refused.
func EdgeOnly(c *Ctx, edgeSecret string) bool {
	if edgeSecret == "" || !strings.HasPrefix(c.Path, "/v1/") || FromEdge(c.R, edgeSecret) {
		return true
	}
	h := c.standard("no-store")
	h.Set("Content-Type", "application/problem+json")
	c.write(http.StatusForbidden, forbiddenBody)
	return false
}

// ClientIP: behind the edge proxy (proved by X-Edge-Secret) the first X-Forwarded-For entry; otherwise the socket
// address. Client-sent X-Forwarded-For and CF-Connecting-IP are never trusted without the secret, so a direct caller
// cannot pick its own bucket.
func ClientIP(r *http.Request, edgeSecret string) string {
	if FromEdge(r, edgeSecret) {
		first, _, _ := strings.Cut(r.Header.Get("X-Forwarded-For"), ",")
		if first = strings.TrimSpace(first); first != "" {
			return first
		}
	}
	return r.RemoteAddr
}
