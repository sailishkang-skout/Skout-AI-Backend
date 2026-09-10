import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { applyManualEntityPatch } from "./crm-native-entity.service.js";

const { workspaces, contacts, deals, pipelines, pipelineStages, crmConnections, crmNativeLinks, crmOutboundWrites, evidenceLedger } =
  schema;

describe("applyManualEntityPatch", () => {
  const config = loadEnv();
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  let workspaceId: string;
  let otherWorkspaceId: string;
  let connectionId: string;
  let contactId: string;
  let dealId: string;

  beforeAll(async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name: `Manual Patch Test WS ${Date.now()}`, slug: `manual-patch-test-${Date.now()}` })
      .returning();
    workspaceId = ws!.id;

    const [otherWs] = await db
      .insert(workspaces)
      .values({ name: `Manual Patch Other WS ${Date.now()}`, slug: `manual-patch-other-${Date.now()}` })
      .returning();
    otherWorkspaceId = otherWs!.id;

    const [conn] = await db.insert(crmConnections).values({ workspaceId, provider: "hubspot" }).returning();
    connectionId = conn!.id;

    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId, firstName: "Grace", email: "grace@example.com" })
      .returning();
    contactId = contact!.id;

    const [pipeline] = await db.insert(pipelines).values({ workspaceId, name: "Default" }).returning();
    const [stage] = await db
      .insert(pipelineStages)
      .values({ pipelineId: pipeline!.id, name: "Open", orderIndex: 1 })
      .returning();
    const [deal] = await db
      .insert(deals)
      .values({ workspaceId, pipelineId: pipeline!.id, stageId: stage!.id, name: "Acme Deal" })
      .returning();
    dealId = deal!.id;
  });

  afterAll(async () => {
    await db.delete(crmOutboundWrites).where(eq(crmOutboundWrites.workspaceId, workspaceId));
    await db.delete(crmNativeLinks).where(eq(crmNativeLinks.workspaceId, workspaceId));
    await db.delete(evidenceLedger).where(eq(evidenceLedger.workspaceId, workspaceId));
    await db.delete(deals).where(eq(deals.workspaceId, workspaceId));
    await db.delete(pipelines).where(eq(pipelines.workspaceId, workspaceId)); // cascades to pipelineStages
    await db.delete(contacts).where(eq(contacts.workspaceId, workspaceId));
    await db.delete(crmConnections).where(eq(crmConnections.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, otherWorkspaceId));
    await sql.end();
  });

  it("returns null for a nonexistent contact", async () => {
    const result = await applyManualEntityPatch(db, workspaceId, "contact", "00000000-0000-0000-0000-000000000000", {
      firstName: "X",
    });
    expect(result).toBeNull();
  });

  it("does not find a contact belonging to a different workspace (cross-tenant isolation)", async () => {
    const result = await applyManualEntityPatch(db, otherWorkspaceId, "contact", contactId, { firstName: "X" });
    expect(result).toBeNull();

    const [unchanged] = await db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(unchanged?.firstName).toBe("Grace");
  });

  it("applies the patch and marks the edited fields manual", async () => {
    const updated = await applyManualEntityPatch(db, workspaceId, "contact", contactId, { title: "CTO" });
    expect(updated?.title).toBe("CTO");
    expect((updated?.fieldSources as Record<string, { source: string }>).title?.source).toBe("manual");

    const evidenceRows = await db
      .select()
      .from(evidenceLedger)
      .where(and(eq(evidenceLedger.entityId, contactId), eq(evidenceLedger.attribute, "title")));
    expect(evidenceRows.some((r) => r.source === "manual")).toBe(true);
  });

  it("does not queue an outbound write when the entity has no linked CRM record", async () => {
    await applyManualEntityPatch(db, workspaceId, "contact", contactId, { phone: "555-0100" });
    const queued = await db.select().from(crmOutboundWrites).where(eq(crmOutboundWrites.entityId, contactId));
    expect(queued).toHaveLength(0);
  });

  it("queues an outbound write for a CRM-sync-owned field once the entity is linked", async () => {
    await db.insert(crmNativeLinks).values({
      workspaceId,
      connectionId,
      entityType: "contact",
      entityId: contactId,
      externalId: "hs-999",
      externalUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    await applyManualEntityPatch(db, workspaceId, "contact", contactId, { firstName: "Grace-Renamed" });

    const queued = await db.select().from(crmOutboundWrites).where(eq(crmOutboundWrites.entityId, contactId));
    expect(queued).toHaveLength(1);
    expect(queued[0]?.patch).toEqual({ firstName: "Grace-Renamed" });
    expect(queued[0]?.status).toBe("pending");
  });

  it("does not queue an outbound write for a field that isn't CRM-sync-owned, even when linked", async () => {
    const before = await db.select().from(crmOutboundWrites).where(eq(crmOutboundWrites.entityId, dealId));
    expect(before).toHaveLength(0);
  });

  it("applies a deal patch the same way", async () => {
    const updated = await applyManualEntityPatch(db, workspaceId, "deal", dealId, { amount: "5000" });
    expect(updated?.amount).toBe("5000.00");
  });
});
