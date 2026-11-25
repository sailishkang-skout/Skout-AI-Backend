-- PAPI-012 (public API PRD §10): request log (monthly partitions, 90-day retention), idempotency
-- (24-hour retention), async jobs, terms acceptances and per-workspace API settings.
-- migration-safety: additive. The only DROP TABLE is inside api_request_log_drop_partitions_before(),
-- which is not run here; the maintenance job calls it later to drop api_request_log month partitions
-- older than 90 days (PRD §10 retention). It never touches any other table.

CREATE TABLE IF NOT EXISTS "api_request_log" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "request_id" text NOT NULL,
  "workspace_id" uuid REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "api_key_id" uuid REFERENCES "api_keys"("id") ON DELETE SET NULL,
  "method" text NOT NULL,
  "endpoint" text NOT NULL,
  "status_code" integer NOT NULL,
  "error_code" text,
  "credits_charged" integer DEFAULT 0 NOT NULL,
  "price_applied" jsonb,
  "latency_ms" integer,
  "ip" text,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "api_request_log_pk" PRIMARY KEY ("id", "created_at"),
  CONSTRAINT "api_request_log_credits_check" CHECK ("credits_charged" >= 0)
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_request_log_workspace_created_idx" ON "api_request_log" ("workspace_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_request_log_key_created_idx" ON "api_request_log" ("api_key_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_request_log_request_idx" ON "api_request_log" ("request_id");
--> statement-breakpoint

-- Creates the monthly partitions (UTC months) from the month of p_from through p_months_ahead
-- months later. Partition names: api_request_log_yYYYYmMM. Safe to call repeatedly.
CREATE OR REPLACE FUNCTION "api_request_log_ensure_partitions"(p_from timestamptz, p_months_ahead integer)
RETURNS integer AS $$
DECLARE
  m timestamp;
  created integer := 0;
  part text;
BEGIN
  FOR i IN 0..p_months_ahead LOOP
    m := date_trunc('month', p_from AT TIME ZONE 'UTC') + make_interval(months => i);
    part := format('api_request_log_y%sm%s', to_char(m, 'YYYY'), to_char(m, 'MM'));
    IF to_regclass(format('%I', part)) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF "api_request_log" FOR VALUES FROM (%L) TO (%L)',
        part,
        to_char(m, 'YYYY-MM-DD') || ' 00:00:00+00',
        to_char(m + interval '1 month', 'YYYY-MM-DD') || ' 00:00:00+00'
      );
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Drops every monthly partition whose whole range ends on or before p_cutoff (90-day retention).
-- Returns the dropped partition names.
CREATE OR REPLACE FUNCTION "api_request_log_drop_partitions_before"(p_cutoff timestamptz)
RETURNS SETOF text AS $$
DECLARE
  r record;
  m timestamp;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'api_request_log'::regclass
      AND c.relname ~ '^api_request_log_y[0-9]{4}m[0-9]{2}$'
    ORDER BY c.relname
  LOOP
    m := to_timestamp(substring(r.relname FROM 'y([0-9]{4})m') || substring(r.relname FROM 'm([0-9]{2})$') || '01', 'YYYYMMDD')::timestamp;
    IF ((m + interval '1 month') AT TIME ZONE 'UTC') <= p_cutoff THEN
      EXECUTE format('DROP TABLE %I', r.relname);
      RETURN NEXT r.relname;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- The current month and the next three; the maintenance job keeps creating ahead.
SELECT "api_request_log_ensure_partitions"(now(), 3);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "api_idempotency" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "request_hash" text NOT NULL,
  "response" jsonb,
  "status_code" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "api_idempotency_pk" PRIMARY KEY ("workspace_id", "key"),
  CONSTRAINT "api_idempotency_key_length_check" CHECK (char_length("key") BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_idempotency_created_idx" ON "api_idempotency" ("created_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "api_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "api_key_id" uuid REFERENCES "api_keys"("id") ON DELETE SET NULL,
  "request_id" text NOT NULL,
  "operation" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "total_items" integer NOT NULL,
  "processed_items" integer DEFAULT 0 NOT NULL,
  "succeeded_items" integer DEFAULT 0 NOT NULL,
  "failed_items" integer DEFAULT 0 NOT NULL,
  "hold_id" uuid REFERENCES "credit_holds"("id") ON DELETE SET NULL,
  "result_location" text,
  "error_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "results_expire_at" timestamp with time zone,
  CONSTRAINT "api_jobs_status_check" CHECK ("status" IN ('queued', 'running', 'completed', 'failed', 'partially_completed')),
  CONSTRAINT "api_jobs_counts_check" CHECK (
    "total_items" > 0 AND "processed_items" >= 0 AND "succeeded_items" >= 0 AND "failed_items" >= 0
    AND "succeeded_items" + "failed_items" <= "processed_items" AND "processed_items" <= "total_items"
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_jobs_workspace_created_idx" ON "api_jobs" ("workspace_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_jobs_results_expire_idx" ON "api_jobs" ("results_expire_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "api_terms_acceptances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "terms_version" text NOT NULL,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ip" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_terms_acceptances_workspace_idx" ON "api_terms_acceptances" ("workspace_id", "accepted_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "workspace_api_settings" (
  "workspace_id" uuid PRIMARY KEY NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "addon_enabled" boolean DEFAULT false NOT NULL,
  "addon_enabled_at" timestamp with time zone,
  "addon_enabled_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "addon_disabled_reason" text,
  "live_access_for_trial" boolean DEFAULT false NOT NULL,
  "rate_tier" text DEFAULT 'standard' NOT NULL,
  "verify_daily_quota" integer,
  "search_daily_quota" integer,
  "monthly_credit_cap" integer,
  "max_active_keys" integer,
  "low_balance_threshold" integer,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "workspace_api_settings_limits_check" CHECK (
    ("verify_daily_quota" IS NULL OR "verify_daily_quota" >= 0)
    AND ("search_daily_quota" IS NULL OR "search_daily_quota" >= 0)
    AND ("monthly_credit_cap" IS NULL OR "monthly_credit_cap" >= 0)
    AND ("max_active_keys" IS NULL OR "max_active_keys" >= 0)
    AND ("low_balance_threshold" IS NULL OR "low_balance_threshold" >= 0)
  )
);
