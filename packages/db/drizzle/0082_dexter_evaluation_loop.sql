-- §7.3 Evaluation Loop (SP-02): a Dexter plan can now be explicitly declined (not just left
-- proposed forever), and a sequence can name the Dexter plan it was invoked to carry out, so
-- reply/meeting rate can be attributed back to the plan.
ALTER TABLE "dexter_plans"
  ADD COLUMN IF NOT EXISTS "rejected_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "rejected_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;

ALTER TABLE "sequences"
  ADD COLUMN IF NOT EXISTS "dexter_plan_id" uuid REFERENCES "dexter_plans"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "sequences_dexter_plan_idx" ON "sequences" ("dexter_plan_id");
