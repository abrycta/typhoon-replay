package web

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCanonicalRequest(t *testing.T) {
	q := ParseQuery("season=2013&limit=5&unknown=x&q=ha%20i+yan")
	got := CanonicalRequest("/v1/storms", q, []string{"q", "season", "limit"})
	if want := "/v1/storms?limit=5&q=ha%20i%20yan&season=2013"; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
	if ResourceKey("/v1/storms") == ResourceKey(got) || len(ResourceKey(got)) != 16 {
		t.Fatal("resource key")
	}
}

func TestCursorRoundTrip(t *testing.T) {
	enc := EncodeCursor("closest", KeyNumber, "12.40", "PH-0831600000")
	if enc != "WzEsImNsb3Nlc3QiLDEyLjQsIlBILTA4MzE2MDAwMDAiXQ" {
		t.Fatalf("encoded %s", enc)
	}
	c, p := DecodeCursor(enc, "closest", KeyNumber)
	if p != nil || c.Key != "12.4" || c.LastID != "PH-0831600000" {
		t.Fatalf("decoded %+v %v", c, p)
	}
	if _, p := DecodeCursor(enc, "date-desc", KeyTimestamp); p == nil || p.Type != InvalidCursor {
		t.Fatal("foreign sort accepted")
	}
}

func TestETagMatches(t *testing.T) {
	if !ETagMatches(`"nope", "d1-abc"`, `W/"d1-abc"`) || ETagMatches(`W/"d2-abc"`, `W/"d1-abc"`) || !ETagMatches("*", `W/"x"`) {
		t.Fatal("weak comparison")
	}
}

func TestParseQueryIsLenient(t *testing.T) {
	q := ParseQuery("a=%zz&=x&b=1;2&c&d=%E5%8F%B0")
	if _, ok := q["a"]; ok || q["b"][0] != "1;2" || q["c"][0] != "" || q["d"][0] != "台" {
		t.Fatalf("%v", q)
	}
}

func TestEdgeOnly(t *testing.T) {
	status := func(path, sent, secret string) int {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.RemoteAddr = "10.0.0.9:1234"
		if sent != "" {
			r.Header.Set("X-Edge-Secret", sent)
		}
		w := httptest.NewRecorder()
		c := NewCtx(w, r, Identity{Impl: "go"})
		if EdgeOnly(c, secret) {
			return http.StatusOK
		}
		return w.Code
	}
	for _, tc := range []struct {
		path, sent, secret string
		want               int
	}{
		{"/v1/meta", "", "s3cret", 403},
		{"/v1/meta", "guess", "s3cret", 403},
		{"/v1/meta", "s3cret", "s3cret", 200},
		{"/healthz", "", "s3cret", 200},
		{"/readyz", "", "s3cret", 200},
		{"/v1/meta", "", "", 200},
	} {
		if got := status(tc.path, tc.sent, tc.secret); got != tc.want {
			t.Errorf("%s sent=%q secret=%q: got %d want %d", tc.path, tc.sent, tc.secret, got, tc.want)
		}
	}
}

func TestClientIPTrustsHeadersOnlyWithTheSecret(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/v1/storms", nil)
	r.RemoteAddr = "10.0.0.9:1234"
	r.Header.Set("X-Forwarded-For", "203.0.113.7, 198.51.100.2")
	r.Header.Set("CF-Connecting-IP", "198.51.100.1")
	if got := ClientIP(r, "s3cret"); got != "10.0.0.9:1234" {
		t.Fatalf("no secret sent: got %s", got)
	}
	r.Header.Set("X-Edge-Secret", "s3cret")
	if got := ClientIP(r, "s3cret"); got != "203.0.113.7" {
		t.Fatalf("from the edge: got %s", got)
	}
	if got := ClientIP(r, ""); got != "10.0.0.9:1234" {
		t.Fatalf("no secret configured: got %s", got)
	}
}
