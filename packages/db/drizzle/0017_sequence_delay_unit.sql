ALTER TABLE "sequence_steps" ADD COLUMN IF NOT EXISTS "delay_unit" text DEFAULT 'days' NOT NULL;
