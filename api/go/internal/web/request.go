package web

import (
	"crypto/rand"
	"encoding/binary"
	"strings"
	"time"
	"unicode/utf8"
)

// ResolveRequestID echoes the inbound X-Request-Id when it is 1–64 chars of [A-Za-z0-9._-], else makes a UUIDv7.
func ResolveRequestID(inbound string) string {
	if n := len(inbound); n >= 1 && n <= 64 {
		ok := true
		for i := 0; i < n && ok; i++ {
			c := inbound[i]
			ok = c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-'
		}
		if ok {
			return inbound
		}
	}
	return UUIDv7()
}

// UUIDv7 is a time-ordered random UUID (RFC 9562).
func UUIDv7() string {
	var b [16]byte
	_, _ = rand.Read(b[6:])
	ms := uint64(time.Now().UnixMilli())
	binary.BigEndian.PutUint16(b[0:], uint16(ms>>32))
	binary.BigEndian.PutUint32(b[2:], uint32(ms))
	b[6] = 0x70 | b[6]&0x0F
	b[8] = 0x80 | b[8]&0x3F
	const hx = "0123456789abcdef"
	out := make([]byte, 0, 36)
	for i, c := range b {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			out = append(out, '-')
		}
		out = append(out, hx[c>>4], hx[c&0xF])
	}
	return string(out)
}

// ForwardedPrefix is X-Forwarded-Prefix (e.g. /api/go) when well formed: 1–4 segments of [A-Za-z0-9._-].
func ForwardedPrefix(v string) string {
	v = strings.TrimSuffix(v, "/")
	if v == "" || v[0] != '/' {
		return ""
	}
	segs := strings.Split(v[1:], "/")
	if len(segs) > 4 {
		return ""
	}
	for _, s := range segs {
		if s == "" {
			return ""
		}
		for i := 0; i < len(s); i++ {
			c := s[i]
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-') {
				return ""
			}
		}
	}
	return v
}

// ParseQuery reads the query string as application/x-www-form-urlencoded UTF-8, leniently: a chunk with an empty
// name or broken percent-encoding is dropped, never an error (the contract is a tolerant reader). Unlike Go's
// url.ParseQuery, ';' is an ordinary character.
func ParseQuery(raw string) map[string][]string {
	out := map[string][]string{}
	for _, chunk := range strings.Split(raw, "&") {
		if chunk == "" {
			continue
		}
		name, value, _ := strings.Cut(chunk, "=")
		n, ok1 := formDecode(name)
		v, ok2 := formDecode(value)
		if !ok1 || !ok2 || n == "" {
			continue
		}
		out[n] = append(out[n], v)
	}
	return out
}

func formDecode(s string) (string, bool) {
	if !strings.ContainsAny(s, "%+") {
		return s, utf8.ValidString(s)
	}
	b := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '+':
			b = append(b, ' ')
		case '%':
			if i+2 >= len(s) {
				return "", false
			}
			hi, lo := unhex(s[i+1]), unhex(s[i+2])
			if hi < 0 || lo < 0 {
				return "", false
			}
			b = append(b, byte(hi<<4|lo))
			i += 2
		default:
			b = append(b, c)
		}
	}
	return string(b), utf8.Valid(b)
}

func unhex(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return -1
}
