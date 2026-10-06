CREATE TABLE "cops_timeline_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"type" text NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"source_event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cops_timeline_events_source_unique" UNIQUE("workspace_id","source_event_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "cops_timeline_events" ADD CONSTRAINT "cops_timeline_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cops_timeline_events" ADD CONSTRAINT "cops_timeline_events_account_id_companies_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cops_timeline_events_account_idx" ON "cops_timeline_events" USING btree ("workspace_id","account_id","occurred_at");
