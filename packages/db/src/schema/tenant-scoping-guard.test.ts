import { describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * COPS-07 quality gate (Bible p.85, p.98): the suite fails when a table has no tenant scoping.
 * Every table in the migrated schema must carry `workspace_id` (or `tenant_id`), or be listed in
 * UNSCOPED with the reason it is safe. A new table without the column fails here until its author
 * either adds the column or records why it does not need one.
 *
 * Runs only when COPS_TEST_DATABASE_URL is set (real, migrated Postgres).
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

/** Tables without workspace_id / tenant_id as of 2026-10-09, each with why that is acceptable. */
const UNSCOPED: Record<string, string> = {
  // The tenant roots and platform-wide reference data.
  tenants: "tenant root",
  workspaces: "tenant root",
  users: "identity is global; access is through workspace_members",
  permissions: "global permission catalog",
  role_permissions: "child of roles (system roles are global, custom roles carry workspace_id)",
  model_versions: "global model registry",
  prompt_versions: "global prompt registry",
  regions: "global reference data",
  countries: "global reference data",
  country_aliases: "global reference data",
  country_industry_tam: "global reference data",
  regional_brief_versions: "global reference data",
  // Per-user authentication state, never tenant data.
  auth_events: "per-user auth log",
  auth_identities: "per-user auth",
  auth_login_cohorts: "per-user auth rollout",
  auth_refresh_tokens: "per-user auth",
  auth_sessions: "per-user auth",
  auth_verification_tokens: "per-user auth",
  user_credentials: "per-user auth",
  invite_otps: "per-invite auth",
  invite_sessions: "per-invite auth",
  // Children that are only reachable through a workspace-scoped parent.
  automation_run_steps: "child of automation_runs",
  automation_versions: "child of automations",
  buying_committee_members: "child of buying committee / company",
  company_snapshots: "child of companies",
  enrichment_attempts: "child of enrichment jobs",
  inbox_messages: "child of inbox_threads",
  list_members: "child of lists",
  meeting_attendees: "child of meetings",
  pipeline_stages: "child of pipelines",
  sequence_enrollment_steps: "child of sequence_enrollments",
  sequence_step_variants: "child of sequence_steps",
  sequence_steps: "child of sequences",
  sequence_versions: "child of sequences",
  smart_list_members: "child of smart_lists",
  // Platform operations.
  cops_processed_events: "idempotent-consumer ledger keyed by event id (COPS-01)",
  credit_reconciliation_runs: "platform-wide daily reconciliation run (COPS-04)",
  scrape_jobs: "platform scraping queue",
  signals: "corpus-level signals, joined to a workspace through the prospect",
};

maybe("tenant scoping guard (COPS-07)", () => {
  it("every table has workspace_id or tenant_id, or a recorded reason not to", async () => {
    const sql = postgres(url as string, { max: 1, onnotice: () => {} });
    try {
      const rows = await sql<{ table_name: string }[]>`
        select t.table_name
        from information_schema.tables t
        where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
          and t.table_name not like '\_\_drizzle%' and t.table_name not like 'drizzle%'
          and not exists (
            select 1 from information_schema.columns c
            where c.table_schema = 'public' and c.table_name = t.table_name
              and c.column_name in ('workspace_id', 'tenant_id')
          )
        order by t.table_name`;
      const unexplained = rows.map((r) => r.table_name).filter((name) => !(name in UNSCOPED));
      expect(
        unexplained,
        `Tables without workspace_id/tenant_id. Add the column, or add the table to UNSCOPED with the reason: ${unexplained.join(", ")}`
      ).toEqual([]);
    } finally {
      await sql.end();
    }
  });

  it("the COPS tables are scoped by workspace_id and it is NOT NULL", async () => {
    const sql = postgres(url as string, { max: 1, onnotice: () => {} });
    try {
      const rows = await sql<{ table_name: string; is_nullable: string }[]>`
        select c.table_name, c.is_nullable
        from information_schema.columns c
        where c.table_schema = 'public' and c.column_name = 'workspace_id'
          and (c.table_name like 'cops\_%' or c.table_name in ('engineering_tickets', 'ticket_comments', 'ticket_status_history', 'ticket_account_summaries'))`;
      // cops_activation_templates is the one deliberate exception: a NULL workspace is the system default.
      const nullable = rows.filter((r) => r.is_nullable === "YES" && r.table_name !== "cops_activation_templates").map((r) => r.table_name);
      expect(nullable).toEqual([]);
      expect(rows.length).toBeGreaterThan(10);
    } finally {
      await sql.end();
    }
  });
});
