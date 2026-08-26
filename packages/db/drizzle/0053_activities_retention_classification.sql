-- §8.12 CRM Intelligence / Task 19 (Enterprise Completion Plan) — additive column so
-- RetentionRulesService.classify() has somewhere to persist its result once wired into a real
-- activity-ingestion path (apps/crm/src/services/activities.service.ts's record()). Nullable,
-- no default that would imply every existing row has been classified — existing rows stay NULL
-- until a future backfill (not run here; no DB access from this sandbox), matching the same
-- "additive/backward-compatible only" constraint every migration this session has followed.

ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "retention_classification" text;
