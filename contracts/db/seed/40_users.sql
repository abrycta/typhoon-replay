-- Two fixture users. The session token below is PUBLIC fixture data for CI and local dev only
-- (Schemathesis and manual curl). Production sessions are minted by the backends.
--   Cookie: __Host-tr_session=fixture-session-token-ana-0000000000000
INSERT INTO auth.app_user (id, display_name, email, email_verified, avatar_url, locale, created_at, updated_at) VALUES
  ('0192f5a0-0000-7000-8000-000000000001', 'Ana Reyes',   'ana@example.com',  true, 'https://avatars.githubusercontent.com/u/1?v=4', 'en', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
  ('0192f5a0-0000-7000-8000-000000000002', 'Kenji Sato',  'kenji@example.jp', true, NULL,                                            'ja', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z');

INSERT INTO auth.oauth_account (provider, subject, user_id, email, email_verified, created_at, last_login_at) VALUES
  ('github', '1001',                  '0192f5a0-0000-7000-8000-000000000001', 'ana@example.com',  true, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
  ('google', '110000000000000000002', '0192f5a0-0000-7000-8000-000000000002', 'kenji@example.jp', true, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z');

INSERT INTO auth.session (token_hash, user_id, data, created_at, last_seen_at, expires_at, created_by_impl, user_agent) VALUES
  (sha256(convert_to('fixture-session-token-ana-0000000000000', 'UTF8')), '0192f5a0-0000-7000-8000-000000000001',
   '{"locale":"en"}', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', '2099-01-01T00:00:00Z', 'test', 'fixture');

INSERT INTO app.saved_place (id, user_id, label, place_id, lon, lat, created_at, updated_at) VALUES
  ('0192f5a0-0000-7000-8000-000000000101', '0192f5a0-0000-7000-8000-000000000001', 'Home',    'PH-0831600000', 125.0039, 11.2433, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
  ('0192f5a0-0000-7000-8000-000000000102', '0192f5a0-0000-7000-8000-000000000001', 'Lola''s', NULL,            124.9950, 11.2100, '2026-10-01T00:01:00Z', '2026-10-01T00:01:00Z'),
  ('0192f5a0-0000-7000-8000-000000000201', '0192f5a0-0000-7000-8000-000000000002', '実家',     'JP-47201',      127.6809, 26.2124, '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z');

INSERT INTO app.alert_subscription (user_id, enabled, radius_km, min_wind_kt, language, unsubscribe_token, created_at, updated_at) VALUES
  ('0192f5a0-0000-7000-8000-000000000001', true, 200, 64, 'en', 'fixture-unsubscribe-token-ana', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
INSERT INTO app.alert_subscription_place (user_id, saved_place_id) VALUES
  ('0192f5a0-0000-7000-8000-000000000001', '0192f5a0-0000-7000-8000-000000000101');
