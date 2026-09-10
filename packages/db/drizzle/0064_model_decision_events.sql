CREATE TABLE "model_decision_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"suggested_value" text,
	"outcome" text NOT NULL,
	"confidence" real,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_decision_events" ADD CONSTRAINT "model_decision_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "model_decision_events_workspace_idx" ON "model_decision_events" USING btree ("workspace_id","surface","created_at");
