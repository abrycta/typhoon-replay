-- Contract 2.0.0: no account features (CONTRACT-GUIDE §14, DECISIONS.md "Update 2026-10-21").
-- Drops the users, OAuth identities and state, sessions, saved places, alert subscriptions, the alert outbox and the
-- email suppression list, with their trigger and function, and the now-empty auth and app schemas.
-- Earlier migrations stay as applied; `down` recreates everything exactly as 20261021000400 and 20261021000500 left
-- it, empty (the account data itself is not restored).

-- migrate:up

DROP TABLE app.alert_subscription_place;
DROP TABLE app.alert_subscription;
DROP TABLE app.alert_outbox;
DROP TABLE app.email_suppression;
DROP TRIGGER saved_place_limit ON app.saved_place;
DROP TABLE app.saved_place;
DROP FUNCTION app.enforce_saved_place_limit();
DROP TABLE auth.oauth_state;
DROP TABLE auth.session;
DROP TABLE auth.oauth_account;
DROP TABLE auth.app_user;
DROP SCHEMA app;
DROP SCHEMA auth;
-- No mailer any more: its lease row goes too.
DELETE FROM ops.job_lease WHERE job = 'mailer';

-- migrate:down

CREATE SCHEMA auth;
COMMENT ON SCHEMA auth IS 'Users, provider identities, the shared language-neutral session table and OAuth flow state.';
CREATE SCHEMA app;
COMMENT ON SCHEMA app IS 'User data: saved places, alert subscriptions, the alert outbox.';

-- As in 20261021000400_auth.sql

