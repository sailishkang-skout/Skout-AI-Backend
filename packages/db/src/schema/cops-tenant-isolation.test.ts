import { describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Tenant isolation for every COPS-02 and COPS-03 table: rows written for workspace A are invisible when the
 * query is scoped to workspace B, and every table carries workspace_id. Runs only when
 * COPS_TEST_DATABASE_URL is set (real Postgres).
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;


const TABLES = [
  "account_relationships",
  "contact_channels",
  "opportunity_contacts",
  "tags",
  "custom_field_definitions",
  "custom_field_values",
  "cops_timeline_events",
  "cops_saved_views",
  "cops_account_merges",
  // COPS-03
  "proposals",
  "proposal_versions",
  "proposal_line_items",
  "contracts",
  "contract_versions",
  "payment_requests",
  "payment_provider_events",
  "commercial_gate_policies",
  "commercial_gates",
  // COPS-04
  "cops_provisionings",
  "cops_provisioning_steps",
  // COPS-05 (cops_activation_templates is global or per workspace and is checked for the column only)
  "cops_onboarding_email_sends",
  "cops_follow_ups",
  "cops_onboarding_instances",
  "cops_onboarding_milestones",
  "cops_milestone_events",
  "cops_onboarding_signals",
  // COPS-06
  "engineering_tickets",
  "ticket_comments",
  "ticket_status_history",
  "ticket_account_summaries",
  // COPS-07
  "cops_config_versions",
] as const;

maybe("COPS-02 tables are tenant-isolated (Postgres)", () => {
  const sql = postgres(url as string, { max: 1 });
  const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 8);

  async function workspace(label: string): Promise<string> {
    const [row] = await sql`insert into workspaces (name, slug) values (${label}, ${"iso-" + label + "-" + stamp}) returning id`;
    return row.id as string;
  }

  /** Writes one row into every COPS-02 table for workspace `ws`, with its own parents. */
  async function seed(ws: string, label: string) {
    // The saved view needs an owner; create one so the test runs on any database.
    const [owner] = await sql`insert into users (email) values (${"iso-owner-" + label + "-" + stamp + "@example.test"}) returning id`;
    const [co] = await sql`insert into companies (workspace_id, name) values (${ws}, ${label + " co"}) returning id`;
    const [co2] = await sql`insert into companies (workspace_id, name) values (${ws}, ${label + " co 2"}) returning id`;
    const [ct] = await sql`insert into contacts (workspace_id, company_id, first_name, email) values (${ws}, ${co.id}, ${label}, ${label + "." + stamp + "@example.test"}) returning id`;
    const [pl] = await sql`insert into pipelines (workspace_id, name) values (${ws}, ${label + " pipeline"}) returning id`;
    const [st] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pl.id}, 'Qualified', 0) returning id`;
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name) values (${ws}, ${co.id}, ${pl.id}, ${st.id}, ${label + " deal"}) returning id`;
    const [def] = await sql`insert into custom_field_definitions (workspace_id, object_type, key, label, field_type) values (${ws}, 'account', ${"k" + stamp}, 'K', 'text') returning id`;

    await sql`insert into account_relationships (workspace_id, parent_account_id, child_account_id, relationship) values (${ws}, ${co.id}, ${co2.id}, 'subsidiary')`;
    await sql`insert into contact_channels (workspace_id, contact_id, channel, value) values (${ws}, ${ct.id}, 'email', ${label + "@x.test"})`;
    await sql`insert into opportunity_contacts (workspace_id, opportunity_id, contact_id) values (${ws}, ${deal.id}, ${ct.id})`;
    await sql`insert into tags (workspace_id, name) values (${ws}, ${"tag-" + label + stamp})`;
    await sql`insert into custom_field_values (workspace_id, definition_id, object_id, value) values (${ws}, ${def.id}, ${co.id}, '"v"'::jsonb)`;
    await sql`insert into cops_timeline_events (workspace_id, account_id, type, occurred_at, actor_type, source_event_id, event_type, summary) values (${ws}, ${co.id}, 'workflow_action', now(), 'system', gen_random_uuid(), 'LifecycleTransitioned', ${label})`;
    await sql`insert into cops_saved_views (workspace_id, owner_user_id, name, object_type) values (${ws}, ${owner.id}, ${"view-" + label}, 'account')`;
    await sql`insert into cops_account_merges (workspace_id, survivor_id, duplicate_id, duplicate_name, reason) values (${ws}, ${co.id}, ${co2.id}, ${label}, 'iso check')`;
    const [pr] = await sql`insert into proposals (workspace_id, opportunity_id, title) values (${ws}, ${deal.id}, ${label + " proposal"}) returning id`;
    const [pv] = await sql`insert into proposal_versions (workspace_id, proposal_id, version, currency, billing_cadence, term_months, subtotal_minor, discount_minor, tax_minor, total_minor) values (${ws}, ${pr.id}, 1, 'INR', 'annual', 12, 100, 0, 0, 100) returning id`;
    await sql`insert into proposal_line_items (workspace_id, version_id, position, kind, description, quantity, unit_amount_minor, gross_minor, discount_minor, net_minor) values (${ws}, ${pv.id}, 1, 'fee', ${label}, 1, 100, 100, 0, 100)`;
    const [cn] = await sql`insert into contracts (workspace_id, opportunity_id, kind, title) values (${ws}, ${deal.id}, 'msa', ${label + " msa"}) returning id`;
    await sql`insert into contract_versions (workspace_id, contract_id, version, document_url, file_sha256) values (${ws}, ${cn.id}, 1, 'https://x.test/msa.pdf', ${"0".repeat(64)})`;
    const [pq] = await sql`insert into payment_requests (workspace_id, opportunity_id, amount_minor, currency, provider, provider_ref, checkout_url) values (${ws}, ${deal.id}, 100, 'INR', 'test', ${"plink_" + label + stamp}, 'https://pay.test') returning id`;
    await sql`insert into payment_provider_events (workspace_id, provider, provider_event_id, event_type, payment_request_id, outcome) values (${ws}, 'test', ${"evt_" + label + stamp}, 'payment_link.paid', ${pq.id}, 'applied')`;
    await sql`insert into commercial_gate_policies (workspace_id, deal_type, policy) values (${ws}, '*', 'payment')`;
    await sql`insert into commercial_gates (workspace_id, opportunity_id) values (${ws}, ${deal.id})`;
    const [pv2] = await sql`insert into cops_provisionings (workspace_id, account_id, opportunity_id, idempotency_key, request) values (${ws}, ${co.id}, ${deal.id}, ${"iso-" + label + stamp}, '{}'::jsonb) returning id`;
    await sql`insert into cops_provisioning_steps (workspace_id, provisioning_id, step, position) values (${ws}, ${pv2.id}, 'create_workspace', 1)`;
    const [es] = await sql`insert into cops_onboarding_email_sends (workspace_id, account_id, to_email, template_key, template_version, subject, idempotency_key) values (${ws}, ${co.id}, ${label + "." + stamp + "@example.test"}, 'welcome_trial', 1, 'Welcome', ${"iso-" + label + stamp}) returning id`;
    const [task] = await sql`insert into tasks (workspace_id, title) values (${ws}, ${label + " enrollment task"}) returning id`;
    await sql`insert into cops_follow_ups (workspace_id, account_id, source_event_id, email_send_id, mode, task_id, task_reason) values (${ws}, ${co.id}, gen_random_uuid(), ${es.id}, 'task', ${task.id}, 'iso')`;
    const [tpl] = await sql`select id from cops_activation_templates where workspace_id is null and key = 'default_trial' and version = 1`;
    const [inst] = await sql`insert into cops_onboarding_instances (workspace_id, account_id, template_id, template_key, template_version) values (${ws}, ${co.id}, ${tpl.id}, 'default_trial', 1) returning id`;
    const [ms] = await sql`insert into cops_onboarding_milestones (workspace_id, instance_id, key, label, weight, source) values (${ws}, ${inst.id}, 'first_search', 'First search', 30, 'event') returning id`;
    await sql`insert into cops_milestone_events (workspace_id, milestone_id, source_ref, source_type) values (${ws}, ${ms.id}, ${"iso-" + label + stamp}, 'product.search')`;
    await sql`insert into cops_onboarding_signals (workspace_id, instance_id, trigger) values (${ws}, ${inst.id}, 'no_login_24h')`;
    const [tk] = await sql`insert into engineering_tickets (workspace_id, account_id, milestone_id, title) values (${ws}, ${co.id}, ${ms.id}, ${label + " ticket"}) returning id`;
    await sql`insert into ticket_comments (workspace_id, ticket_id, body) values (${ws}, ${tk.id}, 'iso note')`;
    await sql`insert into ticket_status_history (workspace_id, ticket_id, to_status) values (${ws}, ${tk.id}, 'new')`;
    await sql`insert into ticket_account_summaries (workspace_id, account_id, open_count, max_severity) values (${ws}, ${co.id}, 1, 'medium')`;
    await sql`insert into cops_config_versions (workspace_id, kind, key, version, value, reason) values (${ws}, 'feature_flags', 'default', 1, '{}'::jsonb, 'iso')`;
  }

  it("each table holds rows for its own workspace only", async () => {
    const a = await workspace("A");
    const b = await workspace("B");
    await seed(a, "A");
    await seed(b, "B");

    for (const table of TABLES) {
      const [own] = await sql.unsafe(`select count(*)::int as n from ${table} where workspace_id = $1`, [a]);
      const [other] = await sql.unsafe(`select count(*)::int as n from ${table} where workspace_id = $1`, [b]);
      expect(own.n, `${table} has rows for A`).toBeGreaterThan(0);
      expect(other.n, `${table} has rows for B`).toBeGreaterThan(0);
      // A query scoped to workspace B never returns A's rows.
      const leaked = await sql.unsafe(`select 1 from ${table} where workspace_id = $1 and workspace_id <> $1`, [b]);
      expect(leaked.length, `${table} leaks`).toBe(0);
    }
  });

  it("every COPS-02 table has a workspace_id column", async () => {
    for (const table of [...TABLES, "cops_activation_templates", "cops_onboarding_settings"]) {
      const [col] = await sql`select count(*)::int as n from information_schema.columns where table_name = ${table} and column_name = 'workspace_id'`;
      expect(col.n, `${table}.workspace_id`).toBe(1);
    }
  });

  it("closes the connection", async () => {
    await sql.end();
  });
});
