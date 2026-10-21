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

// ClientIP: behind the edge proxy (proved by X-Edge-Secret) the first X-Forwarded-For entry; otherwise the
// connecting client as Render's Cloudflare front reports it (CF-Connecting-IP), else the socket address.
func ClientIP(r *http.Request, edgeSecret string) string {
	if edgeSecret != "" {
		sent := strings.TrimSpace(r.Header.Get("X-Edge-Secret"))
		if sent != "" && subtle.ConstantTimeCompare([]byte(sent), []byte(edgeSecret)) == 1 {
			first, _, _ := strings.Cut(r.Header.Get("X-Forwarded-For"), ",")
			if first = strings.TrimSpace(first); first != "" {
				return first
			}
		}
	}
	if ip := r.Header.Get("CF-Connecting-IP"); ip != "" {
		return ip
	}
	return r.RemoteAddr
}
