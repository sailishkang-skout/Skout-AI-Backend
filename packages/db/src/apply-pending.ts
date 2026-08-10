import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { resolveDatabaseUrl, resolvePostgresSsl } from "./database-url.js";

try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env") });
} catch {}

const url = resolveDatabaseUrl();
const ssl = resolvePostgresSsl();
const sql = postgres(url, { max: 1, ...(ssl ? { ssl } : {}) });

async function run(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`✓ ${label}`);
  } catch (e) {
    console.error(`✗ ${label}:`, (e as Error).message);
  }
}

try {
  // 0010 — R2.1 inbound email threads
  await run("0010 imap_host/port/last_polled on inboxes", () => sql`
    ALTER TABLE "inboxes"
      ADD COLUMN IF NOT EXISTS "imap_host" text,
      ADD COLUMN IF NOT EXISTS "imap_port" integer,
      ADD COLUMN IF NOT EXISTS "imap_last_polled_at" timestamp with time zone`);

  await run("0010 enrollment_id on inbox_threads", () => sql`
    ALTER TABLE "inbox_threads" ADD COLUMN IF NOT EXISTS "enrollment_id" uuid`);

  await run("0010 RFC 5322 cols on inbox_messages", () => sql`
    ALTER TABLE "inbox_messages"
      ADD COLUMN IF NOT EXISTS "message_id" text,
      ADD COLUMN IF NOT EXISTS "in_reply_to" text,
      ADD COLUMN IF NOT EXISTS "references_header" text,
      ADD COLUMN IF NOT EXISTS "classification" text`);

  await run("0010 enrollment_id FK", () => sql`
    DO $$ BEGIN
      ALTER TABLE "inbox_threads" ADD CONSTRAINT "inbox_threads_enrollment_id_sequence_enrollments_id_fk"
        FOREIGN KEY ("enrollment_id") REFERENCES "public"."sequence_enrollments"("id") ON DELETE set null;
    EXCEPTION WHEN duplicate_object THEN null; END $$`);

  // 0011 — R2.2 conversation state machine
  await run("0011 status_changed_at / unread_count / reply_tag on inbox_threads", () => sql`
    ALTER TABLE "inbox_threads"
      ADD COLUMN IF NOT EXISTS "status_changed_at" timestamp with time zone,
      ADD COLUMN IF NOT EXISTS "unread_count" integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "reply_tag" text`);

  await run("0011 migrate 'open' → 'new'", () => sql`
    UPDATE "inbox_threads" SET "status" = 'new' WHERE "status" = 'open'`);

  // 0012 — repair (same as 0010+0011 with IF NOT EXISTS, already safe)
  console.log("✓ 0012 repair — already covered by 0010/0011 above");

  // 0013 — R3.1 OAuth token columns on inboxes
  await run("0013 OAuth columns on inboxes", () => sql`
    ALTER TABLE "inboxes"
      ADD COLUMN IF NOT EXISTS "oauth_access_token_encrypted" text,
      ADD COLUMN IF NOT EXISTS "oauth_refresh_token_encrypted" text,
      ADD COLUMN IF NOT EXISTS "oauth_token_expires_at" timestamp with time zone,
      ADD COLUMN IF NOT EXISTS "oauth_scope" text`);

  // 0014 — domain warmup + blacklist monitoring columns
  await run("0014 blacklist columns on sending_domains", () => sql`
    ALTER TABLE "sending_domains"
      ADD COLUMN IF NOT EXISTS "blacklist_status" text NOT NULL DEFAULT 'clean',
      ADD COLUMN IF NOT EXISTS "blacklisted_on"   jsonb NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS "last_checked_at"  timestamptz,
      ADD COLUMN IF NOT EXISTS "check_error"      text`);

  await run("0014 warmup ramp columns on inboxes", () => sql`
    ALTER TABLE "inboxes"
      ADD COLUMN IF NOT EXISTS "warmup_day"        integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "warmup_started_at" timestamptz`);

  // 0015 — R7.2 outbound webhooks (alter existing stub tables)
  await run("0015 webhook_endpoints new columns", () => sql`
    ALTER TABLE "webhook_endpoints"
      ADD COLUMN IF NOT EXISTS "description" text,
      ADD COLUMN IF NOT EXISTS "enabled" boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS "event_types" jsonb NOT NULL DEFAULT '[]'`);

  await run("0015 webhook_endpoints drop old stubs", () => sql`
    ALTER TABLE "webhook_endpoints"
      DROP COLUMN IF EXISTS "events",
      DROP COLUMN IF EXISTS "status"`);

  await run("0015 webhook_deliveries new columns", () => sql`
    ALTER TABLE "webhook_deliveries"
      ADD COLUMN IF NOT EXISTS "workspace_id" uuid,
      ADD COLUMN IF NOT EXISTS "event_id" text NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS "attempt" integer NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS "status_code" integer,
      ADD COLUMN IF NOT EXISTS "response_body" text,
      ADD COLUMN IF NOT EXISTS "duration_ms" integer,
      ADD COLUMN IF NOT EXISTS "error_message" text,
      ADD COLUMN IF NOT EXISTS "delivered_at" timestamptz`);

  await run("0015 webhook_deliveries drop old stubs", () => sql`
    ALTER TABLE "webhook_deliveries"
      DROP COLUMN IF EXISTS "attempts",
      DROP COLUMN IF EXISTS "response_status",
      DROP COLUMN IF EXISTS "last_attempt_at"`);

  await run("0017 sequence_steps.delay_unit", () => sql`
    ALTER TABLE "sequence_steps"
      ADD COLUMN IF NOT EXISTS "delay_unit" text DEFAULT 'days' NOT NULL`);

  await run("0018 drop old enrollment unique", () => sql`
    ALTER TABLE "sequence_enrollments" DROP CONSTRAINT IF EXISTS "sequence_enrollments_sequence_id_prospect_id_unique"`);

  await run("0018 drop old enrollment unique index", () => sql`
    DROP INDEX IF EXISTS "sequence_enrollments_sequence_id_prospect_id_unique"`);

  await run("0018 active enrollment unique index", () => sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "sequence_enrollments_active_unique"
      ON "sequence_enrollments" ("sequence_id", "prospect_id")
      WHERE "status" = 'active'`);

  await run("0018 sequence_steps.linkedin_action", () => sql`
    ALTER TABLE "sequence_steps"
      ADD COLUMN IF NOT EXISTS "linkedin_action" text`);

  await run("0018 linkedin_outreach_jobs table", () => sql`
    CREATE TABLE IF NOT EXISTS "linkedin_outreach_jobs" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
      "enrollment_id" uuid NOT NULL REFERENCES "sequence_enrollments"("id") ON DELETE cascade,
      "enrollment_step_id" uuid NOT NULL REFERENCES "sequence_enrollment_steps"("id") ON DELETE cascade,
      "prospect_id" text NOT NULL,
      "linkedin_url" text NOT NULL,
      "action" text NOT NULL,
      "message" text,
      "status" text NOT NULL DEFAULT 'pending',
      "failure_reason" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      "completed_at" timestamp with time zone,
      CONSTRAINT "linkedin_outreach_jobs_enrollment_step_id_unique" UNIQUE ("enrollment_step_id")
    )`);

  await run("0018 linkedin_outreach_jobs pending index", () => sql`
    CREATE INDEX IF NOT EXISTS "linkedin_outreach_jobs_pending_idx"
      ON "linkedin_outreach_jobs" ("workspace_id", "status", "created_at")
      WHERE "status" = 'pending'`);

  await run("0019 linkedin_accounts table", () => sql`
    CREATE TABLE IF NOT EXISTS "linkedin_accounts" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
      "unipile_account_id" text NOT NULL,
      "display_name" text,
      "linkedin_url" text,
      "status" text NOT NULL DEFAULT 'active',
      "daily_send_limit" integer NOT NULL DEFAULT 40,
      "sent_count" integer NOT NULL DEFAULT 0,
      "last_used_at" timestamp with time zone,
      "last_error" text,
      "is_default" boolean NOT NULL DEFAULT false,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    )`);

  await run("0019 linkedin_accounts unique", () => sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "linkedin_accounts_workspace_unipile_unique"
      ON "linkedin_accounts" ("workspace_id", "unipile_account_id")`);

  // 0020 — R8.3 workspace invites
  await run("0020 workspace_invites table", () => sql`
    CREATE TABLE IF NOT EXISTS "workspace_invites" (
      "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "workspace_id"        uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
      "invited_by_user_id"  uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
      "email"               text NOT NULL,
      "role"                text NOT NULL DEFAULT 'member',
      "token"               text NOT NULL,
      "expires_at"          timestamp with time zone NOT NULL,
      "accepted_at"         timestamp with time zone,
      "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT "workspace_invites_token_unique" UNIQUE("token")
    )`);

  // 0021 — email deliverability verdicts (bulk list verification before send)
  await run("0021 email_verifications table", () => sql`
    CREATE TABLE IF NOT EXISTS "email_verifications" (
      "workspace_id"          uuid NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE CASCADE,
      "prospect_id"           text NOT NULL,
      "email"                 text NOT NULL,
      "status"                text NOT NULL,
      "deliverability_score"  integer NOT NULL DEFAULT 0,
      "catch_all"             boolean NOT NULL DEFAULT false,
      "risky"                 boolean NOT NULL DEFAULT false,
      "provider"              text,
      "verified_at"           timestamp with time zone NOT NULL DEFAULT now(),
      CONSTRAINT "email_verifications_workspace_id_prospect_id_pk" PRIMARY KEY("workspace_id","prospect_id")
    )`);

  // 0022–0025 — CRM entities, meetings, pain points, invite auth (SQL files in drizzle/)
  const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
  const { readFile } = await import("node:fs/promises");

  async function runSqlMigration(tag: string, filename: string) {
    const raw = await readFile(path.join(drizzleDir, filename), "utf8");
    const statements = raw
      .split(/-->\s*statement-breakpoint/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i]!;
      await run(`${tag} [${i + 1}/${statements.length}]`, () => sql.unsafe(stmt));
    }
  }

  await runSqlMigration("0022_crm_entities", "0022_crm_entities.sql");
  await runSqlMigration("0023_meetings", "0023_meetings.sql");
  await runSqlMigration("0024_pain_points", "0024_pain_points.sql");
  await runSqlMigration("0025_invite_auth", "0025_invite_auth.sql");
  await runSqlMigration("0026_audit_logs", "0026_audit_logs.sql");
  await runSqlMigration("0027_unipile_channels", "0027_unipile_channels.sql");
  await runSqlMigration("0028_signals", "0028_signals.sql");
  await runSqlMigration("0028_crm_field_sources", "0028_crm_field_sources.sql");
  await runSqlMigration("0029_smart_list_auto_refresh", "0029_smart_list_auto_refresh.sql");
  await runSqlMigration("0029_activation_rules", "0029_activation_rules.sql");
  await runSqlMigration("0030_notifications", "0030_notifications.sql");
  await runSqlMigration("0031_user_phone", "0031_user_phone.sql");
  await runSqlMigration("0032_meeting_bot", "0032_meeting_bot.sql");
  await runSqlMigration("0033_calls", "0033_calls.sql");
  await runSqlMigration("0034_task_call_disposition", "0034_task_call_disposition.sql");
  await runSqlMigration("0035_meeting_auto_join", "0035_meeting_auto_join.sql");
  await runSqlMigration("0036_deal_field_sources", "0036_deal_field_sources.sql");
  await runSqlMigration("0037_next_best_action_suggestions", "0037_next_best_action_suggestions.sql");
  await runSqlMigration("0038_call_notes", "0038_call_notes.sql");
  await runSqlMigration("0039_notification_broadcast_and_indexes", "0039_notification_broadcast_and_indexes.sql");

} finally {
  await sql.end();
}
