package web

import (
	"strings"

	"github.com/abrycta/typhoon-replay/api/go/internal/jsonw"
)

// ProblemType is one of the contract's stable problem codes with its fixed status and title (CONTRACT-GUIDE §8).
type ProblemType struct {
	Status int
	Code   string
	Title  string
}

var (
	Validation           = ProblemType{400, "validation", "Request validation failed"}
	InvalidCursor        = ProblemType{400, "invalid-cursor", "Invalid cursor"}
	NotFound             = ProblemType{404, "not-found", "Not found"}
	MethodNotAllowed     = ProblemType{405, "method-not-allowed", "Method not allowed"}
	NotAcceptable        = ProblemType{406, "not-acceptable", "Not acceptable"}
	PayloadTooLarge      = ProblemType{413, "payload-too-large", "Payload too large"}
	UnsupportedMediaType = ProblemType{415, "unsupported-media-type", "Unsupported media type"}
	RateLimited          = ProblemType{429, "rate-limited", "Too many requests"}
	Internal             = ProblemType{500, "internal", "Internal server error"}
	NotReady             = ProblemType{503, "not-ready", "Service not ready"}
	StreamCapacity       = ProblemType{503, "stream-capacity", "Too many live streams"}
)

// TypeBase is the problem `type` URI base (contract 2.0.2).
const TypeBase = "https://replay.krtmtthw.dev/problems/"

// FieldProblem is one entry of a problem's `errors`: where the bad input was, and why.
type FieldProblem struct {
	Pointer string
	Detail  string
}

// Problem is any failure that reaches the client as an RFC 9457 document.
type Problem struct {
	Type    ProblemType
	Detail  string
	Errors  []FieldProblem
	Headers map[string]string
}

func (p *Problem) Error() string { return p.Type.Code + ": " + p.Detail }

// Invalid is a 400 validation problem for one input.
func Invalid(pointer, detail string) *Problem {
	return &Problem{Type: Validation, Detail: strings.TrimPrefix(pointer, "#/") + " " + detail,
		Errors: []FieldProblem{{pointer, detail}}}
}

// BadCursor is a 400 invalid-cursor problem.
func BadCursor(detail string) *Problem {
	return &Problem{Type: InvalidCursor, Detail: detail, Errors: []FieldProblem{{"#/query/cursor", detail}}}
}

// Missing is a 404 not-found problem.
func Missing(detail string) *Problem { return &Problem{Type: NotFound, Detail: detail} }

// body renders the problem document (optional members omitted).
func (p *Problem) body(instance, requestID string) []byte {
	var w jsonw.W
	w.Obj().S("type", TypeBase+p.Type.Code).S("title", p.Type.Title).Key("status").Int(int64(p.Type.Status))
	if strings.TrimSpace(p.Detail) != "" {
		w.S("detail", p.Detail)
	}
	w.S("instance", instance).S("code", p.Type.Code).S("requestId", requestID)
	if len(p.Errors) > 0 {
		w.Key("errors").Arr()
		for i, e := range p.Errors {
			if i == 50 {
				break
			}
			w.Obj().S("pointer", e.Pointer).S("detail", e.Detail).End()
		}
		w.EndArr()
	}
	w.End()
	return w.Bytes()
}
