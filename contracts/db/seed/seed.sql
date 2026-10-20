-- Load the deterministic fixture: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f contracts/db/seed/seed.sql
\ir 00_reset.sql
\ir 10_storms.sql
\ir 20_places.sql
\ir 30_exposure.sql
\ir 50_live.sql
