-- COPS-10 exactly-once actions (Bible p.74: "exactly-once business effect is achieved through
-- idempotent actions"). An action writes its effect and this row in one transaction, keyed by the
-- step's idempotency key; a step that runs again after a crash finds the row and returns its output.
CREATE TABLE IF NOT EXISTS "automation_step_effects" (
  "step_key" text PRIMARY KEY,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "automation_run_id" uuid NOT NULL REFERENCES "automation_runs"("id") ON DELETE CASCADE,
  "node_id" text NOT NULL,
  "effect_type" text NOT NULL,
  "output" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
