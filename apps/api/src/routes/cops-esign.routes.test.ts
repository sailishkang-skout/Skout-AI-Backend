import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { mockEsignSignature } from "../services/esign/esign-adapter.js";

/**
 * COPS-08 e-signature against a real Postgres (COPS_TEST_DATABASE_URL), on the mock provider.
 * Ticket acceptance: out-of-order e-sign webhooks converge; ContractSigned fires once. Also: a
 * version goes out once at a time, events are verified and deduplicated, the provisioning gate
 * opens on the provider's signature, and another workspace sees nothing.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

const stamp = Date.now();
const OWNER = `esign-owner-${stamp}@example.test`;
const OTHER = `esign-other-${stamp}@example.test`;
const SECRET = "test-esign-mock-webhook-secret";
const SHA = "b".repeat(64);
const signers = [{ name: "Asha Rao", email: "asha.rao@example.test", role: "Signer" }];

maybe("COPS-08 e-signature", () => {
  let app: FastifyInstance;
  let sql: any;
  let workspaceId = "";
  let pipelineId = "";
  let stageId = "";
  let companyId = "";

  const call = (method: "GET" | "POST" | "PUT", path: string, body?: unknown, email = OWNER) =>
    app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { "x-stub-user-email": email, ...(method !== "GET" ? { "idempotency-key": randomUUID() } : {}) },
      ...(body !== undefined ? { payload: body as object } : {}),
    });

  /** What the provider would post. No session: only the signature proves who is calling. */
  const webhook = (event: Record<string, unknown>, opts: { signature?: string; provider?: string } = {}) => {
    const payload = JSON.stringify({ event_id: randomUUID(), occurred_at: new Date().toISOString(), ...event });
    return app.inject({
      method: "POST",
      url: `/api/v1/esign/webhooks/${opts.provider ?? "mock"}`,
      headers: { "content-type": "application/json", "x-esign-signature": opts.signature ?? mockEsignSignature(SECRET, payload) },
      payload,
    });
  };

  const newContract = async (dealType?: string) => {
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name, amount, currency)
      values (${workspaceId}, ${companyId}, ${pipelineId}, ${stageId}, ${"E-sign deal " + randomUUID().slice(0, 8)}, 9480, 'USD') returning id`;
    if (dealType) await call("PUT", `/opportunities/${deal.id}/deal-type`, { deal_type: dealType });
    const created = await call("POST", `/opportunities/${deal.id}/contracts`, { kind: "msa", document_url: "https://docs.example.test/msa.pdf", file_sha256: SHA });
    expect(created.statusCode).toBe(201);
    return { opportunityId: deal.id as string, contractId: created.json().data.id as string };
  };
  const send = (contractId: string, email = OWNER) => call("POST", `/contracts/${contractId}/envelopes`, { signers }, email);
  const contractStatus = async (contractId: string) => (await sql`select status, signed_at, status_changed_by from contracts where id = ${contractId}`)[0];
  const signedEvents = async (contractId: string) => (await sql`select count(*)::int as n from cops_outbox where event_type = 'ContractSigned' and aggregate_id = ${contractId}`)[0].n as number;

  beforeAll(async () => {
    delete process.env.AUTH_MODE;
    process.env.AUTH_STUB = "true";
    process.env.CLERK_SECRET_KEY = "";
    const config = loadEnv();
    app = await buildApp({ ...config, DATABASE_URL: url, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, ESIGN_MOCK_WEBHOOK_SECRET: SECRET } as typeof config);
    sql = postgres(url as string, { max: 1, onnotice: () => {} });
    const [seeded] = await sql`select count(*)::int as n from roles where key = 'owner'`;
    if (seeded.n === 0) {
      const backfill = spawnSync("npx", ["tsx", "src/backfill-rbac.ts"], { cwd: new URL("../../../../packages/db/", import.meta.url), env: { ...process.env, DATABASE_URL: url }, shell: true, encoding: "utf8" });
      if (backfill.status !== 0) throw new Error(`backfill-rbac failed: ${backfill.stderr}`);
    }
    await app.ready();
    workspaceId = ((await call("GET", "/me")).json() as { workspaceId: string }).workspaceId;
    await call("GET", "/me", undefined, OTHER);
    const [pipeline] = await sql`insert into pipelines (workspace_id, name) values (${workspaceId}, 'E-sign test') returning id`;
    const [stage] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pipeline.id}, 'Contracting', 1) returning id`;
    const [company] = await sql`insert into companies (workspace_id, name) values (${workspaceId}, ${"E-sign Co " + stamp}) returning id`;
    pipelineId = pipeline.id;
    stageId = stage.id;
    companyId = company.id;
  });

  afterAll(async () => {
    await app?.close();
    await sql?.end();
  });

  it("sends a contract version for signature once, and marks the contract sent", async () => {
    const { contractId } = await newContract();
    const res = await send(contractId);
    expect(res.statusCode).toBe(201);
    const envelope = res.json().data;
    expect(envelope).toMatchObject({ status: "sent", provider: "mock", contract_version: 1, template_key: null, provider_ref: `mock_${envelope.id}` });
    expect(envelope.merge_fields).toMatchObject({ contract_title: expect.any(String), opportunity_name: expect.stringContaining("E-sign deal"), currency: "USD" });
    expect((await contractStatus(contractId)).status).toBe("sent");
    // The same version cannot go out twice while the first envelope is live.
    const again = await send(contractId);
    expect(again.statusCode).toBe(409);
    expect(again.json().details).toMatchObject({ envelope_id: envelope.id });
    expect((await sql`select count(*)::int as n from cops_outbox where event_type = 'ContractSent' and aggregate_id = ${contractId}`)[0].n).toBe(1);
  });

  it("refuses an event with a missing or wrong signature, and one for another provider", async () => {
    const { contractId } = await newContract();
    const envelope = (await send(contractId)).json().data;
    const event = { event_type: "envelope.signed", envelope_ref: envelope.provider_ref };
    expect((await webhook(event, { signature: "0".repeat(64) })).statusCode).toBe(401);
    expect((await webhook(event, { signature: "" })).statusCode).toBe(401);
    expect((await webhook(event, { provider: "dropbox_sign" })).statusCode).toBe(404);
    expect((await contractStatus(contractId)).status).toBe("sent");
  });

  it("out-of-order events converge, a duplicate changes nothing, and ContractSigned fires once", async () => {
    const { contractId } = await newContract();
    const envelope = (await send(contractId)).json().data;
    const ref = { envelope_ref: envelope.provider_ref };
    const signedAt = "2026-10-13T09:30:00.000Z";

    // The signature reaches us first, then the events that came before it at the provider.
    const signed = await webhook({ ...ref, event_id: `sig-${envelope.id}`, event_type: "envelope.signed", occurred_at: signedAt });
    expect(signed.json()).toMatchObject({ ok: true, duplicate: false, outcome: "applied", status: "signed" });
    expect((await webhook({ ...ref, event_type: "envelope.viewed", occurred_at: "2026-10-13T09:20:00.000Z" })).json()).toMatchObject({ outcome: "no_change", status: "signed" });
    expect((await webhook({ ...ref, event_type: "envelope.sent", occurred_at: "2026-10-13T09:00:00.000Z" })).json()).toMatchObject({ outcome: "no_change", status: "signed" });
    // The provider retries the signature, and later even reports an expiry.
    expect((await webhook({ ...ref, event_id: `sig-${envelope.id}`, event_type: "envelope.signed", occurred_at: signedAt })).json()).toMatchObject({ duplicate: true });
    expect((await webhook({ ...ref, event_type: "envelope.expired", occurred_at: "2026-10-13T10:00:00.000Z" })).json()).toMatchObject({ outcome: "no_change", status: "signed" });

    const contract = await contractStatus(contractId);
    expect(contract.status).toBe("signed");
    expect(new Date(contract.signed_at).toISOString()).toBe(signedAt);
    // Signed by the provider, not by a person.
    expect(contract.status_changed_by).toBeNull();
    expect(await signedEvents(contractId)).toBe(1);

    const [listed] = (await call("GET", `/contracts/${contractId}/envelopes`)).json().data;
    expect(listed.status).toBe("signed");
    // The timeline reads in the order things happened at the provider, not the order they arrived.
    expect(listed.events.map((e: { event_type: string }) => e.event_type)).toEqual(["envelope.sent", "envelope.viewed", "envelope.signed", "envelope.expired"]);
    const [audit] = await sql`select actor_type, actor_ref, source_channel from audit_logs where entity_id = ${contractId} and action = 'contract.signed'`;
    expect(audit).toMatchObject({ actor_type: "integration", actor_ref: "mock", source_channel: "webhook" });
  });

  it("the same events in the natural order end in the same place", async () => {
    const { contractId } = await newContract();
    const envelope = (await send(contractId)).json().data;
    const ref = { envelope_ref: envelope.provider_ref };
    expect((await webhook({ ...ref, event_type: "envelope.viewed" })).json()).toMatchObject({ outcome: "applied", status: "viewed" });
    expect((await webhook({ ...ref, event_type: "envelope.signed" })).json()).toMatchObject({ outcome: "applied", status: "signed" });
    expect((await contractStatus(contractId)).status).toBe("signed");
    expect(await signedEvents(contractId)).toBe(1);
  });

  it("a decline closes the contract, and a new send is refused on a closed contract", async () => {
    const { contractId } = await newContract();
    const envelope = (await send(contractId)).json().data;
    expect((await webhook({ envelope_ref: envelope.provider_ref, event_type: "envelope.declined" })).json()).toMatchObject({ outcome: "applied", status: "declined" });
    expect((await contractStatus(contractId)).status).toBe("declined");
    expect(await signedEvents(contractId)).toBe(0);
    expect((await send(contractId)).statusCode).toBe(409);
  });

  it("the provider's signature opens the provisioning gate, once", async () => {
    const dealType = `esign-signature-${stamp}`;
    await call("PUT", "/commercial/gate-policies", { deal_type: dealType, policy: "signature" });
    const { contractId, opportunityId } = await newContract(dealType);
    const envelope = (await send(contractId)).json().data;
    const event = { envelope_ref: envelope.provider_ref, event_id: `gate-${envelope.id}`, event_type: "envelope.signed" };
    await webhook(event);
    await webhook(event);
    const fired = await sql`select count(*)::int as n from cops_outbox where event_type = 'ProvisioningRequested' and aggregate_id = ${opportunityId}`;
    expect(fired[0].n).toBe(1);
    expect((await call("GET", `/opportunities/${opportunityId}/gate`)).json().data).toMatchObject({ open: true });
  });

  it("an event that matches no envelope is kept for reconciliation, and one we do not act on is ignored", async () => {
    const orphan = await webhook({ envelope_ref: `mock_${randomUUID()}`, event_id: `orphan-${stamp}`, event_type: "envelope.signed" });
    expect(orphan.json()).toMatchObject({ ok: true, outcome: "unmatched" });
    const [kept] = await sql`select workspace_id, envelope_id, outcome from signature_events where provider_event_id = ${"orphan-" + stamp}`;
    expect(kept).toMatchObject({ workspace_id: null, envelope_id: null, outcome: "unmatched" });

    const { contractId } = await newContract();
    const envelope = (await send(contractId)).json().data;
    expect((await webhook({ envelope_ref: envelope.provider_ref, event_type: "envelope.reminder_sent" })).json()).toMatchObject({ outcome: "ignored", status: "sent" });
  });

  it("an envelope whose provider reference was never saved is found by our own id", async () => {
    const { contractId } = await newContract();
    const envelope = (await send(contractId)).json().data;
    // As if the process died after the provider accepted the envelope and before we recorded it.
    await sql`update signature_envelopes set provider_ref = null, status = 'pending_send' where id = ${envelope.id}`;
    const res = await webhook({ envelope_ref: envelope.provider_ref, reference_id: envelope.id, event_type: "envelope.viewed" });
    expect(res.json()).toMatchObject({ outcome: "applied", status: "viewed" });
    const [row] = await sql`select provider_ref, status from signature_envelopes where id = ${envelope.id}`;
    expect(row).toMatchObject({ provider_ref: envelope.provider_ref, status: "viewed" });
  });

  it("a version negotiated outside Skout is attached as a new version with its redline status, and can then be sent", async () => {
    const { contractId } = await newContract();
    const first = (await send(contractId)).json().data;
    const attached = await call("POST", `/contracts/${contractId}/negotiated-versions`, { document_url: "https://docs.example.test/msa-redline.pdf", file_sha256: "e".repeat(64), redline_status: "customer_redline", note: "Customer legal changed clause 7" });
    expect(attached.statusCode).toBe(201);
    expect(attached.json().data).toMatchObject({ current_version: 2, redline_status: "customer_redline" });
    // The first version is untouched, and an unknown redline status is refused.
    const versions = await sql`select version, file_sha256, sent_at is not null as sent from contract_versions where contract_id = ${contractId} order by version`;
    expect(versions).toEqual([{ version: 1, file_sha256: SHA, sent: true }, { version: 2, file_sha256: "e".repeat(64), sent: false }]);
    expect((await call("POST", `/contracts/${contractId}/negotiated-versions`, { document_url: "x", file_sha256: "e".repeat(64), redline_status: "done" })).statusCode).toBe(422);

    // The agreed version goes out as its own envelope; an event for the old one no longer moves the contract.
    await call("POST", `/contracts/${contractId}/negotiated-versions`, { document_url: "https://docs.example.test/msa-final.pdf", file_sha256: "f".repeat(64), redline_status: "agreed" });
    const second = await send(contractId);
    expect(second.statusCode).toBe(201);
    expect(second.json().data).toMatchObject({ contract_version: 3 });
    await webhook({ envelope_ref: first.provider_ref, event_type: "envelope.signed" });
    expect((await contractStatus(contractId)).status).toBe("sent");
    await webhook({ envelope_ref: second.json().data.provider_ref, event_type: "envelope.signed" });
    expect((await contractStatus(contractId)).status).toBe("signed");
    expect(await signedEvents(contractId)).toBe(1);
  });

  it("another workspace cannot send or see these envelopes", async () => {
    const { contractId } = await newContract();
    await send(contractId);
    expect((await send(contractId, OTHER)).statusCode).toBe(404);
    expect((await call("GET", `/contracts/${contractId}/envelopes`, undefined, OTHER)).json().data).toEqual([]);
  });
});
