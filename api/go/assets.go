// Package replay embeds the files the Go backend serves or reports: impl.json (its version and contract claim) and
// the contract bundle, copied from contracts/dist/openapi.json into contract/ by `npm run build` (gitignored).
package replay

import (
	_ "embed"
	"encoding/json"
)

//go:embed impl.json
var implJSON []byte

//go:embed contract/openapi.json
var OpenAPI []byte

// Impl is impl.json.
type Impl struct {
	Impl             string `json:"impl"`
	ImplVersion      string `json:"implVersion"`
	MinSchemaVersion string `json:"minSchemaVersion"`
}

// ReadImpl parses impl.json and the contract version (the bundle's info.version).
func ReadImpl() (Impl, string) {
	var impl Impl
	_ = json.Unmarshal(implJSON, &impl)
	var bundle struct {
		Info struct {
			Version string `json:"version"`
		} `json:"info"`
	}
	_ = json.Unmarshal(OpenAPI, &bundle)
	return impl, bundle.Info.Version
}
