# Neon storage: why a catalogue load fits the free cap

Measured 2026-10-26 on the production project (Neon Free, Singapore); updated when the catalogue's shape changes.
A daily quota check watches these numbers.

## What counts against the 1 GB

- Neon Free caps each project's **logical size** at 1 GB. The compute enforces it as `neon.max_cluster_size = 1GB`:
  a write that would grow the branch past it fails with `DiskFull: could not extend file because project size limit
  (1024 MB) has been exceeded`.
- Logical size is the sum of every database in the branch (`SELECT sum(pg_database_size(datname)) FROM pg_database`):
  `neondb` plus about 23 MB for `postgres`, `template0` and `template1`. Tables, TOAST, indexes and dead rows all
  count; free space inside a table counts until the table is dropped or truncated.
- History (the 6-hour instant-restore window, `history_retention_seconds = 21600`, the Free maximum) is billed
  separately and does not count toward this check. It stays at 6 hours: lowering it is free but frees none of the
  1 GB, and it is the only way to undo a bad write within those hours.
- One branch (`production`); the Neon API reports `branch_logical_size_limit = 1024` MB.
- Plumes uses a separate Neon project (different tenant), so neither can push the other over.

## What the load of 2026-10-26 measured

`typhoon.dbload` stages a complete second catalogue in `catalog_next` and swaps it in one transaction, so the API
serves the old or the new version, never a mix. Both copies exist until the commit, so a load needs
**database + one more catalogue**.

| | before (data v4 live) |
|---|---|
| database (logical) | 617 MB |
| catalogue (`catalog` schema) | 577 MB, of which `place_storm_exposure` 525 MB (169 MB table, 356 MB indexes) |
| load peak | 617 + 577 = **1,194 MB, over the 1,024 MB cap** |

Data v4 widened exposure from 200 km to 500 km. Its first load fitted because it replaced the small 200 km catalogue;
every later load needed two 500 km copies, which cannot fit. Weekly growth played no part (v4 to v5 added 1 storm,
43 fixes and 92 exposure rows).

## The fix

1. **Lean exposure indexes** (migration `20261026000100_lean_exposure_indexes`). Three composite indexes took 280 MB,
   more than the table. Every API query reads one place (up to about 1,000 rows, via the primary key's `place_id`
   prefix) or one storm (up to about 3,200 rows, via a plain `sid` index, 12 MB with B-tree deduplication) and sorts
   in memory. Measured on production data: busiest place 0.6 ms, busiest storm 4.8 ms.
2. **Size guard before staging.** `dbload` refuses a load before staging when `database + projected staged copy`
   exceeds **85 % of the cap** (870 MB). The projection scales each live table's size (heap, TOAST, indexes) by the
   new row count, plus 10 %. A refused load prints an `::error`, the report job opens or comments on the
   "API load failed" issue, and the API keeps the previous version.
3. **Cleanup, automatic and cheap.**
   - *Startup sweep:* each load takes the lease and drops a committed leftover `catalog_next` in its own short
     transaction, so the space is free before the guard measures. A running load's staging schema is uncommitted
     and invisible, so the sweep never touches it.
   - *On failure:* all staging is in the load's one transaction, so a crash, timeout or validation error rolls it
     back. A cleanup step on a fresh connection sweeps again (best effort; the next run's sweep repeats it). Tested:
     a load killed while staging its fourth table left the same 7 tables and nothing in `catalog_next`; the next
     load succeeded with zero orphans.
   - *On success:* the swap drops the old tables, which frees their space at commit. `VACUUM (ANALYZE)` then runs
     on the six swapped tables and two bookkeeping tables only: no `VACUUM FULL`, no exclusive locks, seconds.
4. **Versions kept: only the current catalogue.** The API never reads an older version; a rollback reloads the
   previous data version from the dataset store (`v<N>/tables/`), which keeps every version. A second copy in
   the database would cost about 309 MB and push the load peak to about 95 %. `catalog.dataset_version` keeps one
   small row per load (the ETag history).

| | after the fix (estimate until the first load) |
|---|---|
| catalogue | about 309 MB (exposure about 257 MB: 169 MB table, 76 MB primary key, 12 MB `sid` index) |
| database (logical) | about 349 MB (34 %) |
| load peak | about 349 + 309 = **about 658 MB (64 %)**, under the 870 MB guard |

## Growth

- A season adds about 20,000 exposure rows (2022–2025 averaged 17,500) and about 900 fixes: about 3 MB a year in the
  database, 6 MB a year at the load peak.
- At that rate the load peak reaches the 85 % guard (870 MB) in about 35 years and the cap in about 60.
- A wider exposure radius, more places or another per-pair table would change this; any such change needs a new
  measurement here. If one is missed, the size guard stops the load without an outage.
