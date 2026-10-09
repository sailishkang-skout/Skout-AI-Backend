CREATE TABLE "cops_account_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"survivor_id" uuid NOT NULL,
	"duplicate_id" uuid NOT NULL,
	"duplicate_name" text NOT NULL,
	"reason" text NOT NULL,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"merged_by" uuid,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cops_account_merges_duplicate_unique" UNIQUE("workspace_id","duplicate_id")
);
--> statement-breakpoint
ALTER TABLE "cops_account_merges" ADD CONSTRAINT "cops_account_merges_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cops_account_merges" ADD CONSTRAINT "cops_account_merges_merged_by_fk" FOREIGN KEY ("merged_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
