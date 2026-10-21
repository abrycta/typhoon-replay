package web

import "testing"

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
