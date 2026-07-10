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

  // 0014 — domain warmup + blacklist monitoring
  await run("0014 blacklist columns on sending_domains", () => sql`
    ALTER TABLE "sending_domains"
      ADD COLUMN IF NOT EXISTS "blacklist_status" text NOT NULL DEFAULT 'clean',
      ADD COLUMN IF NOT EXISTS "blacklisted_on" jsonb NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS "last_checked_at" timestamp with time zone,
      ADD COLUMN IF NOT EXISTS "check_error" text`);

  await run("0014 warmup columns on inboxes", () => sql`
    ALTER TABLE "inboxes"
      ADD COLUMN IF NOT EXISTS "warmup_day" integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "warmup_started_at" timestamp with time zone`);

} finally {
  await sql.end();
}
