-- Sequence engine: A/B/C modes, variants, conditional branches, source (manual/template/dexter).

ALTER TABLE "sequences" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'manual';
--> statement-breakpoint
ALTER TABLE "sequences" ADD COLUMN IF NOT EXISTS "template_key" text;
--> statement-breakpoint
ALTER TABLE "sequences" ADD COLUMN IF NOT EXISTS "mode" text NOT NULL DEFAULT 'A';
--> statement-breakpoint

ALTER TABLE "sequence_steps" ADD COLUMN IF NOT EXISTS "condition_type" text;
--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD COLUMN IF NOT EXISTS "condition_wait_days" integer NOT NULL DEFAULT 2;
--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD COLUMN IF NOT EXISTS "yes_next_step_id" uuid;
--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD COLUMN IF NOT EXISTS "no_next_step_id" uuid;
--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD COLUMN IF NOT EXISTS "parent_step_id" uuid;
--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD COLUMN IF NOT EXISTS "branch" text;
--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD COLUMN IF NOT EXISTS "goal_label" text;
--> statement-breakpoint

ALTER TABLE "sequence_enrollments" ADD COLUMN IF NOT EXISTS "experiment_variant" text;
--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD COLUMN IF NOT EXISTS "stop_reason" text;
--> statement-breakpoint

ALTER TABLE "sequence_enrollment_steps" ADD COLUMN IF NOT EXISTS "variant_key" text;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sequence_step_variants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "step_id" uuid NOT NULL REFERENCES "sequence_steps"("id") ON DELETE cascade,
  "variant_key" text NOT NULL,
  "subject" text,
  "body_template" text,
  "weight" integer NOT NULL DEFAULT 50,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sequence_step_variants_step_key_unique" UNIQUE("step_id","variant_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sequence_step_variants_step_idx" ON "sequence_step_variants" ("step_id");
