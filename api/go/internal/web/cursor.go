package web

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/abrycta/typhoon-replay/api/go/internal/jsonw"
)

// KeyKind is what a cursor's keyset value must look like.
type KeyKind int

const (
	KeyNumber KeyKind = iota
	KeyString
	KeyTimestamp
)

// Cursor is an interchangeable keyset cursor (CONTRACT-GUIDE §5): base64url (no padding) of the UTF-8 JSON array
// [1, "<sort>", <keysetValue>, "<lastId>"]. Key holds the keyset value as text: a number's decimal form exactly as
// sent (compared as numeric in SQL, so 27 and 27.0 are the same cursor), or the string.
type Cursor struct {
	Sort   string
	Key    string
	LastID string
}

// DecodeCursor checks a cursor against the expected sort. A malformed cursor, or one made for another sort, is a
// 400 invalid-cursor. raw == "" means no cursor.
func DecodeCursor(raw, sort string, kind KeyKind) (*Cursor, *Problem) {
	if raw == "" {
		return nil, nil
	}
	data, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(raw, "="))
	if err != nil {
		return nil, BadCursor("cursor is not base64url JSON")
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var parts []any
	if err := dec.Decode(&parts); err != nil || dec.More() {
		return nil, BadCursor("cursor is not base64url JSON")
	}
	if len(parts) != 4 {
		return nil, BadCursor("cursor has the wrong shape")
	}
	if v, ok := parts[0].(json.Number); !ok || !isOne(string(v)) {
		return nil, BadCursor("unknown cursor version")
	}
	if s, ok := parts[1].(string); !ok || s != sort {
		return nil, BadCursor("cursor was made for another sort")
	}
	c := &Cursor{Sort: sort}
	switch kind {
	case KeyNumber:
		n, ok := parts[2].(json.Number)
		if !ok {
			return nil, BadCursor("cursor keyset must be a number")
		}
		c.Key = string(n)
	case KeyString:
		s, ok := parts[2].(string)
		if !ok {
			return nil, BadCursor("cursor keyset must be a string")
		}
		c.Key = s
	case KeyTimestamp:
		s, ok := parts[2].(string)
		if !ok {
			return nil, BadCursor("cursor keyset must be an RFC 3339 timestamp")
		}
		if _, err := time.Parse(time.RFC3339, s); err != nil {
			return nil, BadCursor("cursor keyset must be an RFC 3339 timestamp")
		}
		c.Key = s
	}
	last, ok := parts[3].(string)
	if !ok || last == "" || len([]rune(last)) > 64 {
		return nil, BadCursor("cursor id must be a string")
	}
	c.LastID = last
	return c, nil
}

func isOne(s string) bool {
	f, err := strconv.ParseFloat(s, 64)
	return err == nil && f == 1
}

// EncodeCursor makes the cursor for the page after the row with keyset value key and id lastID. Numbers are written
// in their shortest form.
func EncodeCursor(sort string, kind KeyKind, key, lastID string) string {
	var w jsonw.W
	w.Arr().Int(1).Str(sort)
	if kind == KeyNumber {
		w.Raw(jsonw.Tidy(key))
	} else {
		w.Str(key)
	}
	w.Str(lastID).EndArr()
	return base64.RawURLEncoding.EncodeToString(w.Bytes())
}
