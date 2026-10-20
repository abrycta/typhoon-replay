-- Deterministic fixture reset. Wipes every seeded table, so `just seed` can run repeatedly.
-- CI and local dev only: never run against the production database.
TRUNCATE catalog.dataset_version, catalog.storm, catalog.storm_landfall, catalog.storm_fix, catalog.pagasa_name,
         catalog.place, catalog.place_storm_exposure RESTART IDENTITY;
TRUNCATE live.active_storm, live.live_event RESTART IDENTITY;
UPDATE live.revision SET seq = 0, updated_at = '2026-10-21T00:00:00Z';

INSERT INTO catalog.dataset_version (published_at, ibtracs_version, source_commit, description)
VALUES ('2026-10-21T00:00:00Z', 'v04r01', 'fixture', 'Conformance fixture: 9 storms, 10 places');
