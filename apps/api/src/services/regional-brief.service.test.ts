import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { isPlatformAdmin, buildScopeKey, createRegionalBriefService } from "./regional-brief.service.js";

describe("isPlatformAdmin", () => {
  it("returns true for an email in PLATFORM_ADMIN_EMAILS, case-insensitively", () => {
    const config = { PLATFORM_ADMIN_EMAILS: ["admin@skoutai.io"] };
    expect(isPlatformAdmin(config, "Admin@SkoutAI.io")).toBe(true);
  });

  it("returns false for an email not in the list", () => {
    const config = { PLATFORM_ADMIN_EMAILS: ["admin@skoutai.io"] };
    expect(isPlatformAdmin(config, "someone-else@skoutai.io")).toBe(false);
  });

  it("returns false when email is undefined", () => {
    const config = { PLATFORM_ADMIN_EMAILS: ["admin@skoutai.io"] };
    expect(isPlatformAdmin(config, undefined)).toBe(false);
  });

  it("returns false when the allowlist is empty", () => {
    const config = { PLATFORM_ADMIN_EMAILS: [] };
    expect(isPlatformAdmin(config, "admin@skoutai.io")).toBe(false);
  });
});

describe("buildScopeKey", () => {
  it("builds a global-layer key from just the field category", () => {
    expect(buildScopeKey({ layerType: "global", fieldCategory: "explainability" })).toBe(
      "global:explainability"
    );
  });

  it("builds a country-layer key from the country id", () => {
    expect(
      buildScopeKey({ layerType: "country", countryId: "c-1", fieldCategory: "market_economics" })
    ).toBe("country:c-1:market_economics");
  });

  it("builds a tenant-layer key from workspace + country", () => {
    expect(
      buildScopeKey({
        layerType: "tenant",
        workspaceId: "ws-1",
        countryId: "c-1",
        fieldCategory: "channel_policy",
      })
    ).toBe("tenant:ws-1:c-1:channel_policy");
  });
});

describe("approveVersion / rejectVersion", () => {
  it("approving a draft version sets it current and marks the prior current version superseded", async () => {
    const config = loadEnv();
    const { db } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
    const svc = createRegionalBriefService(db);

    const [reviewer] = await db.insert(schema.users).values({ email: `reviewer-${Date.now()}@test.com`, fullName: "Reviewer" }).returning();
    const [author] = await db.insert(schema.users).values({ email: `author-${Date.now()}@test.com`, fullName: "Author" }).returning();

    const slot = await svc.findOrCreateSlot({ layerType: "global", fieldCategory: "explainability" });
    const v1 = await svc.createDraftVersion(slot.id, {
      content: { summary: "v1", details: [] },
      source: "test",
      effectiveDate: new Date(),
      confidence: 80,
      evidence: "test",
      createdBy: author!.id,
    });
    const approvedV1 = await svc.approveVersion(v1.id, reviewer!.id);
    expect(approvedV1.status).toBe("approved");

    const v2 = await svc.createDraftVersion(slot.id, {
      content: { summary: "v2", details: [] },
      source: "test",
      effectiveDate: new Date(),
      confidence: 85,
      evidence: "test",
      createdBy: author!.id,
    });
    await svc.approveVersion(v2.id, reviewer!.id);

    const [reloadedSlot] = await db.select().from(schema.regionalBriefSlots).where(eq(schema.regionalBriefSlots.id, slot.id));
    expect(reloadedSlot!.currentVersionId).toBe(v2.id);

    const [reloadedV1] = await db.select().from(schema.regionalBriefVersions).where(eq(schema.regionalBriefVersions.id, v1.id));
    expect(reloadedV1!.status).toBe("superseded");
  });

  it("rejecting a draft version leaves the slot's current pointer unchanged", async () => {
    const config = loadEnv();
    const { db } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
    const svc = createRegionalBriefService(db);
    const [reviewer] = await db.insert(schema.users).values({ email: `reviewer2-${Date.now()}@test.com`, fullName: "R" }).returning();
    const [author] = await db.insert(schema.users).values({ email: `author2-${Date.now()}@test.com`, fullName: "A" }).returning();

    const slot = await svc.findOrCreateSlot({ layerType: "global", fieldCategory: "channel_policy" });
    const v1 = await svc.createDraftVersion(slot.id, {
      content: { summary: "bad draft", details: [] },
      source: "test",
      effectiveDate: new Date(),
      confidence: 50,
      evidence: "test",
      createdBy: author!.id,
    });
    const rejected = await svc.rejectVersion(v1.id, reviewer!.id, "not accurate");
    expect(rejected.status).toBe("rejected");

    const [reloadedSlot] = await db.select().from(schema.regionalBriefSlots).where(eq(schema.regionalBriefSlots.id, slot.id));
    expect(reloadedSlot!.currentVersionId).toBeNull();
  });
});
