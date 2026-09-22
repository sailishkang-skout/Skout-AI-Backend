# Auth migration safety runbook (AUTH-ADI-07)

Every auth migration (`BE-01`, `BE-02`, `BE-10`, …) touches the `users` table or adds new auth
tables. Migrations auto-run on deploy (`apps/api/docker-entrypoint.sh` runs `migrate.js` then
`apply-pending.js` before the app starts), and a production rollback (`deploy-prod.yml`'s
automatic rollback) restores the **image**, not the **schema** — so a bad migration isn't undone
by rolling back the container. This runbook is what to do about that.

## Before any auth-related deploy

An RDS snapshot is taken automatically, before the CDK deploy step, in `deploy-dev.yml`,
`deploy-uat.yml`, and `deploy-prod.yml` (`scripts/rds-snapshot.sh`). It runs on every deploy, not
just auth ones — cheap insurance, and simpler than trying to detect "is this an auth change" in
CI. On an environment's first-ever deploy (no RDS instance exists yet) it skips rather than
failing the pipeline.

If you're deploying manually outside CI, run it yourself first:
```bash
./scripts/rds-snapshot.sh SkoutDev   # or SkoutUat / SkoutProd
```

## Confirming a migration actually ran

Check the tracking table — every applied migration has a row:
```sql
SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;
```
A row existing here is **not proof the DDL actually executed** — see AUTH-ADI-02's finding in
`docs/adr/0007-clerk-to-custom-auth.md` for a case where the tracking table said a migration was
applied but the columns didn't exist. If a specific column/table is what you actually care about,
check it directly:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = '<table>' AND column_name = '<column>';
```

## Running a migration manually

If the entrypoint's automatic run didn't happen (e.g. you need to re-apply against a specific
task definition, or you're debugging), run it as a one-off ECS task the same way `deploy-*.yml`
does:
```bash
./scripts/ecs-run-migrations.sh SkoutDev   # drizzle migrate + apply-pending, in order
```
For a single ad-hoc SQL file (not part of the normal migration set), see the pattern in
`scripts/ecs-run-auth-audit.sh` — override the container command, run, `aws ecs wait
tasks-stopped`, then pull the log stream (`<service>/<container>/<taskId>` in
`/skout/<env>/api`) for output.

## Restoring from a snapshot

```bash
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier <new-instance-id> \
  --db-snapshot-identifier <snapshot-id>
```
This creates a **new** RDS instance from the snapshot — it does not overwrite the live one. Point
the environment's `DATABASE_HOST` at the restored instance (via the CDK config or a manual task-def
override) once you've confirmed it's what you want; don't delete the live instance until you have.
This is a deliberately manual, two-step process — there's no one-command "roll back the database,"
because the decision of what "correct" means (keep post-migration writes? discard them?) needs a
human.

## What "safe to leave the migration in place after a rollback" means

Ground Rule 2 (see the ticket doc, §1): migrations are **expand-only** until Phase 7 — add
tables/columns/indexes freely, never drop/rename/tighten a constraint on a live column. Because of
that: if a bad *deploy* gets rolled back (image reverted) but the migration it shipped already ran,
**leaving the migration in place is safe** — the old image code simply doesn't reference the new
columns/tables, and no existing behavior breaks. You only need the snapshot-restore path above for
something Ground Rule 2 doesn't cover: a migration that turns out to be wrong in a way that isn't
safely inert (e.g. a bad backfill wrote incorrect data into a new column, or expand-only was
violated by mistake).

## Acceptance

- [ ] Read by both Sahils before their first migration PR.
- [ ] Dry run completed in SkoutDev: snapshot → deploy a migration → roll back the image → confirm
      the app still works with the migration in place.
