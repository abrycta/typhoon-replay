// Package jsonw writes JSON by appending to a byte slice: no reflection, so it stays cheap under TinyGo, where
// encoding/json is slow. Members whose value is unknown are omitted, never written as null (CONTRACT-GUIDE §1).
package jsonw

import (
	"strconv"
	"unicode/utf8"
)

// W builds one JSON document. The zero value is ready to use.
type W struct {
	b        []byte
	more     []bool // per open container: a member was already written, so the next one needs a comma
	afterKey bool   // a member name was just written: its value needs no comma
}

// Bytes returns the document written so far.
func (w *W) Bytes() []byte { return w.b }

// sep runs before every value and member name: a comma between siblings, none right after a member name.
func (w *W) sep() {
	if w.afterKey {
		w.afterKey = false
		return
	}
	if n := len(w.more); n > 0 {
		if w.more[n-1] {
			w.b = append(w.b, ',')
		}
		w.more[n-1] = true
	}
}

// Obj opens an object (as a value: after Key, inside an array, or at the top).
func (w *W) Obj() *W {
	w.sep()
	w.b = append(w.b, '{')
	w.more = append(w.more, false)
	return w
}

// Arr opens an array.
func (w *W) Arr() *W {
	w.sep()
	w.b = append(w.b, '[')
	w.more = append(w.more, false)
	return w
}

// End closes the innermost object.
func (w *W) End() *W {
	w.more = w.more[:len(w.more)-1]
	w.b = append(w.b, '}')
	return w
}

// EndArr closes the innermost array.
func (w *W) EndArr() *W {
	w.more = w.more[:len(w.more)-1]
	w.b = append(w.b, ']')
	return w
}

// Key writes a member name; the next call writes its value.
func (w *W) Key(k string) *W {
	w.sep()
	w.b = appendString(w.b, k)
	w.b = append(w.b, ':')
	w.afterKey = true
	return w
}

// Str writes a string value.
func (w *W) Str(s string) *W {
	w.sep()
	w.b = appendString(w.b, s)
	return w
}

// Raw writes an already encoded JSON value (a number from the database, a JSON column).
func (w *W) Raw(s string) *W {
	w.sep()
	w.b = append(w.b, s...)
	return w
}

// Int writes an integer.
func (w *W) Int(n int64) *W {
	w.sep()
	w.b = strconv.AppendInt(w.b, n, 10)
	return w
}

// Bool writes true or false.
func (w *W) Bool(v bool) *W {
	w.sep()
	w.b = strconv.AppendBool(w.b, v)
	return w
}

// Member helpers: write "key": value, or nothing when the value is absent.

// S writes a string member.
func (w *W) S(k, v string) *W { return w.Key(k).Str(v) }

// OptS writes a string member when v is not nil.
func (w *W) OptS(k string, v *string) *W {
	if v != nil {
		w.Key(k).Str(*v)
	}
	return w
}

// N writes a numeric member from its decimal text (already tidy, see Tidy).
func (w *W) N(k, v string) *W { return w.Key(k).Raw(v) }

// OptN writes a numeric member when v is not nil, without trailing zeros.
func (w *W) OptN(k string, v *string) *W {
	if v != nil {
		w.Key(k).Raw(Tidy(*v))
	}
	return w
}

// Tidy drops trailing fractional zeros from a decimal ("11.0000" → "11", "12.40" → "12.4", "-0.0" → "0"), the
// shortest form the contract asks for. Exponent forms are returned unchanged.
func Tidy(s string) string {
	dot := -1
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '.':
			dot = i
		case 'e', 'E':
			return s
		}
	}
	if dot >= 0 {
		end := len(s)
		for end > dot+1 && s[end-1] == '0' {
			end--
		}
		if end == dot+1 {
			end = dot
		}
		s = s[:end]
	}
	if s == "-0" {
		return "0"
	}
	return s
}

const hex = "0123456789abcdef"

func appendString(b []byte, s string) []byte {
	b = append(b, '"')
	start := 0
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			if c >= 0x20 && c != '"' && c != '\\' {
				i++
				continue
			}
			b = append(b, s[start:i]...)
			switch c {
			case '"':
				b = append(b, '\\', '"')
			case '\\':
				b = append(b, '\\', '\\')
			case '\n':
				b = append(b, '\\', 'n')
			case '\r':
				b = append(b, '\\', 'r')
			case '\t':
				b = append(b, '\\', 't')
			default:
				b = append(b, '\\', 'u', '0', '0', hex[c>>4], hex[c&0xF])
			}
			i++
			start = i
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			b = append(b, s[start:i]...)
			b = append(b, `�`...)
			i++
			start = i
			continue
		}
		// U+2028 and U+2029 are valid JSON but break JavaScript string literals; escape them like encoding/json.
		if r == ' ' || r == ' ' {
			b = append(b, s[start:i]...)
			b = append(b, '\\', 'u', '2', '0', '2', hex[r&0xF])
			i += size
			start = i
			continue
		}
		i += size
	}
	b = append(b, s[start:]...)
	return append(b, '"')
}

// String returns s as a JSON string literal.
func String(s string) string { return string(appendString(nil, s)) }
