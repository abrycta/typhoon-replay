# syntax=docker/dockerfile:1.10
# Replay Go backend. Build context: the repository root (the contract lives in contracts/):
#   docker build -f api/go/Dockerfile -t typhoon-replay-go .
# Stages: bundle the contract -> static Go binary (the bundle embedded) -> distroless runtime (nonroot, ~10 MB).
# Frozen showcase (docs/architecture/DECISIONS.md): base images pinned by digest, the toolchain by the go directive
# and the image tag, dependencies by go.sum.

# --- 1. The contract bundle (contracts/dist/openapi.json), generated from the split YAML -----------------------
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS contract
WORKDIR /contracts
COPY contracts/package.json contracts/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY contracts/ ./
RUN npm run bundle

# --- 2. Build ------------------------------------------------------------------------------------------------
FROM golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf AS build
WORKDIR /src
COPY api/go/go.mod api/go/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY api/go/ ./
COPY --from=contract /contracts/dist/openapi.json ./contract/openapi.json
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# --- 3. Runtime ----------------------------------------------------------------------------------------------
FROM gcr.io/distroless/static-debian13@sha256:1a64f46364620465ef9e9a8f5413757dfdf22695e050bbfd7303eeaf17a59383
COPY --from=build /out/server /server
USER nonroot:nonroot
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/server"]