CREATE TABLE auth.app_user (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name   text        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  email          text,
  email_verified boolean     NOT NULL DEFAULT false,
  avatar_url     text,
  locale         text        CHECK (locale IN ('en','ja')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE auth.app_user IS 'An account. DELETE /v1/me deletes the row; identities, sessions, saved places and alert data cascade.';
COMMENT ON COLUMN auth.app_user.email IS 'Verified provider email used for alerts. Not unique: accounts are not linked by email.';

CREATE TABLE auth.oauth_account (
  provider       text        NOT NULL CHECK (provider IN ('google','github')),
  subject        text        NOT NULL,
  user_id        uuid        NOT NULL REFERENCES auth.app_user (id) ON DELETE CASCADE,
  email          text,
  email_verified boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
COMMENT ON TABLE auth.oauth_account IS 'Provider identity (Google sub / GitHub numeric id) -> user. Upserted on every callback. Provider tokens are never stored.';
CREATE INDEX oauth_account_user_idx ON auth.oauth_account (user_id);

CREATE TABLE auth.session (
  token_hash      bytea       PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  user_id         uuid        NOT NULL REFERENCES auth.app_user (id) ON DELETE CASCADE,
  data            jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(data) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  created_by_impl text        NOT NULL CHECK (created_by_impl IN ('java','node','rust','go','test')),
  user_agent      text        CHECK (length(user_agent) <= 512)
);
COMMENT ON TABLE auth.session IS
  'The shared, language-neutral session store (CONTRACT-GUIDE §9). Every backend uses a small custom store against this table; '
  'framework session serialisation (Spring Session JDBC, gob, ...) MUST NOT be used. '
  'Valid when revoked_at IS NULL AND expires_at > now(). Expired rows are purged by the maintenance job, not by backends.';
COMMENT ON COLUMN auth.session.token_hash IS 'sha256 of the raw cookie token (32 random bytes, base64url, cookie __Host-tr_session). The raw token is never stored.';
COMMENT ON COLUMN auth.session.data IS 'Neutral JSON attributes only, e.g. {"locale":"ja"}. Never language-serialised objects or provider tokens.';
COMMENT ON COLUMN auth.session.last_seen_at IS 'Touched at most every 5 minutes; each touch slides expires_at to now() + 30 days.';
CREATE INDEX session_user_idx    ON auth.session (user_id);
CREATE INDEX session_expires_idx ON auth.session (expires_at);

CREATE TABLE auth.oauth_state (
  state           text        PRIMARY KEY CHECK (length(state) BETWEEN 16 AND 128),
  provider        text        NOT NULL CHECK (provider IN ('google','github')),
  pkce_verifier   text        NOT NULL CHECK (length(pkce_verifier) BETWEEN 43 AND 128),
  return_to       text        NOT NULL DEFAULT '/' CHECK (return_to LIKE '/%' AND return_to NOT LIKE '//%'),
  created_by_impl text        NOT NULL CHECK (created_by_impl IN ('java','node','rust','go','test')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
COMMENT ON TABLE auth.oauth_state IS
  'In-flight OAuth2 logins (state, PKCE S256 verifier, returnTo). Single use: the callback consumes it with DELETE ... RETURNING. '
  'Shared, so a login started on one backend can complete on another.';
CREATE INDEX oauth_state_expires_idx ON auth.oauth_state (expires_at);

-- As in 20261021000500_app_and_ops.sql

CREATE TABLE app.saved_place (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid         NOT NULL REFERENCES auth.app_user (id) ON DELETE CASCADE,
  label       text         NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  place_id    text         CHECK (place_id ~ '^(PH-[0-9]{10}|JP-[0-9]{5})$'),
  lon         numeric(7,4) NOT NULL CHECK (lon > -180 AND lon <= 180),
  lat         numeric(6,4) NOT NULL CHECK (lat BETWEEN -90 AND 90),
  position    geography(Point, 4326)
              GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon::float8, lat::float8), 4326)::geography) STORED,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
COMMENT ON TABLE app.saved_place IS
  'A user''s saved place: a catalogue place (place_id set; lon/lat = its centroid) or an arbitrary point. At most 20 per user (trigger). '
  'Duplicates (same place_id, or same rounded point) violate a unique index -> 409 conflict.';
COMMENT ON COLUMN app.saved_place.place_id IS 'No FK to catalog.place: catalogue tables are swapped by the pipeline.';
CREATE UNIQUE INDEX saved_place_user_place_uq ON app.saved_place (user_id, place_id) WHERE place_id IS NOT NULL;
CREATE UNIQUE INDEX saved_place_user_point_uq ON app.saved_place (user_id, lon, lat) WHERE place_id IS NULL;
CREATE INDEX saved_place_user_idx ON app.saved_place (user_id, created_at, id);
CREATE INDEX saved_place_position_gix ON app.saved_place USING gist (position);

CREATE FUNCTION app.enforce_saved_place_limit() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Lock the owner so concurrent inserts from different backends cannot both pass the count.
  PERFORM 1 FROM auth.app_user WHERE id = NEW.user_id FOR UPDATE;
  IF (SELECT count(*) FROM app.saved_place WHERE user_id = NEW.user_id) >= 20 THEN
    RAISE EXCEPTION 'saved place limit (20) reached' USING ERRCODE = 'check_violation', CONSTRAINT = 'saved_place_limit';
  END IF;
  RETURN NEW;
END
$$;
COMMENT ON FUNCTION app.enforce_saved_place_limit() IS 'Raises check_violation with constraint name saved_place_limit (-> 422 unprocessable) on the 21st saved place.';
CREATE TRIGGER saved_place_limit BEFORE INSERT ON app.saved_place
  FOR EACH ROW EXECUTE FUNCTION app.enforce_saved_place_limit();

CREATE TABLE app.alert_subscription (
  user_id           uuid        PRIMARY KEY REFERENCES auth.app_user (id) ON DELETE CASCADE,
  enabled           boolean     NOT NULL DEFAULT false,
  radius_km         smallint    NOT NULL DEFAULT 200 CHECK (radius_km IN (50,100,200,300,500)),
  min_wind_kt       smallint    NOT NULL DEFAULT 64 CHECK (min_wind_kt BETWEEN 0 AND 200),
  language          text        NOT NULL DEFAULT 'en' CHECK (language IN ('en','ja')),
  unsubscribe_token text        NOT NULL UNIQUE
                    DEFAULT replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.alert_subscription IS 'Alert preferences (GET/PUT /v1/me/alerts). A missing row reads as the defaults with enabled=false.';
COMMENT ON COLUMN app.alert_subscription.unsubscribe_token IS 'Random token embedded in alert emails; GET /v1/alerts/unsubscribe?token= sets enabled=false.';

CREATE TABLE app.alert_subscription_place (
  user_id        uuid NOT NULL REFERENCES app.alert_subscription (user_id) ON DELETE CASCADE,
  saved_place_id uuid NOT NULL,
  PRIMARY KEY (user_id, saved_place_id),
  FOREIGN KEY (saved_place_id, user_id) REFERENCES app.saved_place (id, user_id) ON DELETE CASCADE
);
COMMENT ON TABLE app.alert_subscription_place IS 'AlertPreferences.savedPlaceIds. Empty means all of the user''s saved places. The composite FK keeps ids within the owner.';

CREATE TABLE app.alert_outbox (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedupe_key    text        NOT NULL UNIQUE,
  user_id       uuid        REFERENCES auth.app_user (id) ON DELETE CASCADE,
  kind          text        NOT NULL CHECK (kind IN ('storm-alert','test')),
  payload       jsonb       NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  available_at  timestamptz NOT NULL DEFAULT now(),
  claimed_by    text,
  claimed_until timestamptz,
  sent_at       timestamptz,
  attempts      smallint    NOT NULL DEFAULT 0,
  last_error    text
);
COMMENT ON TABLE app.alert_outbox IS
  'Alert emails to send. Enqueued idempotently by the ingestion job: INSERT ... ON CONFLICT (dedupe_key) DO NOTHING with '
  'dedupe_key = alert:{userId}:{liveId}:{advisoryNo}. The mailer claims rows with SELECT ... FOR UPDATE SKIP LOCKED in one transaction.';
CREATE INDEX alert_outbox_pending_idx ON app.alert_outbox (available_at, id) WHERE sent_at IS NULL;

CREATE TABLE app.email_suppression (
  email      text        PRIMARY KEY CHECK (email = lower(email)),
  reason     text        NOT NULL CHECK (reason IN ('bounce','complaint','manual')),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.email_suppression IS 'Addresses the mailer must skip (hard bounce, complaint).';

INSERT INTO ops.job_lease (job) VALUES ('mailer') ON CONFLICT (job) DO NOTHING;
