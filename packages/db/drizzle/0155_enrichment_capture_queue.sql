-- Companies whose LinkedIn people discovery has result pages left after a saved batch.
-- Listed under LinkedIn Enrichment -> Capture queue so a user can continue capturing later.
CREATE TABLE IF NOT EXISTS "enrichment_capture_queue" (
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
	"company_public_id" text NOT NULL,
	"company_name" text,
	"source_url" text NOT NULL,
	"pages_read" integer DEFAULT 0 NOT NULL,
	"people_found" integer DEFAULT 0 NOT NULL,
	"expected_people" integer,
	"batches" integer DEFAULT 0 NOT NULL,
	"complete" boolean DEFAULT false NOT NULL,
	"stop_reason" text,
	"updated_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrichment_capture_queue_pk" PRIMARY KEY ("workspace_id", "company_public_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_capture_queue_workspace_updated_idx" ON "enrichment_capture_queue" ("workspace_id", "complete", "updated_at");
