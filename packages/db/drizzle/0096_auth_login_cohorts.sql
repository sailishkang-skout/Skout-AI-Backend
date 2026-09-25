-- AUTH-BE-22 — login-method routing for the cohort migration. Expand-only: new table, nothing
-- existing is touched, so it is safe to leave in place after an image rollback.
CREATE TABLE IF NOT EXISTS "auth_login_cohorts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject" text NOT NULL,
	"method" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_login_cohorts" ADD CONSTRAINT "auth_login_cohorts_subject_unique" UNIQUE("subject_type","subject");
-- A UNIQUE constraint's backing index raises duplicate_table (not duplicate_object) on re-run.
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_login_cohorts" ADD CONSTRAINT "auth_login_cohorts_subject_type_check" CHECK ("subject_type" IN ('domain', 'email'));
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "auth_login_cohorts" ADD CONSTRAINT "auth_login_cohorts_method_check" CHECK ("method" IN ('clerk', 'password', 'google', 'microsoft', 'sso'));
EXCEPTION WHEN duplicate_object THEN null; END $$;
