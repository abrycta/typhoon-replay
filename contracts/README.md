# contracts/

The shared contract every backend (Java, Node, Rust, Go) and the web app build on. Rules: [`docs/CONTRACT-GUIDE.md`](docs/CONTRACT-GUIDE.md).

| Path | What |
|---|---|
| `openapi/` | OpenAPI 3.1 source, split YAML: `openapi.yaml` (root), `paths/`, `components/{schemas,parameters,responses,headers,examples}` |
| `redocly.yaml`, `redocly/portable-subset.js` | Lint config and the custom rules that enforce the portable subset |
| `scripts/bundle.mjs` | Builds `dist/openapi.json` (3.1, served at `GET /v1/openapi.json`) and `dist/openapi.3.0.json` (for generators that need 3.0) |
| `scripts/oasdiff-check.sh` | Breaking-change gate against a base ref |
| `db/migrations/` | dbmate migrations (plain SQL, up/down). Applied by CI and `just`, never by a backend |
| `db/seed/` | Deterministic fixture (9 storms incl. Haiyan/Yolanda, 10 places incl. Tacloban and Naha, 2 users, 1 live storm) |
| `conformance/` | Language-neutral conformance suite: Schemathesis configs, Vitest scenarios, compat-table script |
| `mock/` | Mocking the API for `web/` (Prism + MSW) |
| `CHANGELOG.md` | Contract versions |

Everything runs through the root `justfile`:

```sh
just install          # npm ci in contracts/
just lint-contract    # Redocly lint with the portable-subset rules
just bundle           # dist/openapi.json + dist/openapi.3.0.json
just oasdiff          # breaking changes vs origin/main
just db-up            # PostGIS + migrations + seed (Docker)
just mock             # Prism on :4010
just conformance java # scenarios + Schemathesis against a backend (or IMPL=java)
```

Generators read `dist/`, never the split YAML: oapi-codegen (strict server) and openapi-typescript take `openapi.json`;
openapi-generator `spring` takes either; typify takes `components.schemas` as JSON Schema `$defs`. Run openapi-typescript
from outside `contracts/`, because it otherwise picks up `redocly.yaml` as its own config.
