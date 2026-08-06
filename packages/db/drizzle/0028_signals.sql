-- R11.2: unified signal store
CREATE TABLE IF NOT EXISTS "signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entity_type" text DEFAULT 'company' NOT NULL,
  "entity_id" text NOT NULL,
  "signal_type" text NOT NULL,
  "value" jsonb DEFAULT '{}' NOT NULL,
  "confidence" real,
  "detected_at" timestamp with time zone NOT NULL,
  "source" text,
  "provenance" jsonb DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signals_entity_idx" ON "signals" ("entity_type", "entity_id", "detected_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signals_type_idx" ON "signals" ("signal_type");
