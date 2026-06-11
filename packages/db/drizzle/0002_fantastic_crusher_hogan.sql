CREATE TABLE "smart_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_run_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scrape_jobs" ADD COLUMN "raw_s3_key" text;--> statement-breakpoint
ALTER TABLE "scrape_jobs" ADD COLUMN "clean_s3_key" text;--> statement-breakpoint
ALTER TABLE "scrape_jobs" ADD COLUMN "manifest_s3_key" text;--> statement-breakpoint
ALTER TABLE "smart_lists" ADD CONSTRAINT "smart_lists_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scrape_jobs_status_idx" ON "scrape_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "scrape_jobs_source_idx" ON "scrape_jobs" USING btree ("source");