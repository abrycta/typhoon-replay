-- Lean place_storm_exposure indexes, so a catalogue reload (typhoon.dbload stages a full second copy before the
-- swap) fits Neon Free's 1 GB per-project cap with headroom (docs/architecture/NEON-STORAGE.md).
--
-- The three composite indexes took 280 MB of the table's 356 MB of indexes (data v4, 1.74 M rows), more than the
-- table itself. Every API query reads one place (<= 1,000 rows, served by the primary key's place_id prefix) or one
-- storm (<= 3,200 rows), and sorts that handful of rows in memory, so the composite orderings buy nothing measurable.
-- The storm lookup keeps a plain (sid) index; B-tree deduplication stores each sid once per page (~850 rows a sid).

-- migrate:up

DROP INDEX catalog.pse_place_closest_idx;
DROP INDEX catalog.pse_place_date_idx;
DROP INDEX catalog.pse_sid_closest_idx;
CREATE INDEX pse_sid_idx ON catalog.place_storm_exposure (sid);

-- migrate:down

DROP INDEX catalog.pse_sid_idx;
CREATE INDEX pse_place_closest_idx ON catalog.place_storm_exposure (place_id, closest_approach_km, sid);
CREATE INDEX pse_place_date_idx    ON catalog.place_storm_exposure (place_id, closest_approach_at DESC, sid);
CREATE INDEX pse_sid_closest_idx   ON catalog.place_storm_exposure (sid, closest_approach_km, place_id);
