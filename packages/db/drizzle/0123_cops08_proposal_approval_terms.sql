-- COPS-08: the proposal terms the approval rules read (Bible p.34): payment terms, complimentary
-- credits, custom clauses and a non-standard SLA. Additive and idempotent: safe to run twice.
-- Existing versions take the standard values (net 30, no free credits, no custom clauses, standard
-- SLA), which need no approval. Adding a column with a default does not fire the trigger that
-- keeps sent versions immutable.

ALTER TABLE "proposal_versions" ADD COLUMN IF NOT EXISTS "payment_terms_net_days" integer NOT NULL DEFAULT 30;
ALTER TABLE "proposal_versions" ADD COLUMN IF NOT EXISTS "free_credits" integer NOT NULL DEFAULT 0;
ALTER TABLE "proposal_versions" ADD COLUMN IF NOT EXISTS "custom_clauses" boolean NOT NULL DEFAULT false;
ALTER TABLE "proposal_versions" ADD COLUMN IF NOT EXISTS "non_standard_sla" boolean NOT NULL DEFAULT false;
