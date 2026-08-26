ALTER TABLE "sequences" ADD COLUMN IF NOT EXISTS "mode_c_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sequences" ADD COLUMN IF NOT EXISTS "mode_c_approved_by" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sequences" ADD CONSTRAINT "sequences_mode_c_approved_by_users_id_fk" FOREIGN KEY ("mode_c_approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
