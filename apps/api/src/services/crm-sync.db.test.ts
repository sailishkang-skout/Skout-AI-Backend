import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { HttpError } from "@skout/auth";
import { createDb } from "@skout/db";
import type { Env } from "../config/env.js";
import { getPendingConflictFields, recordCrmConflict, resolveCrmConflict } from "./crm-conflict.service.js";
import { applyInboundMapping, DEFAULT_HUBSPOT_CONTACT_MAPPING, getCrmMappingHistory, getResolvedCrmMapping, saveCrmMappings } from "./crm-mapping.service.js";
import { markConnectionNeedsReauth } from "./crm-auth-lifecycle.service.js";
import { detectSchemaDrift, getCrmConnectorHealth, replayCrmOutboundWrite } from "./crm-observability.service.js";
import { POLL_FAILURE_ALERT_THRESHOLD, runScheduledCrmPoll } from "./crm-initial-import.service.js";
import { getRecordSyncHistory, listInboundSyncHistory, recordInboundSync } from "./crm-sync-history.service.js";

// postgres is a dependency of packages/db; resolve it from there.
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/**
 * COPS-09 CRM sync against real Postgres: the conflict queue, mapping versions, the expired-grant
 * transition, health, DLQ replay, drift alerts and the scheduled poll. Runs only when
 * COPS_TEST_DATABASE_URL is set.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

// No HubSpot app credentials: the poll's sync fails with hubspot_not_configured, which is what the
// failure-counting test needs, and nothing here can reach HubSpot.
const config = { HUBSPOT_CLIENT_ID: undefined, HUBSPOT_CLIENT_SECRET: undefined } as unknown as Env;

maybe("COPS-09 CRM sync (Postgres)", () => {
  const sql = postgres(url as string, { max: 1 });
  const { db } = createDb(url as string);

  async function fixture(settings: Record<string, unknown> = { syncEnabled: true }) {
    const tag = randomUUID().slice(0, 8);
    const [ws] = await sql`insert into workspaces (name, slug) values (${`crm-${tag}`}, ${`crm-sync-${tag}`}) returning id`;
    const [conn] = await sql`insert into crm_connections (workspace_id, provider, status, settings) values (${ws.id}, 'hubspot', 'connected', ${sql.json(settings)}) returning id`;
    const admins: string[] = [];
    for (const key of ["owner", "admin"]) {
      const [user] = await sql`insert into users (email) values (${`${key}-${tag}@skout.test`}) returning id`;
      const [role] = await sql`select id from roles where key = ${key} and workspace_id is null`;
      await sql`insert into workspace_members (workspace_id, user_id, role) values (${ws.id}, ${user.id}, ${key})`;
      await sql`insert into workspace_member_roles (workspace_id, user_id, role_id) values (${ws.id}, ${user.id}, ${role.id})`;
      admins.push(user.id);
    }
    const [contact] = await sql`insert into contacts (workspace_id, first_name, email, title) values (${ws.id}, 'Priya', ${`priya-${tag}@acme.test`}, 'VP Sales') returning id`;
    const [pipeline] = await sql`insert into pipelines (workspace_id, name) values (${ws.id}, 'Sales') returning id`;
    const [stage] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pipeline.id}, 'New', 0) returning id`;
    const [deal] = await sql`insert into deals (workspace_id, pipeline_id, stage_id, name, amount) values (${ws.id}, ${pipeline.id}, ${stage.id}, 'Acme MSA', 1200) returning id`;
    return { workspaceId: ws.id as string, connectionId: conn.id as string, contactId: contact.id as string, dealId: deal.id as string, admins };
  }

  const conflictOf = (f: Awaited<ReturnType<typeof fixture>>, fieldName: string, externalValue: string, entity: "contact" | "deal" = "deal") => ({
    workspaceId: f.workspaceId,
    connectionId: f.connectionId,
    entityType: entity,
    entityId: entity === "deal" ? f.dealId : f.contactId,
    externalId: `hs-${entity}`,
    fieldName,
    skoutValue: entity === "deal" ? "1200" : "VP Sales",
    externalValue,
    policy: "manual_review" as const,
  });

  it("keeps one pending conflict per field: a repeat refreshes it instead of queueing a duplicate", async () => {
    const f = await fixture();
    const first = await recordCrmConflict(db, conflictOf(f, "amount", "900"));
    const second = await recordCrmConflict(db, conflictOf(f, "amount", "950"));
    expect(second).toBe(first);
    const rows = await sql`select external_value, status from crm_conflicts where entity_id = ${f.dealId}`;
    expect(rows).toEqual([{ external_value: "950", status: "pending" }]);
    expect(await getPendingConflictFields(db, f.workspaceId, f.connectionId, "deal", f.dealId)).toEqual(new Set(["amount"]));
  });

  it("resolving applies the chosen value with the column's type, audits it, and a second resolve is refused", async () => {
    const f = await fixture();
    const id = await recordCrmConflict(db, conflictOf(f, "amount", "900"));
    const result = await resolveCrmConflict(db, f.workspaceId, id, { choice: "external", resolvedBy: f.admins[1] });
    expect(result).toMatchObject({ status: "resolved_external", resolvedValue: "900" });

    const [deal] = await sql`select amount from deals where id = ${f.dealId}`;
    expect(Number(deal.amount)).toBe(900);
    const audits = await sql`select action, actor_id from audit_logs where workspace_id = ${f.workspaceId} and entity_id = ${f.dealId}`;
    expect(audits).toEqual([{ action: "crm_conflict.external_applied", actor_id: f.admins[1] }]);

    await expect(resolveCrmConflict(db, f.workspaceId, id, { choice: "skout" })).rejects.toMatchObject({ statusCode: 409 });
    // Resolved, the field is free again: a new difference queues a new conflict.
    expect(await getPendingConflictFields(db, f.workspaceId, f.connectionId, "deal", f.dealId)).toEqual(new Set());
  });

  it("choosing Skout's value keeps the record and queues it for push-back to the provider", async () => {
    const f = await fixture();
    await sql`insert into crm_native_links (workspace_id, connection_id, entity_type, entity_id, external_id) values (${f.workspaceId}, ${f.connectionId}, 'contact', ${f.contactId}, 'hs-contact')`;
    const id = await recordCrmConflict(db, conflictOf(f, "title", "Head of Sales", "contact"));
    await resolveCrmConflict(db, f.workspaceId, id, { choice: "skout" });

    const [contact] = await sql`select title from contacts where id = ${f.contactId}`;
    expect(contact.title).toBe("VP Sales");
    const writes = await sql`select patch, status from crm_outbound_writes where entity_id = ${f.contactId}`;
    expect(writes).toEqual([{ patch: { title: "VP Sales" }, status: "pending" }]);
    // The outbound worker's tests claim any pending write; leave none behind.
    await sql`delete from crm_outbound_writes where workspace_id = ${f.workspaceId}`;
  });

  it("refuses a value the column cannot hold, and leaves the conflict pending (the transaction rolls back)", async () => {
    const f = await fixture();
    const id = await recordCrmConflict(db, conflictOf(f, "amount", "900"));
    const err = await resolveCrmConflict(db, f.workspaceId, id, { choice: "custom", customValue: "a lot" }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.statusCode).toBe(422);
    const [row] = await sql`select status from crm_conflicts where id = ${id}`;
    expect(row.status).toBe("pending");
    const protectedId = await recordCrmConflict(db, conflictOf(f, "workspaceId", randomUUID()));
    await expect(resolveCrmConflict(db, f.workspaceId, protectedId, { choice: "external" })).rejects.toMatchObject({ statusCode: 422 });
  });

  it("a conflict of another workspace is not found", async () => {
    const f = await fixture();
    const other = await fixture();
    const id = await recordCrmConflict(db, conflictOf(f, "amount", "900"));
    await expect(resolveCrmConflict(db, other.workspaceId, id, { choice: "external" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("saving mappings makes a new version, keeps the replaced one in history, and audits the change", async () => {
    const f = await fixture();
    const edited = { ...DEFAULT_HUBSPOT_CONTACT_MAPPING, version: 99, fields: DEFAULT_HUBSPOT_CONTACT_MAPPING.fields.slice(0, 2) };
    await saveCrmMappings(db, f.workspaceId, "hubspot", { contact: edited }, f.admins[0]);
    await saveCrmMappings(db, f.workspaceId, "hubspot", { contact: DEFAULT_HUBSPOT_CONTACT_MAPPING }, f.admins[0]);

    const current = await getResolvedCrmMapping(db, f.workspaceId, "hubspot", "contact");
    // The client's version number is ignored: default v1, then v2, then v3.
    expect(current.version).toBe(3);
    const history = await getCrmMappingHistory(db, f.workspaceId, "hubspot", "contact");
    expect(history.map((h) => h.version)).toEqual([2, 1]);
    expect(history[0]!.mapping.fields).toHaveLength(2);
    const audits = await sql`select count(*)::int as n from audit_logs where workspace_id = ${f.workspaceId} and action = 'crm_mapping.updated'`;
    expect(audits[0].n).toBe(2);
    // Other settings survive a mapping save.
    const [conn] = await sql`select settings from crm_connections where id = ${f.connectionId}`;
    expect(conn.settings.syncEnabled).toBe(true);
  });

  it("an expired grant marks the connection needs_reauth and alerts Admin and Owner once", async () => {
    const f = await fixture();
    await markConnectionNeedsReauth(db, config, { workspaceId: f.workspaceId, provider: "hubspot", reason: "invalid_grant" });
    await markConnectionNeedsReauth(db, config, { workspaceId: f.workspaceId, provider: "hubspot", reason: "invalid_grant" });

    const [conn] = await sql`select status, settings from crm_connections where id = ${f.connectionId}`;
    expect(conn.status).toBe("needs_reauth");
    expect(conn.settings).toMatchObject({ syncEnabled: true, lastAuthError: "invalid_grant" });
    const notes = await sql`select user_id from notifications where workspace_id = ${f.workspaceId} and type = 'crm_grant_expired'`;
    expect(notes.map((n: { user_id: string }) => n.user_id).sort()).toEqual([...f.admins].sort());

    const health = await getCrmConnectorHealth(db, f.workspaceId, "hubspot");
    expect(health.authStatus).toBe("needs_reauth");
  });

  it("health reads the rate-limit state recorded on the connection", async () => {
    const until = new Date(Date.now() + 60_000).toISOString();
    const f = await fixture({ syncEnabled: true, rateLimit: { lastRateLimitedAt: new Date().toISOString(), limitedUntil: until, retryAfterMs: 60_000 } });
    const health = await getCrmConnectorHealth(db, f.workspaceId, "hubspot");
    expect(health.authStatus).toBe("connected");
    expect(health.rateLimitState).toMatchObject({ isRateLimited: true, limitedUntil: until });
  });

  it("replay re-queues a failed write once, and refuses a write held back by a conflict", async () => {
    const f = await fixture();
    const insert = async (lastError: string) => {
      const [w] = await sql`insert into crm_outbound_writes (workspace_id, connection_id, entity_type, entity_id, patch, skout_changed_at, idempotency_key, status, last_error)
        values (${f.workspaceId}, ${f.connectionId}, 'contact', ${f.contactId}, ${sql.json({ title: "X" })}, now(), ${randomUUID()}, 'failed', ${lastError}) returning id`;
      return w.id as string;
    };
    const failed = await insert("HubSpot API x failed: 500");
    await expect(replayCrmOutboundWrite(db, f.workspaceId, failed, f.admins[0])).resolves.toMatchObject({ status: "pending" });
    await expect(replayCrmOutboundWrite(db, f.workspaceId, failed, f.admins[0])).rejects.toMatchObject({ statusCode: 409 });

    const held = await insert("blocked_by_pending_conflict");
    await expect(replayCrmOutboundWrite(db, f.workspaceId, held)).rejects.toMatchObject({ statusCode: 409 });
    await sql`delete from crm_outbound_writes where workspace_id = ${f.workspaceId}`;
  });

  it("schema drift alerts the admins once a day for the same missing fields", async () => {
    const f = await fixture();
    const present = ["email", "firstname", "lastname", "phone"]; // jobtitle is missing
    const first = await detectSchemaDrift(db, config, f.workspaceId, "hubspot", "contact", present);
    await detectSchemaDrift(db, config, f.workspaceId, "hubspot", "contact", present);
    expect(first).toEqual({ driftDetected: true, missingFields: ["jobtitle"] });
    const notes = await sql`select count(*)::int as n from notifications where workspace_id = ${f.workspaceId} and type = 'crm_schema_drift'`;
    expect(notes[0].n).toBe(2); // owner and admin, once each
  });

  it("the scheduled poll skips opted-out connections, waits for the interval, and alerts after repeated failures", async () => {
    const f = await fixture({ syncEnabled: true, pollIntervalMinutes: 30 });
    const off = await fixture({ syncEnabled: false });
    const start = Date.parse("2030-01-01T00:00:00Z");
    const mine = (r: Awaited<ReturnType<typeof runScheduledCrmPoll>>, ws: string) => r.results.filter((x) => x.workspaceId === ws);

    const r1 = await runScheduledCrmPoll(db, config, new Date(start));
    expect(mine(r1, f.workspaceId)).toEqual([expect.objectContaining({ success: false, error: "hubspot_not_configured" })]);
    expect(mine(r1, off.workspaceId)).toEqual([]);
    // Ten minutes later the 30-minute interval has not passed.
    expect(mine(await runScheduledCrmPoll(db, config, new Date(start + 10 * 60_000)), f.workspaceId)).toEqual([]);

    for (let i = 1; i < POLL_FAILURE_ALERT_THRESHOLD + 1; i++) {
      await runScheduledCrmPoll(db, config, new Date(start + i * 31 * 60_000));
    }
    const [conn] = await sql`select settings from crm_connections where id = ${f.connectionId}`;
    expect(conn.settings.pollFailures).toBe(POLL_FAILURE_ALERT_THRESHOLD + 1);
    const notes = await sql`select count(*)::int as n from notifications where workspace_id = ${f.workspaceId} and type = 'crm_sync_failing'`;
    expect(notes[0].n).toBe(2); // owner and admin, once for the day
  });

  it("a record's sync history merges pulls, pushes and conflicts, newest first", async () => {
    const f = await fixture();
    const base = { workspaceId: f.workspaceId, connectionId: f.connectionId, entityType: "contact" as const, externalId: "hs-h1" };
    await recordInboundSync(db, { ...base, entityId: f.contactId, outcome: "created", fields: ["email", "title"] });
    await sql`insert into crm_outbound_writes (workspace_id, connection_id, entity_type, entity_id, patch, skout_changed_at, idempotency_key, status, last_error, created_at)
      values (${f.workspaceId}, ${f.connectionId}, 'contact', ${f.contactId}, ${sql.json({ phone: "1" })}, now(), ${randomUUID()}, 'failed', 'HubSpot API x failed: 500', now() + interval '1 second')`;
    await recordCrmConflict(db, conflictOf(f, "title", "Head of Sales", "contact"));
    await recordInboundSync(db, { ...base, entityId: f.contactId, outcome: "held_by_conflict", heldFields: ["title"] });
    // A record skipped before matching has no Skout id and only shows in the workspace list.
    await recordInboundSync(db, { ...base, externalId: "hs-h2", outcome: "skipped_invalid", detail: "no email address" });

    const history = await getRecordSyncHistory(db, f.workspaceId, "contact", f.contactId);
    expect(history.map((h) => `${h.direction}:${h.status}`).sort()).toEqual(
      ["conflict:pending", "inbound:created", "inbound:held_by_conflict", "outbound:failed"].sort()
    );
    expect(history.find((h) => h.status === "held_by_conflict")!.fields).toEqual(["title (held)"]);
    expect(history.find((h) => h.direction === "outbound")!.detail).toBe("HubSpot API x failed: 500");

    const skipped = await listInboundSyncHistory(db, f.workspaceId, { outcome: "skipped_invalid" });
    expect(skipped.map((r) => r.externalId)).toEqual(["hs-h2"]);
    // Another workspace sees none of it.
    const other = await fixture();
    expect(await getRecordSyncHistory(db, other.workspaceId, "contact", f.contactId)).toEqual([]);
    await sql`delete from crm_outbound_writes where workspace_id = ${f.workspaceId}`;
  });

  it("a blank provider value clears the Skout field only when the mapping says overwrite", () => {
    const field = (nullBehavior: "preserve" | "ignore" | "overwrite") => ({
      ...DEFAULT_HUBSPOT_CONTACT_MAPPING,
      fields: [{ id: "t", internalField: "title", externalField: "jobtitle", direction: "inbound" as const, nullBehavior }],
    });
    expect(applyInboundMapping(field("overwrite"), { jobtitle: "" }).patch).toEqual({ title: null });
    expect(applyInboundMapping(field("preserve"), { jobtitle: "" }).patch).toEqual({});
    expect(applyInboundMapping(field("ignore"), { jobtitle: null }).patch).toEqual({});
  });

  it("closes the connections", async () => {
    await sql.end();
  });
});
