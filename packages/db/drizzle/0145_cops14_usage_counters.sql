-- COPS-14 metered usage: monthly counters per workspace and metric (ai_actions first).
CREATE TABLE IF NOT EXISTS "cops_usage_counters" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "metric" text NOT NULL,
  "period" text NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cops_usage_counters_pk" PRIMARY KEY ("workspace_id", "metric", "period")
);
