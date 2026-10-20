-- migrate:up

-- PostGIS for geography columns and spatial indexes; pg_trgm for name search
-- (case-insensitive substring match on storm and place names, incl. PAGASA and Japanese names).
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- One schema per ownership area (CONTRACT-GUIDE §0, SYSTEM-ARCHITECTURE-RESEARCH §3.3).
CREATE SCHEMA catalog;
COMMENT ON SCHEMA catalog IS 'Read models loaded by the pipeline (COPY -> catalog_next -> per-table swap). Backends only read.';
CREATE SCHEMA live;
COMMENT ON SCHEMA live IS 'Active storms and the live event log. Written only by the ingestion job (and the TR_TEST_HOOKS test hook).';
CREATE SCHEMA auth;
COMMENT ON SCHEMA auth IS 'Users, provider identities, the shared language-neutral session table and OAuth flow state.';
CREATE SCHEMA app;
COMMENT ON SCHEMA app IS 'User data: saved places, alert subscriptions, the alert outbox.';
CREATE SCHEMA ops;
COMMENT ON SCHEMA ops IS 'Job coordination (lease rows; no session-level advisory locks through the Neon pooler).';

-- migrate:down

DROP SCHEMA ops;
DROP SCHEMA app;
DROP SCHEMA auth;
DROP SCHEMA live;
DROP SCHEMA catalog;
DROP EXTENSION IF EXISTS pg_trgm;
DROP EXTENSION IF EXISTS postgis;
