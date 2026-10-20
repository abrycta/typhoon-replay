# Single entry point for local dev and CI. `just` lists the recipes.
# Needs: just, Docker (compose v2), Node 24. Python only for `seed-regen`.

set shell := ["bash", "-euo", "pipefail", "-c"]
set dotenv-load := false

compose := "docker compose"
contracts := "contracts"
# Host ports of the backends once they exist (compose.yaml).
port_java := "8081"
port_node := "8082"
port_rust := "8083"
port_go := "8084"
port_mock := "4010"
site_origin := "http://localhost:8788"
st_image := "schemathesis/schemathesis:stable"

default:
    @just --list --unsorted

# --- contract -----------------------------------------------------------------

# Install the contract tooling (Redocly, Prism, Vitest, ...)
install:
    npm --prefix {{ contracts }} ci

# Lint the split OpenAPI source with the portable-subset rules
lint-contract:
    npm --prefix {{ contracts }} run lint

# Bundle to contracts/dist/openapi.json (3.1) and openapi.3.0.json
bundle:
    npm --prefix {{ contracts }} run bundle

# Fail on breaking changes against a base ref (default origin/main)
oasdiff base="origin/main": bundle
    {{ contracts }}/scripts/oasdiff-check.sh {{ base }}

# Serve the bundled contract with Prism on :4010 (examples; SSE is mocked by MSW in web/)
mock: bundle
    {{ compose }} --profile mock up -d prism
    @echo "Prism: http://localhost:{{ port_mock }}/v1/storms"

# --- database -----------------------------------------------------------------

# Start PostGIS, apply migrations and load the fixture seed
db-up:
    {{ compose }} --profile db up -d db
    {{ compose }} --profile db run --rm migrate up
    just seed

# Apply pending migrations
migrate:
    {{ compose }} --profile db run --rm migrate up

# Roll back the newest migration
rollback:
    {{ compose }} --profile db run --rm migrate rollback

# Every migration up, all the way down, and up again (what CI runs)
migrate-check:
    {{ compose }} --profile db up -d db
    {{ compose }} --profile db run --rm migrate up
    for f in {{ contracts }}/db/migrations/*.sql; do {{ compose }} --profile db run --rm -q migrate rollback; done
    {{ compose }} exec -T db psql -U tr -d typhoon -v ON_ERROR_STOP=1 -Atc "select 'schemas left: ' || count(*) from pg_namespace where nspname in ('catalog','live','auth','app','ops')"
    {{ compose }} --profile db run --rm migrate up

# (Re)load the deterministic fixture (wipes catalogue and live data)
seed:
    {{ compose }} --profile db run --rm -q seed

# Regenerate contracts/db/seed/10_storms.sql from the pipeline's IBTrACS Parquet
seed-regen:
    pipeline/.venv/bin/python {{ contracts }}/db/seed/build_seed.py

# psql into the local database
psql:
    {{ compose }} exec db psql -U tr -d typhoon

# Drop the local database volume and start again
db-reset:
    {{ compose }} --profile db down -v
    just db-up

# --- side services ------------------------------------------------------------

# Mailpit SMTP sink (UI on :8025)
mail:
    {{ compose }} --profile mail up -d mailpit

# --- backends -----------------------------------------------------------------

# Java backend (api/java) in Docker on :8081, with PostGIS and the seed: then `just conformance java`
java-run: bundle db-up
    nice -n 15 {{ compose }} --profile java up -d --build api-java
    for i in $(seq 1 120); do curl -fsS -o /dev/null http://localhost:{{ port_java }}/readyz && break; sleep 1; done
    @echo "Java: http://localhost:{{ port_java }}/v1/meta"

# Java backend from source (Gradle, JDK 25 toolchain) against the compose database; Ctrl-C to stop
java-dev: bundle db-up
    cd api/java && SPRING_PROFILES_ACTIVE=local TR_TEST_HOOKS=1 PORT={{ port_java }} nice -n 15 ./gradlew bootRun

# Java unit, slice and Testcontainers tests (PostGIS 18, contract migrations + seed)
java-test: bundle
    cd api/java && nice -n 15 ./gradlew test

# --- conformance --------------------------------------------------------------

# Scenario suite + Schemathesis against one backend: `just conformance java` or `just conformance IMPL=java`
conformance impl="java": bundle
    #!/usr/bin/env bash
    set -euo pipefail
    impl="{{ impl }}"; impl="${impl#IMPL=}"
    case "$impl" in
      java) port={{ port_java }} ;; node) port={{ port_node }} ;; rust) port={{ port_rust }} ;; go) port={{ port_go }} ;;
      mock) port={{ port_mock }} ;;
      *) echo "IMPL must be java|node|rust|go|mock" >&2; exit 2 ;;
    esac
    base="${BASE_URL:-http://localhost:$port}"
    mkdir -p {{ contracts }}/conformance/results
    for i in $(seq 1 120); do curl -fsS -o /dev/null "$base/readyz" && break; sleep 1; done # cold starts, Prism reloads
    curl -fsS "$base/v1/meta" > "{{ contracts }}/conformance/results/$impl-meta.json" || true
    BASE_URL="$base" IMPL="$impl" SITE_ORIGIN={{ site_origin }} npm --prefix {{ contracts }} run conformance || status=$?
    if [ "$impl" = mock ]; then config=prism-smoke.toml; else config=backend.toml; fi
    docker run --rm --network host -e BASE_URL="$base" -e TR_SITE_ORIGIN={{ site_origin }} \
      -v "$PWD/{{ contracts }}:/c" -w /c/conformance/results {{ st_image }} \
      --config-file /c/conformance/schemathesis/$config run /c/dist/openapi.json \
      --report junit --report-junit-path "/c/conformance/results/$impl-schemathesis.xml" || status=$?
    exit "${status:-0}"

# Schemathesis smoke test of the spec against Prism (what contracts.yml runs)
schemathesis-smoke: mock
    docker run --rm --network host -e BASE_URL=http://localhost:{{ port_mock }} -v "$PWD/{{ contracts }}:/c:ro" -w /tmp {{ st_image }} \
      --config-file /c/conformance/schemathesis/prism-smoke.toml run /c/dist/openapi.json --wait-for-schema 30

# Render the compatibility table from contracts/conformance/results
compat-table:
    npm --prefix {{ contracts }} run compat-table

# Stop everything and delete local volumes
down:
    {{ compose }} --profile all down -v --remove-orphans
