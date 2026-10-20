-- migrate:up

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

-- migrate:down

DROP TABLE auth.oauth_state;
DROP TABLE auth.session;
DROP TABLE auth.oauth_account;
DROP TABLE auth.app_user;
