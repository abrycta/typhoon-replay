# syntax=docker/dockerfile:1.10
# Replay Go backend. Build context: the repository root (the contract lives in contracts/):
#   docker build -f api/go/Dockerfile -t typhoon-replay-go .
# Stages: bundle the contract -> static Go binary (the bundle embedded) -> distroless runtime (nonroot, ~10 MB).
# Frozen showcase (docs/architecture/DECISIONS.md): base images pinned by digest, the toolchain by the go directive
# and the image tag, dependencies by go.sum.

# --- 1. The contract bundle (contracts/dist/openapi.json), generated from the split YAML -----------------------
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS contract
WORKDIR /contracts
COPY contracts/package.json contracts/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY contracts/ ./
RUN npm run bundle

# --- 2. Build ------------------------------------------------------------------------------------------------
FROM golang:1.27.3-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS build
WORKDIR /src
COPY api/go/go.mod api/go/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY api/go/ ./
COPY --from=contract /contracts/dist/openapi.json ./contract/openapi.json
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# --- 3. Runtime ----------------------------------------------------------------------------------------------
FROM gcr.io/distroless/static-debian13@sha256:448810357cc8e67b7208988abdba0f5ec3d3aebee0a5b13eb624979792cffc0f
COPY --from=build /out/server /server
USER nonroot:nonroot
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/server"]
