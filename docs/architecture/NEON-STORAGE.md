# Neon storage: why a catalogue load fits the free cap

Measured 2026-10-26 on the production project (Neon Free, Singapore). Kept up to date when the catalogue's shape
changes; `tools/ops-watch.sh quota` in portfolio-docs watches the numbers below every day.

## What counts against the 1 GB

- Neon Free caps each project's **logical size** at 1 GB. The compute enforces it as `neon.max_cluster_size = 1GB`:
  a write that would grow the branch past it fails with `DiskFull: could not extend file because project size limit
  (1024 MB) has been exceeded`.
- Logical size is the sum of every database in the branch (`SELECT sum(pg_database_size(datname)) FROM pg_database`):
  `neondb` plus about 23 MB for `postgres`, `template0` and `template1`. Tables, TOAST, indexes and dead rows all
  count; free space inside a table counts until the table is dropped or truncated.
- History (the 6-hour instant-restore window on Free, WAL) is billed separately and does not count toward this check.
  It cannot be raised on Free, and lowering it would not free any of the 1 GB, so it is left alone.
- Replay's project is its own: Plumes uses a separate Neon project (different tenant), so neither can push the other
  over.

## Why the load of 2026-10-26 failed

`typhoon.dbload` stages a complete second catalogue in `catalog_next` and swaps it in, in one transaction, so the API
serves the old version or the new one, never a mix. Both copies exist until the commit, so a load needs
**database + one more catalogue**.

| | before (data v4 live) |
|---|---|
| database (logical) | 617 MB |
| catalogue (`catalog` schema) | 577 MB, of which `place_storm_exposure` 525 MB (169 MB table, 356 MB indexes) |
| load peak | 617 + 577 = **1,194 MB, over the 1,024 MB cap** |

Data v4 widened exposure from 200 km to 500 km. Its first load still fitted, because the copy being replaced was the
small 200 km catalogue; every load after it needed two 500 km copies, which can never fit. Weekly growth played no
part (data v4 to v5 added 1 storm, 43 fixes and 92 exposure rows).

## The fix

1. **Lean exposure indexes** (migration `20261026000100_lean_exposure_indexes`). Three composite indexes took 280 MB,
   more than the table. Every API query reads one place (at most about 1,000 rows, through the primary key's
   `place_id` prefix) or one storm (at most about 3,200 rows, through a plain `sid` index, 12 MB thanks to B-tree
   deduplication) and sorts those rows in memory. Measured on production data: the busiest place 0.6 ms, the busiest
   storm 4.8 ms.
2. **Size guard before staging.** `dbload` refuses a load, before staging anything, when
   `database + projected staged copy` exceeds **85 % of the cap** (870 MB). The projection scales each live table's
   size (heap, TOAST, indexes) by the new row count, plus 10 %. A refused load prints an `::error`, the workflow's
   report job opens or comments on the "API load failed" issue, and the API keeps the previous version.
3. **Cleanup.** A leftover `catalog_next` schema is dropped and committed before the guard runs. The swap drops the
   old tables, which frees their space at the commit, and the new tables are then `VACUUM (ANALYZE)`d.

| | after the fix (estimate until the first load) |
|---|---|
| catalogue | about 309 MB (exposure about 257 MB: 169 MB table, 76 MB primary key, 12 MB `sid` index) |
| database (logical) | about 349 MB (34 %) |
| load peak | about 349 + 309 = **about 658 MB (64 %)**, under the 870 MB guard |

## Growth

- A season adds about 20,000 exposure rows (2022 to 2025 averaged 17,500) and about 900 fixes: about 3 MB a year in
  the database and 6 MB a year at the load peak.
- At that rate the load peak reaches the 85 % guard (870 MB) in about 35 years and the cap in about 60. Before the fix
  the peak was already over the cap.
- What would change this: a wider exposure radius, more places or another per-pair table. Any such change must come
  with a new measurement here; the size guard stops the load (without an outage) if one is missed.
