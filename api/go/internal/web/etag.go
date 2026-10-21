package web

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strconv"
	"strings"
)

// CatalogueETag is W/"d{datasetVersion}-{resourceKey}" (CONTRACT-GUIDE §6): derived from the request and the
// dataset, never from response bytes, so every backend emits the same tag for the same resource.
func CatalogueETag(datasetVersion int64, path string, query map[string][]string, recognised ...string) string {
	return `W/"d` + strconv.FormatInt(datasetVersion, 10) + "-" + ResourceKey(CanonicalRequest(path, query, recognised)) + `"`
}

// CanonicalRequest is the path, then ? and the recognised parameters that were sent, sorted by name then value,
// RFC 3986 percent-encoded, joined by &. Unknown parameters are dropped and defaults are not filled in.
func CanonicalRequest(path string, query map[string][]string, recognised []string) string {
	type pair struct{ k, v string }
	var pairs []pair
	for _, name := range recognised {
		for _, v := range query[name] {
			pairs = append(pairs, pair{name, v})
		}
	}
	if len(pairs) == 0 {
		return path
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].k != pairs[j].k {
			return pairs[i].k < pairs[j].k
		}
		return utf16Less(pairs[i].v, pairs[j].v)
	})
	var b strings.Builder
	b.WriteString(path)
	b.WriteByte('?')
	for i, p := range pairs {
		if i > 0 {
			b.WriteByte('&')
		}
		b.WriteString(PercentEncode(p.k))
		b.WriteByte('=')
		b.WriteString(PercentEncode(p.v))
	}
	return b.String()
}

// utf16Less orders strings like Java's String.compareTo (UTF-16 code units), which the reference backend uses.
func utf16Less(a, b string) bool {
	ra, rb := []rune(a), []rune(b)
	for i := 0; i < len(ra) && i < len(rb); i++ {
		if ra[i] == rb[i] {
			continue
		}
		return utf16Key(ra[i]) < utf16Key(rb[i])
	}
	return len(ra) < len(rb)
}

func utf16Key(r rune) rune {
	if r >= 0x10000 {
		return 0xD800 + (r-0x10000)>>10 // a high surrogate sorts after BMP chars below U+D800, before U+E000+
	}
	return r
}

// ResourceKey is the first 16 hex digits of SHA-256 over the canonical request string.
func ResourceKey(canonical string) string {
	sum := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(sum[:8])
}

// PercentEncode: RFC 3986 unreserved characters literal, every other UTF-8 byte as %XX (uppercase).
func PercentEncode(s string) string {
	const hx = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '.' || c == '_' || c == '~' {
			b.WriteByte(c)
		} else {
			b.WriteByte('%')
			b.WriteByte(hx[c>>4])
			b.WriteByte(hx[c&0xF])
		}
	}
	return b.String()
}

// ETagMatches is the weak comparison of an If-None-Match list (or *) against our tag.
func ETagMatches(ifNoneMatch, etag string) bool {
	if strings.TrimSpace(ifNoneMatch) == "" {
		return false
	}
	ours := strings.TrimPrefix(etag, "W/")
	for _, c := range strings.Split(ifNoneMatch, ",") {
		c = strings.TrimSpace(c)
		if c == "*" || c != "" && strings.TrimPrefix(c, "W/") == ours {
			return true
		}
	}
	return false
}
