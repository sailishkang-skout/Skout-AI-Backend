import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { loadEnv } from "../config/env.js";

const searchHubSpotContactsModifiedSince = vi.fn();
vi.mock("./hubspot.client.js", () => ({
  searchHubSpotContactsModifiedSince: (...args: unknown[]) => searchHubSpotContactsModifiedSince(...args),
  searchHubSpotDealsModifiedSince: vi.fn().mockResolvedValue([]),
}));

const ensureFreshTokens = vi.fn().mockResolvedValue({ accessToken: "token", refreshToken: "r", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
vi.mock("./crm-export.runner.js", () => ({
  ensureFreshTokens: (...args: unknown[]) => ensureFreshTokens(...args),
  createDefaultCredentialsStore: vi.fn().mockReturnValue({}),
}));

const { syncHubSpotContactsToNativeCrm } = await import("./crm-hubspot-native-sync.service.js");
const { recordEvidence } = await import("./evidence.service.js");

// Section 7.1 DOCUMENTED READ-MODEL EXCEPTION — seeds/reads `contacts` (apps/crm-owned) directly
// via a real db connection to verify crm-hubspot-native-sync.service.ts's own already-documented
// exception on this table (see docs/adr/0003-read-model-exceptions.md); test-fixture plumbing for
// an exception that already exists, not a new one.
const { workspaces, crmConnections, crmSyncCheckpoints, crmNativeLinks, contacts } = schema;

describe("syncHubSpotContactsToNativeCrm", () => {
  const config = loadEnv();
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  let workspaceId: string;
  let connectionId: string;

  beforeAll(async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name: `HubSpot Native Sync Test WS ${Date.now()}`, slug: `hubspot-native-sync-test-${Date.now()}` })
      .returning();
    workspaceId = ws!.id;

    const [conn] = await db.insert(crmConnections).values({ workspaceId, provider: "hubspot" }).returning();
    connectionId = conn!.id;
  });

  afterEach(() => {
    searchHubSpotContactsModifiedSince.mockReset();
  });

  afterAll(async () => {
    await db.delete(crmNativeLinks).where(eq(crmNativeLinks.workspaceId, workspaceId));
    await db.delete(crmSyncCheckpoints).where(eq(crmSyncCheckpoints.workspaceId, workspaceId));
    await db.delete(contacts).where(eq(contacts.workspaceId, workspaceId));
    await db.delete(crmConnections).where(eq(crmConnections.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await sql.end();
  });

  it("creates a contact and a matching crm_native_links row on first sync", async () => {
    searchHubSpotContactsModifiedSince.mockResolvedValue([
      {
        id: "hs-contact-1",
        properties: {
          email: "ada@acme.com",
          firstname: "Ada",
          lastname: "Lovelace",
          company: "Acme",
          hs_lastmodifieddate: "2026-01-10T00:00:00.000Z",
        },
      },
    ]);

    const result = await syncHubSpotContactsToNativeCrm(db, config, workspaceId, 50);

    expect(result).toMatchObject({ pulled: 1, created: 1, updated: 0 });

    const [contact] = await db.select().from(contacts).where(eq(contacts.workspaceId, workspaceId));
    expect(contact?.email).toBe("ada@acme.com");

    const [link] = await db
      .select()
      .from(crmNativeLinks)
      .where(and(eq(crmNativeLinks.connectionId, connectionId), eq(crmNativeLinks.entityType, "contact")));
    expect(link?.externalId).toBe("hs-contact-1");
    expect(link?.entityId).toBe(contact?.id);
    expect(link?.externalUpdatedAt?.toISOString()).toBe("2026-01-10T00:00:00.000Z");
  });

  it("the second sync queries HubSpot with 'since' set to the first run's advanced checkpoint", async () => {
    searchHubSpotContactsModifiedSince.mockResolvedValue([]);

    await syncHubSpotContactsToNativeCrm(db, config, workspaceId, 50);

    expect(searchHubSpotContactsModifiedSince).toHaveBeenCalledWith(
      "token",
      "2026-01-10T00:00:00.000Z",
      50
    );
  });

  it("updates the existing contact and refreshes its native link when HubSpot data changes", async () => {
    searchHubSpotContactsModifiedSince.mockResolvedValue([
      {
        id: "hs-contact-1",
        properties: {
          email: "ada@acme.com",
          firstname: "Ada",
          lastname: "Lovelace",
          company: "Acme",
          jobtitle: "Engineer",
          hs_lastmodifieddate: "2026-02-01T00:00:00.000Z",
        },
      },
    ]);

    const result = await syncHubSpotContactsToNativeCrm(db, config, workspaceId, 50);
    expect(result).toMatchObject({ pulled: 1, updated: 1 });

    const [contact] = await db.select().from(contacts).where(eq(contacts.workspaceId, workspaceId));
    expect(contact?.title).toBe("Engineer");

    const [link] = await db
      .select()
      .from(crmNativeLinks)
      .where(and(eq(crmNativeLinks.connectionId, connectionId), eq(crmNativeLinks.entityType, "contact")));
    expect(link?.externalUpdatedAt?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("does not overwrite a manually-locked field with inbound HubSpot data (existing conflict rule preserved)", async () => {
    const [contact] = await db.select().from(contacts).where(eq(contacts.workspaceId, workspaceId));
    await db.update(contacts).set({ title: "Human-set title" }).where(eq(contacts.id, contact!.id));
    // Evidence ledger is authoritative for the lock (see field-sources.ts) — a human edit must
    // record a "manual" evidence row, not just flip the fieldSources cache column directly.
    await recordEvidence(db, {
      workspaceId,
      entityType: "contact",
      entityId: contact!.id,
      attribute: "title",
      value: "Human-set title",
      source: "manual",
      observedAt: new Date(),
      confidence: 1,
      method: "test_manual_edit",
    });

    searchHubSpotContactsModifiedSince.mockResolvedValue([
      {
        id: "hs-contact-1",
        properties: {
          email: "ada@acme.com",
          firstname: "Ada",
          lastname: "Lovelace",
          jobtitle: "HubSpot Title",
          hs_lastmodifieddate: "2026-03-01T00:00:00.000Z",
        },
      },
    ]);

    await syncHubSpotContactsToNativeCrm(db, config, workspaceId, 50);

    const [updated] = await db.select().from(contacts).where(eq(contacts.id, contact!.id));
    expect(updated?.title).toBe("Human-set title");
  });
});
