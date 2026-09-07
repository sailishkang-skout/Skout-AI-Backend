import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, schema } from "@skout/db";
import { and, eq } from "drizzle-orm";
import { loadEnv } from "../config/env.js";
import {
  getCrmNativeLink,
  getHubSpotConnectionId,
  upsertCrmNativeLink,
  withSyncCheckpoint,
} from "./crm-sync-state.service.js";

const { workspaces, crmConnections, crmSyncCheckpoints, crmNativeLinks } = schema;

describe("crm-sync-state.service", () => {
  const config = loadEnv();
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  let workspaceId: string;
  let connectionId: string;

  beforeAll(async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name: `CRM Sync State Test WS ${Date.now()}`, slug: `crm-sync-state-test-${Date.now()}` })
      .returning();
    workspaceId = ws!.id;

    const [conn] = await db
      .insert(crmConnections)
      .values({ workspaceId, provider: "hubspot" })
      .returning();
    connectionId = conn!.id;
  });

  afterAll(async () => {
    await db.delete(crmNativeLinks).where(eq(crmNativeLinks.workspaceId, workspaceId));
    await db.delete(crmSyncCheckpoints).where(eq(crmSyncCheckpoints.workspaceId, workspaceId));
    await db.delete(crmConnections).where(eq(crmConnections.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await sql.end();
  });

  it("getHubSpotConnectionId finds the workspace's hubspot connection", async () => {
    const id = await getHubSpotConnectionId(db, workspaceId);
    expect(id).toBe(connectionId);
  });

  it("getHubSpotConnectionId returns null for a workspace with no hubspot connection", async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name: `No CRM Test WS ${Date.now()}`, slug: `no-crm-test-${Date.now()}` })
      .returning();
    const id = await getHubSpotConnectionId(db, ws!.id);
    expect(id).toBeNull();
    await db.delete(workspaces).where(eq(workspaces.id, ws!.id));
  });

  it("withSyncCheckpoint starts a first run from the epoch and advances the cursor on success", async () => {
    let sinceSeen: string | undefined;
    const result = await withSyncCheckpoint(db, workspaceId, connectionId, "contact", async (since) => {
      sinceSeen = since;
      return { result: { pulled: 3 }, maxModifiedAt: new Date("2026-01-15T00:00:00.000Z") };
    });

    expect(sinceSeen).toBe(new Date(0).toISOString());
    expect(result).toEqual({ pulled: 3 });

    const [row] = await db
      .select()
      .from(crmSyncCheckpoints)
      .where(eq(crmSyncCheckpoints.connectionId, connectionId));
    expect(row?.lastRunStatus).toBe("succeeded");
    expect(row?.cursor?.toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });

  it("a subsequent run reads the previously-advanced cursor as its since value", async () => {
    let sinceSeen: string | undefined;
    await withSyncCheckpoint(db, workspaceId, connectionId, "contact", async (since) => {
      sinceSeen = since;
      return { result: { pulled: 0 }, maxModifiedAt: null };
    });
    expect(sinceSeen).toBe("2026-01-15T00:00:00.000Z");
  });

  it("recovery: a run that throws leaves the checkpoint's cursor unchanged and marks it failed", async () => {
    await expect(
      withSyncCheckpoint(db, workspaceId, connectionId, "deal", async () => {
        throw new Error("boom mid-run");
      })
    ).rejects.toThrow("boom mid-run");

    const [row] = await db
      .select()
      .from(crmSyncCheckpoints)
      .where(and(eq(crmSyncCheckpoints.connectionId, connectionId), eq(crmSyncCheckpoints.entityType, "deal")));
    expect(row?.lastRunStatus).toBe("failed");
    expect(row?.lastError).toContain("boom mid-run");
    expect(row?.cursor).toBeNull();

    // The next run resumes from the same (untouched) checkpoint — not from scratch.
    let sinceSeen: string | undefined;
    await withSyncCheckpoint(db, workspaceId, connectionId, "deal", async (since) => {
      sinceSeen = since;
      return { result: { pulled: 1 }, maxModifiedAt: new Date("2026-02-01T00:00:00.000Z") };
    });
    expect(sinceSeen).toBe(new Date(0).toISOString());
  });

  it("upsertCrmNativeLink creates then refreshes the external-id + last-modified mapping", async () => {
    const entityId = "11111111-1111-1111-1111-111111111111";
    await upsertCrmNativeLink(db, workspaceId, connectionId, "contact", entityId, "hs-1", new Date("2026-01-01T00:00:00.000Z"));

    let link = await getCrmNativeLink(db, workspaceId, connectionId, "contact", entityId);
    expect(link?.externalId).toBe("hs-1");
    expect(link?.externalUpdatedAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");

    await upsertCrmNativeLink(db, workspaceId, connectionId, "contact", entityId, "hs-1", new Date("2026-03-01T00:00:00.000Z"));
    link = await getCrmNativeLink(db, workspaceId, connectionId, "contact", entityId);
    expect(link?.externalUpdatedAt?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
  });

  it("getCrmNativeLink returns null when no link exists", async () => {
    const link = await getCrmNativeLink(db, workspaceId, connectionId, "contact", "22222222-2222-2222-2222-222222222222");
    expect(link).toBeNull();
  });
});
