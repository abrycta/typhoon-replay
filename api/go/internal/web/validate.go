package web

import (
	"strconv"
	"unicode/utf8"

	"github.com/abrycta/typhoon-replay/api/go/internal/api"
)

// Parameter checks the contract states in its schemas (min/max, enums, patterns, lengths). The generated wrapper
// binds types; these enforce the rest, with the same pointers the Java reference uses.

// IntRange checks an optional integer parameter.
func IntRange(name string, v *int, min, max int) *Problem {
	if v != nil && (*v < min || *v > max) {
		return Invalid("#/query/"+name, "must be between "+strconv.Itoa(min)+" and "+strconv.Itoa(max))
	}
	return nil
}

// Length checks an optional string parameter's length in characters (code points, as JSON Schema counts).
func Length(name string, v *string, min, max int) *Problem {
	if v != nil {
		if n := utf8.RuneCountInString(*v); n < min || n > max {
			return Invalid("#/query/"+name, "length must be between "+strconv.Itoa(min)+" and "+strconv.Itoa(max))
		}
	}
	return nil
}

// Cursor checks the cursor pattern ^[A-Za-z0-9_-]{1,512}$.
func CursorShape(v *string) *Problem {
	if v == nil {
		return nil
	}
	s := *v
	if len(s) < 1 || len(s) > 512 || !isBase64URL(s) {
		return Invalid("#/query/cursor", "must match ^[A-Za-z0-9_-]{1,512}$")
	}
	return nil
}

func isBase64URL(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// Radius checks the RadiusKm enum and returns the value (default 200).
func Radius(v *api.RadiusKm) (int, *Problem) {
	if v == nil {
		return 200, nil
	}
	if !v.Valid() {
		return 0, Invalid("#/query/radiusKm", "must be one of 50, 100, 200, 300, 500")
	}
	return int(*v), nil
}

// Country checks the CountryCode enum.
func Country(v *api.CountryCode) (*string, *Problem) {
	if v == nil {
		return nil, nil
	}
	if !v.Valid() {
		return nil, Invalid("#/query/country", "must be one of PH, JP")
	}
	s := string(*v)
	return &s, nil
}

// Limit returns the page size (default def, 1..max).
func Limit(v *int, def, max int) (int, *Problem) {
	if v == nil {
		return def, nil
	}
	if p := IntRange("limit", v, 1, max); p != nil {
		return 0, p
	}
	return *v, nil
}

// SidShape checks ^[0-9]{7}[NS][0-9]{5}$.
func SidShape(s string) bool {
	if len(s) != 13 {
		return false
	}
	for i := 0; i < 13; i++ {
		c := s[i]
		if i == 7 {
			if c != 'N' && c != 'S' {
				return false
			}
		} else if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// PlaceIDShape checks ^(PH-[0-9]{10}|JP-[0-9]{5})$.
func PlaceIDShape(s string) bool {
	var digits int
	switch {
	case len(s) == 13 && s[:3] == "PH-":
		digits = 10
	case len(s) == 8 && s[:3] == "JP-":
		digits = 5
	default:
		return false
	}
	for i := 3; i < 3+digits; i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// Coordinate parses a lat/lon parameter as a plain decimal (optionally with an exponent), within [-limit, limit].
// The text is returned for SQL, so no float32 rounding happens on the way.
func Coordinate(c *Ctx, name string, limit float64) (string, *Problem) {
	raw, ok := c.First(name)
	if !ok {
		return "", Invalid("#/query/"+name, "is required")
	}
	if !isDecimal(raw) {
		return "", Invalid("#/query/"+name, "must be a number")
	}
	f, err := strconv.ParseFloat(raw, 64)
	if err != nil || f < -limit || f > limit {
		return "", Invalid("#/query/"+name, "must be between -"+strconv.Itoa(int(limit))+" and "+strconv.Itoa(int(limit)))
	}
	return strconv.FormatFloat(f, 'g', -1, 64), nil
}

// isDecimal: [+-]? (digits [. digits?] | . digits) ([eE] [+-]? digits)?
func isDecimal(s string) bool {
	i := 0
	if i < len(s) && (s[i] == '+' || s[i] == '-') {
		i++
	}
	digits := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
		digits++
	}
	if i < len(s) && s[i] == '.' {
		i++
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
			digits++
		}
	}
	if digits == 0 {
		return false
	}
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		i++
		if i < len(s) && (s[i] == '+' || s[i] == '-') {
			i++
		}
		exp := 0
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
			exp++
		}
		if exp == 0 {
			return false
		}
	}
	return i == len(s)
}
