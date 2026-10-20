# Contract changelog

Semver of `info.version` in `openapi/openapi.yaml` (CONTRACT-GUIDE §2). Minor = additive, patch = docs/examples,
major = a new `/vN` path prefix. `scripts/oasdiff-check.sh` writes the machine changelog to `dist/changelog.md`.

## 1.0.0 (2026-10-21)

First version: meta and probes, storm catalogue (list/search, detail, best track, places hit), places
(search, nearest, detail, storms that hit a place or point), live snapshot and SSE stream, OAuth2 sign-in
(Google, GitHub), the signed-in user, saved places, alert preferences and one-click unsubscribe.
Database schema `20261021000500`.
