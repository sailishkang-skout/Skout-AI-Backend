-- §16 DSAR fulfillment modes (manual ops + auto-export) + SLA due date
ALTER TABLE "data_subject_requests"
  ADD COLUMN IF NOT EXISTS "fulfillment_mode" text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS "sla_due_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "export_payload" text,
  ADD COLUMN IF NOT EXISTS "export_completed_at" timestamp with time zone;
