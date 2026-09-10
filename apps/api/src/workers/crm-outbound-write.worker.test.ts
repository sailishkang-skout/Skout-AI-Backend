import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { loadEnv } from "../config/env.js";

const updateHubSpotContact = vi.fn().mockResolvedValue(undefined);
const updateHubSpotDeal = vi.fn().mockResolvedValue(undefined);
const isHubSpotRetryableError = vi.fn().mockReturnValue(false);
vi.mock("../services/hubspot.client.js", () => ({
  updateHubSpotContact: (...args: unknown[]) => updateHubSpotContact(...args),
  updateHubSpotDeal: (...args: unknown[]) => updateHubSpotDeal(...args),
  isHubSpotRetryableError: (...args: unknown[]) => isHubSpotRetryableError(...args),
}));

const ensureFreshTokens = vi.fn().mockResolvedValue({ accessToken: "token", refreshToken: "r", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
vi.mock("../services/crm-export.runner.js", () => ({
  ensureFreshTokens: (...args: unknown[]) => ensureFreshTokens(...args),
  createDefaultCredentialsStore: vi.fn().mockReturnValue({}),
}));

const { processNextCrmOutboundWrite } = await import("./crm-outbound-write.worker.js");

const { workspaces, crmConnections, crmNativeLinks, crmOutboundWrites } = schema;

describe("processNextCrmOutboundWrite", () => {
  const config = loadEnv();
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  let workspaceId: string;
  let connectionId: string;
  const contactEntityId = "11111111-1111-1111-1111-111111111111";

  beforeAll(async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name: `Outbound Write Test WS ${Date.now()}`, slug: `outbound-write-test-${Date.now()}` })
      .returning();
    workspaceId = ws!.id;

    const [conn] = await db.insert(crmConnections).values({ workspaceId, provider: "hubspot" }).returning();
    connectionId = conn!.id;
  });

  afterEach(() => {
    updateHubSpotContact.mockClear();
    updateHubSpotDeal.mockClear();
    isHubSpotRetryableError.mockReturnValue(false);
  });

  afterAll(async () => {
    await db.delete(crmOutboundWrites).where(eq(crmOutboundWrites.workspaceId, workspaceId));
    await db.delete(crmNativeLinks).where(eq(crmNativeLinks.workspaceId, workspaceId));
    await db.delete(crmConnections).where(eq(crmConnections.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await sql.end();
  });

  it("returns null when there is nothing pending to claim", async () => {
    const outcome = await processNextCrmOutboundWrite(db, config);
    expect(outcome).toBeNull();
  });

  it("pushes the patch to HubSpot and marks the write succeeded when there is no conflict", async () => {
    await db.insert(crmNativeLinks).values({
      workspaceId,
      connectionId,
      entityType: "contact",
      entityId: contactEntityId,
      externalId: "hs-1",
      externalUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const [queued] = await db
      .insert(crmOutboundWrites)
      .values({
        workspaceId,
        connectionId,
        entityType: "contact",
        entityId: contactEntityId,
        patch: { firstName: "Ada" },
        skoutChangedAt: new Date("2026-01-05T00:00:00.000Z"),
        idempotencyKey: `test-1-${Date.now()}`,
      })
      .returning();

    const outcome = await processNextCrmOutboundWrite(db, config);

    expect(outcome).toBe("pushed");
    expect(updateHubSpotContact).toHaveBeenCalledWith("token", "hs-1", { firstname: "Ada" });

    const [row] = await db.select().from(crmOutboundWrites).where(eq(crmOutboundWrites.id, queued!.id));
    expect(row?.status).toBe("succeeded");
  });

  it("does NOT push and marks the write failed with a conflict reason when HubSpot changed more recently (reverse manual-wins)", async () => {
    const entityId = "22222222-2222-2222-2222-222222222222";
    await db.insert(crmNativeLinks).values({
      workspaceId,
      connectionId,
      entityType: "contact",
      entityId,
      externalId: "hs-2",
      // HubSpot's own last-modified is AFTER the Skout edit that queued this write.
      externalUpdatedAt: new Date("2026-02-10T00:00:00.000Z"),
    });
    const [queued] = await db
      .insert(crmOutboundWrites)
      .values({
        workspaceId,
        connectionId,
        entityType: "contact",
        entityId,
        patch: { title: "New Title" },
        skoutChangedAt: new Date("2026-02-01T00:00:00.000Z"),
        idempotencyKey: `test-2-${Date.now()}`,
      })
      .returning();

    const outcome = await processNextCrmOutboundWrite(db, config);

    expect(outcome).toBe("conflict");
    expect(updateHubSpotContact).not.toHaveBeenCalled();

    const [row] = await db.select().from(crmOutboundWrites).where(eq(crmOutboundWrites.id, queued!.id));
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("conflict_hubspot_newer");
  });

  it("pushes when the Skout edit happened after HubSpot's last-modified (no conflict)", async () => {
    const entityId = "33333333-3333-3333-3333-333333333333";
    await db.insert(crmNativeLinks).values({
      workspaceId,
      connectionId,
      entityType: "contact",
      entityId,
      externalId: "hs-3",
      externalUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await db.insert(crmOutboundWrites).values({
      workspaceId,
      connectionId,
      entityType: "contact",
      entityId,
      patch: { phone: "555-0100" },
      skoutChangedAt: new Date("2026-03-01T00:00:00.000Z"),
      idempotencyKey: `test-3-${Date.now()}`,
    });

    const outcome = await processNextCrmOutboundWrite(db, config);

    expect(outcome).toBe("pushed");
    expect(updateHubSpotContact).toHaveBeenCalledWith("token", "hs-3", { phone: "555-0100" });
  });

  it("marks the write failed when no native link exists (should not normally happen, but is handled)", async () => {
    const entityId = "44444444-4444-4444-4444-444444444444";
    const [queued] = await db
      .insert(crmOutboundWrites)
      .values({
        workspaceId,
        connectionId,
        entityType: "contact",
        entityId,
        patch: { title: "X" },
        skoutChangedAt: new Date(),
        idempotencyKey: `test-4-${Date.now()}`,
      })
      .returning();

    const outcome = await processNextCrmOutboundWrite(db, config);

    expect(outcome).toBe("pushed");
    expect(updateHubSpotContact).not.toHaveBeenCalled();
    const [row] = await db.select().from(crmOutboundWrites).where(eq(crmOutboundWrites.id, queued!.id));
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("no_native_link");
  });

  it("leaves a retryable HubSpot error claimed (not failed) for the lease-expiry retry cycle", async () => {
    const entityId = "55555555-5555-5555-5555-555555555555";
    await db.insert(crmNativeLinks).values({
      workspaceId,
      connectionId,
      entityType: "contact",
      entityId,
      externalId: "hs-5",
      externalUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const [queued] = await db
      .insert(crmOutboundWrites)
      .values({
        workspaceId,
        connectionId,
        entityType: "contact",
        entityId,
        patch: { title: "X" },
        skoutChangedAt: new Date("2026-03-01T00:00:00.000Z"),
        idempotencyKey: `test-5-${Date.now()}`,
      })
      .returning();

    updateHubSpotContact.mockRejectedValueOnce(new Error("HubSpot API x failed: 429 rate limited"));
    isHubSpotRetryableError.mockReturnValue(true);

    const outcome = await processNextCrmOutboundWrite(db, config);

    expect(outcome).toBe("pushed");
    const [row] = await db.select().from(crmOutboundWrites).where(eq(crmOutboundWrites.id, queued!.id));
    expect(row?.status).toBe("claimed");
    expect(row?.leaseOwner).toBeTruthy();
  });

  it("marks a non-retryable HubSpot error failed immediately", async () => {
    const entityId = "66666666-6666-6666-6666-666666666666";
    await db.insert(crmNativeLinks).values({
      workspaceId,
      connectionId,
      entityType: "contact",
      entityId,
      externalId: "hs-6",
      externalUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const [queued] = await db
      .insert(crmOutboundWrites)
      .values({
        workspaceId,
        connectionId,
        entityType: "contact",
        entityId,
        patch: { title: "X" },
        skoutChangedAt: new Date("2026-03-01T00:00:00.000Z"),
        idempotencyKey: `test-6-${Date.now()}`,
      })
      .returning();

    updateHubSpotContact.mockRejectedValueOnce(new Error("HubSpot API x failed: 403 forbidden"));
    isHubSpotRetryableError.mockReturnValue(false);

    const outcome = await processNextCrmOutboundWrite(db, config);

    expect(outcome).toBe("pushed");
    const [row] = await db.select().from(crmOutboundWrites).where(eq(crmOutboundWrites.id, queued!.id));
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toContain("403");
  });

  it("maps deal fields to HubSpot deal property names", async () => {
    const entityId = "77777777-7777-7777-7777-777777777777";
    await db.insert(crmNativeLinks).values({
      workspaceId,
      connectionId,
      entityType: "deal",
      entityId,
      externalId: "hs-deal-1",
      externalUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await db.insert(crmOutboundWrites).values({
      workspaceId,
      connectionId,
      entityType: "deal",
      entityId,
      patch: { amount: "1000", name: "Renewed Deal" },
      skoutChangedAt: new Date("2026-03-01T00:00:00.000Z"),
      idempotencyKey: `test-7-${Date.now()}`,
    });

    await processNextCrmOutboundWrite(db, config);

    expect(updateHubSpotDeal).toHaveBeenCalledWith("token", "hs-deal-1", { amount: "1000", dealname: "Renewed Deal" });
  });
});
