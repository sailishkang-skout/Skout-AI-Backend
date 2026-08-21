# drizzle-baseline/

This folder exists because `packages/db/drizzle/meta/` — the snapshot bookkeeping
`drizzle-kit generate` uses to diff schema changes — is missing almost all of its
history. Only `0000`-`0003`, an empty `0007_snapshot.json`, and `0008` ever existed;
everything else (`0004`-`0006`, `0009`-`0045`) has no snapshot file at all. Since
`drizzle-kit generate` validates the entire journal-referenced snapshot chain before
it can diff anything, it was completely broken — not just for the one empty file
originally reported, but for any future schema change.

**This folder is a fresh, self-consistent snapshot lineage**, seeded from the actual
current schema (`src/schema/index.ts`) as of 2026-08-17. It lets `drizzle-kit generate`
work again. It is *only* used by the `drizzle-kit` CLI (via `out` in
[`drizzle.config.ts`](../drizzle.config.ts)) — never by the runtime migrator
(`src/migrate.ts`), which reads `../drizzle/*.sql` + `../drizzle/meta/_journal.json`
directly via its own hardcoded path and has no dependency on snapshot files at all.
So this repair carries zero risk to already-applied migrations in any environment
(local, dev, prod) — nothing in the real `drizzle/` folder was touched.

## Workflow for your next schema change

1. Edit `src/schema/*.ts` as normal.
2. Run `pnpm db:generate` (or `npx drizzle-kit generate` from `packages/db/`). It now
   diffs against this baseline and writes the new migration here, in
   `drizzle-baseline/`, updating this folder's own `meta/_journal.json`.
3. Copy the newly generated `.sql` file into the real `../drizzle/` folder, renumbered
   to continue that folder's own sequence (the next number after the highest existing
   `NNNN_*.sql` there — check with `ls ../drizzle/*.sql | sort -V | tail -1`). This is
   the same manual step used for `0045_sequence_retry_and_linkedin_connections.sql`.
4. Append a matching entry to `../drizzle/meta/_journal.json` — `idx` one past the
   current highest, `tag` matching the renumbered filename (no `.sql` extension), and
   a `when` timestamp *greater than* the last entry's (the existing entries use
   incrementing far-future placeholder timestamps, not real wall-clock time — match
   that pattern, don't use `Date.now()`, or the runtime migrator will silently skip
   your migration since it applies entries in `when` order).
5. Run `pnpm db:migrate` and confirm the new migration applied (check
   `__drizzle_migrations` or `\d <your_table>` in psql).

Steps 3-4 stay manual because the real `drizzle/meta/` chain still can't be safely
regenerated wholesale (would require rewriting deployed environments' migration
history). If someone eventually wants to properly backfill all of `drizzle/meta/`'s
missing snapshots instead of living with this two-folder split permanently, that's a
separate, more invasive project — coordinate across all environments before touching
`drizzle/meta/_journal.json` directly, since deployed dev/prod databases depend on it.
