-- §10.5 LinkedIn AI voice handoff: mobile payload, CRM writeback, expiry
ALTER TABLE "linkedin_voice_handoffs" ADD COLUMN IF NOT EXISTS "prospect_name" text;
--> statement-breakpoint
ALTER TABLE "linkedin_voice_handoffs" ADD COLUMN IF NOT EXISTS "linkedin_url" text;
--> statement-breakpoint
ALTER TABLE "linkedin_voice_handoffs" ADD COLUMN IF NOT EXISTS "synthetic_profile" text;
--> statement-breakpoint
ALTER TABLE "linkedin_voice_handoffs" ADD COLUMN IF NOT EXISTS "language" text NOT NULL DEFAULT 'en';
--> statement-breakpoint
ALTER TABLE "linkedin_voice_handoffs" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "linkedin_voice_handoffs" ADD COLUMN IF NOT EXISTS "confirmed_by" uuid;
--> statement-breakpoint
ALTER TABLE "linkedin_voice_handoffs" ADD COLUMN IF NOT EXISTS "outcome_note" text;
--> statement-breakpoint
ALTER TABLE "linkedin_voice_handoffs" ADD COLUMN IF NOT EXISTS "activity_id" uuid;
--> statement-breakpoint
UPDATE "linkedin_voice_handoffs" SET "voice_choice" = 'personal' WHERE "voice_choice" IN ('self', 'none', 'user');
--> statement-breakpoint
UPDATE "linkedin_voice_handoffs" SET "synthetic_profile" = "voice_choice", "voice_choice" = 'synthetic'
  WHERE "voice_choice" IN ('alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'cloned', 'synthetic');
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "linkedin_voice_handoffs" ADD CONSTRAINT "linkedin_voice_handoffs_confirmed_by_users_id_fk"
   FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "linkedin_voice_handoffs_workspace_status_idx"
  ON "linkedin_voice_handoffs" ("workspace_id", "status");
