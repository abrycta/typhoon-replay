package app

import (
	"net/http"

	"github.com/abrycta/typhoon-replay/api/go/internal/api"
	"github.com/abrycta/typhoon-replay/api/go/internal/jsonw"
	"github.com/abrycta/typhoon-replay/api/go/internal/neon"
	"github.com/abrycta/typhoon-replay/api/go/internal/web"
)

const metaSQL = `SELECT (SELECT max(version) FROM public.schema_migrations) AS schema_version, ` +
	`coalesce((SELECT version FROM catalog.current_dataset_version), 0) AS dataset_version`

// bundleETag is W/"c{contractVersion}-{impl}-{implVersion}" (CONTRACT-GUIDE §6).
func (s *Server) bundleETag() string {
	id := s.cfg.ID
	return `W/"c` + id.ContractVersion + "-" + id.Impl + "-" + id.ImplVersion + `"`
}

// GetHealth: liveness, no database access.
func (s *Server) GetHealth(w http.ResponseWriter, r *http.Request) {
	var b jsonw.W
	b.Obj().S("status", "ok").S("impl", s.cfg.ID.Impl).End()
	ctxOf(r).Send(http.StatusOK, "application/json; charset=utf-8", b.Bytes(), nil)
}

// GetReadiness: the database answers and its schema is at least minSchemaVersion.
func (s *Server) GetReadiness(w http.ResponseWriter, r *http.Request) {
	c := ctxOf(r)
	res, err := s.read(c, neon.Q(metaSQL))
	applied := ""
	if err == nil {
		applied = res[0].At(0).S("schema_version")
	} else {
		logError(c, err)
	}
	if applied == "" || applied < s.cfg.MinSchemaVersion {
		detail := "Database unreachable or not migrated."
		if applied != "" {
			detail = "Database schema is older than " + s.cfg.MinSchemaVersion + "."
		}
		c.Fail(&web.Problem{Type: web.NotReady, Detail: detail, Headers: map[string]string{"Retry-After": "5"}})
		return
	}
	var b jsonw.W
	b.Obj().S("status", "ready").S("impl", s.cfg.ID.Impl).S("schemaVersion", applied).
		S("minSchemaVersion", s.cfg.MinSchemaVersion).End()
	c.Send(http.StatusOK, "application/json; charset=utf-8", b.Bytes(), nil)
}

// GetMeta: the ETag carries the dataset version, since the body does (contract 2.0.1).
func (s *Server) GetMeta(w http.ResponseWriter, r *http.Request, p api.GetMetaParams) {
	c := ctxOf(r)
	res, err := s.read(c, neon.Q(metaSQL))
	if err != nil {
		fail(c, err)
		return
	}
	row := res[0].At(0)
	version := row.S("dataset_version")
	tag := s.bundleETag()
	etag := tag[:len(tag)-1] + "-d" + version + `"`
	if web.ETagMatches(c.IfNoneMatch, etag) {
		c.NotModified(etag)
		return
	}
	schema := row.S("schema_version")
	if schema == "" {
		schema = "00000000000000"
	}
	id := s.cfg.ID
	var b jsonw.W
	b.Obj().S("impl", id.Impl).S("implVersion", id.ImplVersion).S("contractVersion", id.ContractVersion).
		S("schemaVersion", schema).N("datasetVersion", version).S("commit", s.cfg.Commit).S("startedAt", s.startedAt).End()
	c.Send(http.StatusOK, "application/json; charset=utf-8", b.Bytes(), map[string]string{"ETag": etag})
}

// GetOpenApiDocument: the contract bundle byte for byte.
func (s *Server) GetOpenApiDocument(w http.ResponseWriter, r *http.Request, p api.GetOpenApiDocumentParams) {
	c := ctxOf(r)
	etag := s.bundleETag()
	if web.ETagMatches(c.IfNoneMatch, etag) {
		c.NotModified(etag)
		return
	}
	c.Send(http.StatusOK, "application/json; charset=utf-8", s.cfg.OpenAPI, map[string]string{"ETag": etag})
}
