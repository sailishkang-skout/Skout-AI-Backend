-- Sequence engine v2: versioning, event ledger, compound conditions, A/B experiments (spec §30–49, §62).

ALTER TABLE "sequences" ADD COLUMN IF NOT EXISTS "current_version" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "sequence_steps" ADD COLUMN IF NOT EXISTS "condition_expression" jsonb;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sequence_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sequence_id" uuid NOT NULL REFERENCES "sequences"("id") ON DELETE cascade,
  "version" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'published',
  "snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "published_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sequence_versions_seq_version_unique" UNIQUE("sequence_id","version")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sequence_versions_sequence_idx" ON "sequence_versions" ("sequence_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sequence_experiments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "primary_metric" text NOT NULL DEFAULT 'positive_reply',
  "weight_a" integer NOT NULL DEFAULT 50,
  "weight_b" integer NOT NULL DEFAULT 50,
  "sequence_a_id" uuid NOT NULL REFERENCES "sequences"("id") ON DELETE restrict,
  "sequence_b_id" uuid NOT NULL REFERENCES "sequences"("id") ON DELETE restrict,
  "duration_days" integer NOT NULL DEFAULT 30,
  "started_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sequence_experiments_workspace_idx" ON "sequence_experiments" ("workspace_id");
--> statement-breakpoint

ALTER TABLE "sequence_enrollments" ADD COLUMN IF NOT EXISTS "sequence_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD COLUMN IF NOT EXISTS "experiment_id" uuid;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "sequence_enrollments"
    ADD CONSTRAINT "sequence_enrollments_sequence_version_id_fk"
    FOREIGN KEY ("sequence_version_id") REFERENCES "sequence_versions"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "sequence_enrollments"
    ADD CONSTRAINT "sequence_enrollments_experiment_id_fk"
    FOREIGN KEY ("experiment_id") REFERENCES "sequence_experiments"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sequence_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "sequence_id" uuid NOT NULL REFERENCES "sequences"("id") ON DELETE cascade,
  "enrollment_id" uuid REFERENCES "sequence_enrollments"("id") ON DELETE cascade,
  "sequence_version_id" uuid,
  "prospect_id" text,
  "step_id" uuid,
  "event_type" text NOT NULL,
  "variant_key" text,
  "branch" text,
  "result" text,
  "reason" text,
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sequence_events_enrollment_idx" ON "sequence_events" ("enrollment_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sequence_events_sequence_idx" ON "sequence_events" ("sequence_id", "created_at");
