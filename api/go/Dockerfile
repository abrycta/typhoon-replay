# syntax=docker/dockerfile:1.10
# Replay Go backend. Build context: the repository root (the contract lives in contracts/):
#   docker build -f api/go/Dockerfile -t typhoon-replay-go .
# Stages: bundle the contract -> static Go binary (the bundle embedded) -> distroless runtime (nonroot, ~10 MB).
# Frozen showcase (docs/architecture/DECISIONS.md): base images pinned by digest, the toolchain by the go directive
# and the image tag, dependencies by go.sum.

# --- 1. The contract bundle (contracts/dist/openapi.json), generated from the split YAML -----------------------
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS contract
WORKDIR /contracts
COPY contracts/package.json contracts/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY contracts/ ./
RUN npm run bundle

# --- 2. Build ------------------------------------------------------------------------------------------------
FROM golang:1.27.3-alpine@sha256:f2c872bcee949b7be9c490efd02b48a8a2fbf947cdf533f1c58525ec9d8170fd AS build
WORKDIR /src
COPY api/go/go.mod api/go/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY api/go/ ./
COPY --from=contract /contracts/dist/openapi.json ./contract/openapi.json
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# --- 3. Runtime ----------------------------------------------------------------------------------------------
FROM gcr.io/distroless/static-debian12@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/server /server
USER nonroot:nonroot
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["/server"]
