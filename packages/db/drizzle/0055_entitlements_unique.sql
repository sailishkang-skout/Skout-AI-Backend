-- §5.1 Task 35 (Enterprise Completion Plan) — the entitlements table's (workspace_id, key)
-- index (0050_canonical_operating_model_and_evidence_ledger.sql) was never unique, so
-- entitlements.service.ts's set() (an upsert via onConflictDoUpdate) has no real conflict
-- target without this. Nothing in this codebase has ever written to this table before Task 35
-- (verified by grep), but an environment could in principle already hold hand-inserted
-- duplicate (workspace_id, key) rows, which would make CREATE UNIQUE INDEX fail outright —
-- dedupe defensively first (keep the most recently updated row per pair) so the index
-- creation always succeeds, matching the same pattern 0048_pipelines_default_unique.sql used
-- for the same class of problem.
--
-- The old non-unique index shares its name with the new unique one, so it must be dropped
-- first — CREATE UNIQUE INDEX IF NOT EXISTS with a name already in use (even a non-unique
-- index of the same name) is a silent no-op, not an upgrade; that would leave the old,
-- non-unique index in place and onConflictDoUpdate would still have no real target.

DELETE FROM "entitlements" e
WHERE EXISTS (
  SELECT 1 FROM "entitlements" d
  WHERE d."workspace_id" = e."workspace_id"
    AND d."key" = e."key"
    AND (d."updated_at", d."id") > (e."updated_at", e."id")
);
--> statement-breakpoint
DROP INDEX IF EXISTS "entitlements_workspace_key_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "entitlements_workspace_key_idx" ON "entitlements" ("workspace_id", "key");
