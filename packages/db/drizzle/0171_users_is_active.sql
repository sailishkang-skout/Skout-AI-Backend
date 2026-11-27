-- ADD-3 (public API): live API keys need an active user. Existing users are active; new users start
-- inactive until their email is verified (the flow that sets it lands separately).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "is_active" SET DEFAULT false;
