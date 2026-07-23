CREATE TABLE IF NOT EXISTS "invite_otps" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "invite_token"  text NOT NULL,
  "otp_hash"      text NOT NULL,
  "expires_at"    timestamp with time zone NOT NULL,
  "used"          boolean NOT NULL DEFAULT false,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invite_otps_invite_token_idx" ON "invite_otps"("invite_token");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invite_sessions" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id"     uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "token"       text NOT NULL,
  "expires_at"  timestamp with time zone NOT NULL,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "invite_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invite_sessions_token_idx" ON "invite_sessions"("token");
