ALTER TABLE "inbox_threads" ADD COLUMN "needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD COLUMN "suggested_tag" text;--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD COLUMN "suggested_negative_subtype" text;--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD COLUMN "suggested_confidence" real;--> statement-breakpoint
ALTER TABLE "inbox_threads" ADD COLUMN "suggested_reason" text;