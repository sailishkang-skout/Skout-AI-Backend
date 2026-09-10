-- §7.3 SP-11 — durable log of every emitted SkoutEvent, so the Dexter command center's event
-- timeline has something real to query. See packages/db/src/schema/events.ts for rationale.
CREATE TABLE IF NOT EXISTS "skout_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skout_events" ADD CONSTRAINT "skout_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skout_events_workspace_occurred_idx" ON "skout_events" ("workspace_id","occurred_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skout_events_workspace_type_idx" ON "skout_events" ("workspace_id","type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skout_events_correlation_idx" ON "skout_events" ("correlation_id");
