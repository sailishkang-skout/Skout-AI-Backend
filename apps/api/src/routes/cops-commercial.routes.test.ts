import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { projectCopsEventToTimelineRow } from "../services/cops-timeline.service.js";

/**
 * COPS-03 proposals and contracts against a real Postgres (COPS_TEST_DATABASE_URL). Covers the
 * acceptance items for this slice: sent versions cannot be mutated (API, DB trigger and hash check),
 * edits create versions, manual status needs a reason, events and audit rows are written, a role
 * without commercial permissions gets 403 and another workspace cannot read the records.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (
  url: string,
  options?: object
) => any;

const OWNER = `commercial-owner-${Date.now()}@example.test`;
const OTHER = `commercial-other-${Date.now()}@example.test`;
const SHA = "a".repeat(64);

maybe("COPS-03 proposals and contracts", () => {
  let app: FastifyInstance;
  let sql: any;
  let workspaceId = "";
  let opportunityId = "";
  let companyId = "";

  const call = (method: "GET" | "POST", path: string, body?: unknown, email = OWNER, key: string | null = randomUUID()) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { "x-stub-user-email": email, ...(key && method === "POST" ? { "idempotency-key": key } : {}) },
      ...(body !== undefined ? { payload: body as object } : {}),
    });

  const terms = {
    title: "Acme annual",
    currency: "INR",
    billing_cadence: "annual",
    term_months: 12,
    tax_pct: 18,
    line_items: [
      { kind: "seats", description: "Seats", quantity: 10, unit_amount_minor: 100_000, discount_pct: 10 },
      { kind: "fee", description: "Onboarding", quantity: 1, unit_amount_minor: 50_000 },
    ],
  };

  beforeAll(async () => {
    delete process.env.AUTH_MODE;
    process.env.AUTH_STUB = "true";
    process.env.CLERK_SECRET_KEY = "";
    const config = loadEnv();
    app = await buildApp({ ...config, DATABASE_URL: url, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined } as typeof config);
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
    const [roles] = await sql`select count(*)::int as n from roles where key = 'owner'`;
    if (roles.n === 0) {
      const backfill = spawnSync("npx", ["tsx", "src/backfill-rbac.ts"], {
        cwd: new URL("../../../../packages/db/", import.meta.url),
        env: { ...process.env, DATABASE_URL: url },
        shell: true,
        encoding: "utf8",
      });
      if (backfill.status !== 0) throw new Error(`backfill-rbac failed: ${backfill.stderr}`);
    }
    await app.ready();
    workspaceId = ((await call("GET", "/me")).json() as { workspaceId: string }).workspaceId;
    await call("GET", "/me", undefined, OTHER);
    const [pipeline] = await sql`insert into pipelines (workspace_id, name) values (${workspaceId}, 'Commercial test') returning id`;
    const [stage] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pipeline.id}, 'Commercial', 1) returning id`;
    const [company] = await sql`insert into companies (workspace_id, name) values (${workspaceId}, ${"Commercial Co " + Date.now()}) returning id`;
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name, amount, currency)
      values (${workspaceId}, ${company.id}, ${pipeline.id}, ${stage.id}, 'Acme deal', 12000, 'INR') returning id`;
    opportunityId = deal.id;
    companyId = company.id;
  });

  afterAll(async () => {
    await app?.close();
    await sql?.end();
  });

  it("creates a proposal with computed totals as version 1 (draft)", async () => {
    const res = await call("POST", `/opportunities/${opportunityId}/proposals`, terms);
    expect(res.statusCode).toBe(201);
    const p = res.json().data;
    expect(p).toMatchObject({ status: "draft", current_version: 1 });
    expect(p.versions[0].totals).toEqual({ subtotal_minor: 1_050_000, discount_minor: 100_000, tax_minor: 171_000, total_minor: 1_121_000 });
    expect(p.versions[0]).toMatchObject({ sent_at: null, content_hash: null, hash_valid: null });
  });

  it("rejects invalid terms with field paths and an unknown opportunity with 404", async () => {
    const bad = await call("POST", `/opportunities/${opportunityId}/proposals`, { ...terms, line_items: [{ ...terms.line_items[0], quantity: 0 }] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().details.fields[0].path).toBe("line_items.0.quantity");
    const missing = await call("POST", `/opportunities/${randomUUID()}/proposals`, terms);
    expect(missing.statusCode).toBe(404);
  });

  it("sends, freezes the version, writes audit and ProposalSent, and refuses a second send", async () => {
    const created = (await call("POST", `/opportunities/${opportunityId}/proposals`, terms)).json().data;
    const sent = await call("POST", `/proposals/${created.id}/send`, {});
    expect(sent.statusCode).toBe(200);
    const v1 = sent.json().data.versions[0];
    expect(sent.json().data.status).toBe("sent");
    expect(v1.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(v1.hash_valid).toBe(true);

    const again = await call("POST", `/proposals/${created.id}/send`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("BUSINESS_STATE_CONFLICT");

    const [event] = await sql`select envelope->'payload' as payload from cops_outbox where tenant_id = ${workspaceId} and event_type = 'ProposalSent' and aggregate_id = ${created.id}`;
    expect(event.payload).toMatchObject({ proposal_id: created.id, opportunity_id: opportunityId });
    const [audit] = await sql`select action from audit_logs where workspace_id = ${workspaceId} and entity_id = ${created.id} and action = 'proposal.sent'`;
    expect(audit).toBeTruthy();

    // The event reaches the account timeline through the opportunity (COPS-02 projector).
    const [row] = await sql`select envelope from cops_outbox where tenant_id = ${workspaceId} and event_type = 'ProposalSent' and aggregate_id = ${created.id}`;
    expect(await projectCopsEventToTimelineRow((app as unknown as { db: never }).db, row.envelope)).toBe(true);
    const [timeline] = await sql`select type from cops_timeline_events where workspace_id = ${workspaceId} and account_id = ${companyId} and source_event_id = ${row.envelope.event_id}`;
    expect(timeline.type).toBe("proposal");
  });

  it("blocks UPDATE of a sent version and its line items in the database, and detects tampering", async () => {
    const created = (await call("POST", `/opportunities/${opportunityId}/proposals`, terms)).json().data;
    await call("POST", `/proposals/${created.id}/send`, {});
    const versionId = created.versions[0].id;
    await expect(sql`update proposal_versions set total_minor = 1 where id = ${versionId}`).rejects.toThrow(/immutable/);
    await expect(sql`update proposal_line_items set unit_amount_minor = 1 where version_id = ${versionId}`).rejects.toThrow(/immutable/);
    await expect(
      sql`insert into proposal_line_items (workspace_id, version_id, position, kind, description, quantity, unit_amount_minor, gross_minor, discount_minor, net_minor)
          values (${workspaceId}, ${versionId}, 99, 'fee', 'sneaky', 1, 1, 1, 0, 1)`
    ).rejects.toThrow(/immutable/);

    // A line removed behind the API's back (DELETE stays possible for retention) is caught by the hash.
    await sql`delete from proposal_line_items where version_id = ${versionId} and position = 2`;
    const read = (await call("GET", `/proposals/${created.id}`)).json().data;
    expect(read.versions[0].hash_valid).toBe(false);
  });

  it("edits create a new version and leave the sent one unchanged", async () => {
    const created = (await call("POST", `/opportunities/${opportunityId}/proposals`, terms)).json().data;
    const sentV1 = (await call("POST", `/proposals/${created.id}/send`, {})).json().data.versions[0];
    const edited = await call("POST", `/proposals/${created.id}/versions`, { ...terms, title: undefined, discount_pct: 5 });
    expect(edited.statusCode).toBe(201);
    const body = edited.json().data;
    expect(body).toMatchObject({ status: "draft", current_version: 2 });
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0]).toEqual(sentV1);
    expect(body.versions[1].sent_at).toBeNull();
    expect(body.versions[1].totals.total_minor).toBeLessThan(sentV1.totals.total_minor);
  });

  it("manual status needs a sent proposal and a reason", async () => {
    const created = (await call("POST", `/opportunities/${opportunityId}/proposals`, terms)).json().data;
    expect((await call("POST", `/proposals/${created.id}/status`, { status: "accepted", reason: "ok" })).statusCode).toBe(409);
    await call("POST", `/proposals/${created.id}/send`, {});
    expect((await call("POST", `/proposals/${created.id}/status`, { status: "accepted", reason: " " })).statusCode).toBe(422);
    const ok = await call("POST", `/proposals/${created.id}/status`, { status: "accepted", reason: "Customer confirmed by email" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toMatchObject({ status: "accepted", status_reason: "Customer confirmed by email" });
    expect((await call("POST", `/proposals/${created.id}/versions`, { ...terms, title: undefined })).statusCode).toBe(409);
  });

  it("replays an Idempotency-Key and rejects a missing one", async () => {
    const key = randomUUID();
    const first = await call("POST", `/opportunities/${opportunityId}/proposals`, terms, OWNER, key);
    const second = await call("POST", `/opportunities/${opportunityId}/proposals`, terms, OWNER, key);
    expect(second.statusCode).toBe(201);
    expect(second.json().data.id).toBe(first.json().data.id);
    expect((await call("POST", `/opportunities/${opportunityId}/proposals`, terms, OWNER, null)).statusCode).toBe(422);
  });

  it("contract: create, send (msa_pending + ContractSent), sign with reason (ContractSigned)", async () => {
    const created = await call("POST", `/opportunities/${opportunityId}/contracts`, { kind: "msa", document_url: "https://docs.example.test/msa.pdf", file_sha256: SHA });
    expect(created.statusCode).toBe(201);
    const contract = created.json().data;
    expect(contract).toMatchObject({ kind: "msa", status: "draft", title: "Master Services Agreement" });
    expect((await call("POST", `/contracts/${contract.id}/status`, { status: "signed", reason: "x" })).statusCode).toBe(409);

    const sent = await call("POST", `/contracts/${contract.id}/send`, {});
    expect(sent.statusCode).toBe(200);
    expect(sent.json().data.versions[0].sent_at).not.toBeNull();
    await expect(sql`update contract_versions set document_url = 'x' where contract_id = ${contract.id}`).rejects.toThrow(/immutable/);
    const [state] = await sql`select state from cops_lifecycle_states where workspace_id = ${workspaceId} and dimension = 'commercial' and entity_id = ${opportunityId}`;
    expect(state.state).toBe("msa_pending");

    const signed = await call("POST", `/contracts/${contract.id}/status`, { status: "signed", reason: "Signed copy received" });
    expect(signed.statusCode).toBe(200);
    expect(signed.json().data.signed_at).not.toBeNull();
    const events = await sql`select event_type from cops_outbox where tenant_id = ${workspaceId} and aggregate_id = ${contract.id} order by created_at`;
    expect(events.map((e: { event_type: string }) => e.event_type)).toEqual(["ContractSent", "ContractSigned"]);
    const [audit] = await sql`select reason from audit_logs where entity_id = ${contract.id} and action = 'contract.signed'`;
    expect(audit.reason).toBe("Signed copy received");
  });

  it("another workspace cannot read or change these records", async () => {
    const created = (await call("POST", `/opportunities/${opportunityId}/proposals`, terms)).json().data;
    expect((await call("GET", `/proposals/${created.id}`, undefined, OTHER)).statusCode).toBe(404);
    expect((await call("POST", `/proposals/${created.id}/send`, {}, OTHER)).statusCode).toBe(404);
    expect((await call("POST", `/opportunities/${opportunityId}/proposals`, terms, OTHER)).statusCode).toBe(404);
  });

  it("a role without commercial permissions gets 403", async () => {
    const [other] = await sql`select u.id as user_id, wm.workspace_id from users u join workspace_members wm on wm.user_id = u.id where u.email = ${OTHER}`;
    const [member] = await sql`select id from roles where key = 'member' and workspace_id is null`;
    await sql`delete from workspace_member_roles where workspace_id = ${other.workspace_id} and user_id = ${other.user_id}`;
    await sql`insert into workspace_member_roles (workspace_id, user_id, role_id) values (${other.workspace_id}, ${other.user_id}, ${member.id})`;
    const res = await call("GET", `/proposals/${randomUUID()}`, undefined, OTHER);
    expect(res.statusCode).toBe(403);
    expect(res.json().details.required_permission).toBe("commercial:read");
  });
});
