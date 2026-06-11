CREATE TABLE "scrape_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'schedule' NOT NULL,
	"seeds" text[] DEFAULT '{}' NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw_count" integer DEFAULT 0 NOT NULL,
	"clean_count" integer DEFAULT 0 NOT NULL,
	"quarantined_count" integer DEFAULT 0 NOT NULL,
	"ingested_count" integer DEFAULT 0 NOT NULL,
	"skipped_duplicate_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "enrichment_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"list_id" uuid,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "enrichment_jobs" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "enrichment_jobs" ADD COLUMN "credits_used" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "enrichment_batches" ADD CONSTRAINT "enrichment_batches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;