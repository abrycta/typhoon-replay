// Package neon runs SQL over Neon's serverless HTTP endpoint (POST https://{host}/sql): one HTTPS request per
// transaction, no connection held between requests. A Worker cannot keep a pgx pool, and pgx does not build under
// TinyGo, so this replaces pgx + pgxpool from the recorded Go stack (docs/architecture/DECISIONS.md).
//
// Every call is a batch: Neon runs the statements of one request in a single transaction, read-only unless asked
// otherwise, and each batch starts with SET LOCAL statement_timeout (CONTRACT-GUIDE §11: 5 s; no session state).
// Values come back as Postgres text (Neon-Raw-Text-Output), so numbers keep their exact decimal form.
package neon

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"
)

// Client talks to one database.
type Client struct {
	endpoint string
	connStr  string
}

// New builds a client from DATABASE_URL. endpoint overrides the HTTP endpoint (local runs and CI use Neon's
// open-source proxy, e.g. http://localhost:4444/sql); by default it is https://{host}/sql.
func New(databaseURL, endpoint string) (*Client, error) {
	if databaseURL == "" {
		return nil, errors.New("DATABASE_URL is not set")
	}
	if endpoint == "" {
		u, err := url.Parse(databaseURL)
		if err != nil || u.Hostname() == "" {
			return nil, errors.New("DATABASE_URL is not a postgres URL")
		}
		endpoint = "https://" + u.Hostname() + "/sql"
	}
	return &Client{endpoint: endpoint, connStr: databaseURL}, nil
}

// Query is one statement with its parameters ($1, $2, ...). A nil parameter is SQL NULL.
type Query struct {
	SQL    string
	Params []*string
}

// Q builds a Query; parameters are passed as text and cast in SQL where the type matters.
func Q(sql string, params ...any) Query {
	q := Query{SQL: sql}
	for _, p := range params {
		q.Params = append(q.Params, param(p))
	}
	return q
}

func param(p any) *string {
	var s string
	switch v := p.(type) {
	case nil:
		return nil
	case *string:
		return v
	case string:
		s = v
	case int:
		s = strconv.Itoa(v)
	case int64:
		s = strconv.FormatInt(v, 10)
	case *int:
		if v == nil {
			return nil
		}
		s = strconv.Itoa(*v)
	default:
		panic("neon: unsupported parameter type")
	}
	return &s
}

// Rows is one statement's result: column names and text values (nil = NULL).
type Rows struct {
	Fields []string
	Data   [][]*string
	index  map[string]int
}

// Row is one row of a result.
type Row struct {
	rows *Rows
	vals []*string
}

// Len is the number of rows.
func (r *Rows) Len() int { return len(r.Data) }

// At returns row i.
func (r *Rows) At(i int) Row { return Row{rows: r, vals: r.Data[i]} }

func (r *Rows) col(name string) int {
	if r.index == nil {
		r.index = make(map[string]int, len(r.Fields))
		for i, f := range r.Fields {
			r.index[f] = i
		}
	}
	i, ok := r.index[name]
	if !ok {
		panic("neon: no column " + name)
	}
	return i
}

// N returns a nullable column.
func (row Row) N(name string) *string { return row.vals[row.rows.col(name)] }

// S returns a column that is never NULL ("" if it is).
func (row Row) S(name string) string {
	if v := row.N(name); v != nil {
		return *v
	}
	return ""
}

// I returns an integer column (0 if NULL or not a number).
func (row Row) I(name string) int64 {
	n, _ := strconv.ParseInt(row.S(name), 10, 64)
	return n
}

// B returns a boolean column (Postgres text "t"/"f").
func (row Row) B(name string) bool { return row.S(name) == "t" }

// Error is a failed request. Unavailable errors (network, a compute still resuming, connection limits) map to
// 503 not-ready; the others are 500 internal.
type Error struct {
	Status      int
	Code        string // SQLSTATE, when Postgres answered
	Message     string
	Unavailable bool
}

func (e *Error) Error() string {
	return "neon: " + strconv.Itoa(e.Status) + " " + e.Code + " " + e.Message
}

// IsUnavailable reports whether err means "the database can't be reached right now".
func IsUnavailable(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Unavailable
}

const timeoutStatement = "SET LOCAL statement_timeout = 5000"

// Read runs the queries in one read-only transaction and returns one result per query.
func (c *Client) Read(ctx context.Context, queries ...Query) ([]*Rows, error) {
	return c.batch(ctx, true, queries)
}

// Write runs the queries in one read-write transaction (the test hook only).
func (c *Client) Write(ctx context.Context, queries ...Query) ([]*Rows, error) {
	return c.batch(ctx, false, queries)
}

type wireQuery struct {
	Query  string    `json:"query"`
	Params []*string `json:"params"`
}

type wireResult struct {
	Fields []struct {
		Name string `json:"name"`
	} `json:"fields"`
	Rows [][]*string `json:"rows"`
}

type wireBatch struct {
	Results []wireResult `json:"results"`
}

type wireError struct {
	Message string `json:"message"`
	Code    string `json:"code"`
}

func (c *Client) batch(ctx context.Context, readOnly bool, queries []Query) ([]*Rows, error) {
	wire := make([]wireQuery, 0, len(queries)+1)
	wire = append(wire, wireQuery{Query: timeoutStatement, Params: []*string{}})
	for _, q := range queries {
		params := q.Params
		if params == nil {
			params = []*string{}
		}
		wire = append(wire, wireQuery{Query: q.SQL, Params: params})
	}
	body, err := json.Marshal(struct {
		Queries []wireQuery `json:"queries"`
	}{wire})
	if err != nil {
		return nil, err
	}
	headers := map[string]string{
		"Content-Type":               "application/json",
		"Neon-Connection-String":     c.connStr,
		"Neon-Raw-Text-Output":       "true",
		"Neon-Array-Mode":            "true",
		"Neon-Batch-Read-Only":       strconv.FormatBool(readOnly),
		"Neon-Batch-Isolation-Level": "ReadCommitted",
	}
	status, resp, err := post(ctx, c.endpoint, headers, body)
	if err != nil {
		return nil, &Error{Message: err.Error(), Unavailable: true}
	}
	if status != 200 {
		var we wireError
		_ = json.Unmarshal(resp, &we)
		return nil, &Error{Status: status, Code: we.Code, Message: we.Message, Unavailable: unavailable(status, we.Code)}
	}
	var out wireBatch
	if err := json.Unmarshal(resp, &out); err != nil {
		return nil, &Error{Status: status, Message: "bad response: " + err.Error()}
	}
	if len(out.Results) != len(wire) {
		return nil, &Error{Status: status, Message: "unexpected result count"}
	}
	rows := make([]*Rows, len(queries))
	for i, r := range out.Results[1:] {
		fields := make([]string, len(r.Fields))
		for j, f := range r.Fields {
			fields[j] = f.Name
		}
		rows[i] = &Rows{Fields: fields, Data: r.Rows}
	}
	return rows, nil
}

// unavailable: the proxy could not reach a compute (5xx, rate limits) or Postgres refused the connection
// (class 08 connection exceptions, 53300 too many connections, 57P0x shutdown/cannot connect now).
func unavailable(status int, code string) bool {
	if status >= 500 || status == 429 {
		return true
	}
	return strings.HasPrefix(code, "08") || code == "53300" || strings.HasPrefix(code, "57P0")
}
