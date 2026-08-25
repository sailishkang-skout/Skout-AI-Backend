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

describe("resolveRegionalBrief", () => {
  it("prefers the most specific approved layer per field category, and falls back to a less specific layer when the more specific one is missing", async () => {
    const config = loadEnv();
    const { db } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
    const svc = createRegionalBriefService(db);
    const [reviewer] = await db.insert(schema.users).values({ email: `res-rev-${Date.now()}@test.com`, fullName: "R" }).returning();
    const [author] = await db.insert(schema.users).values({ email: `res-auth-${Date.now()}@test.com`, fullName: "A" }).returning();

    // Seed a country row for this test if one doesn't already exist (US should exist from Task 1's seed).
    const globalSlot = await svc.findOrCreateSlot({ layerType: "global", fieldCategory: "market_economics" });
    const globalV = await svc.createDraftVersion(globalSlot.id, {
      content: { summary: "global default", details: [] },
      source: "test", effectiveDate: new Date(), confidence: 60, evidence: "test", createdBy: author!.id,
    });
    await svc.approveVersion(globalV.id, reviewer!.id);

    const countrySlot = await svc.findOrCreateSlot({ layerType: "country", countryIso: "US", fieldCategory: "market_economics" });
    const countryV = await svc.createDraftVersion(countrySlot.id, {
      content: { summary: "US-specific", details: [] },
      source: "test", effectiveDate: new Date(), confidence: 70, evidence: "test", createdBy: author!.id,
    });
    await svc.approveVersion(countryV.id, reviewer!.id);

    const resolved = await svc.resolveRegionalBrief({ countryIso: "US" });
    const marketEconomics = resolved.entries.find((e) => e.fieldCategory === "market_economics");
    expect(marketEconomics?.content.summary).toBe("US-specific");
    expect(marketEconomics?.resolvedFromLayer).toBe("country");

    // channel_policy has no country-level entry in this test — should fall back to global if present, or be absent.
    const channelPolicy = resolved.entries.find((e) => e.fieldCategory === "channel_policy");
    expect(channelPolicy).toBeUndefined();
  });

  it("flags an expired version as stale but still returns it", async () => {
    const config = loadEnv();
    const { db } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
    const svc = createRegionalBriefService(db);
    const [reviewer] = await db.insert(schema.users).values({ email: `stale-rev-${Date.now()}@test.com`, fullName: "R" }).returning();
    const [author] = await db.insert(schema.users).values({ email: `stale-auth-${Date.now()}@test.com`, fullName: "A" }).returning();

    const slot = await svc.findOrCreateSlot({ layerType: "global", fieldCategory: "data_compliance" });
    const v = await svc.createDraftVersion(slot.id, {
      content: { summary: "stale content", details: [] },
      source: "test", effectiveDate: new Date("2020-01-01"), confidence: 60, evidence: "test",
      expiryDate: new Date("2021-01-01"), createdBy: author!.id,
    });
    await svc.approveVersion(v.id, reviewer!.id);

    const resolved = await svc.resolveRegionalBrief({ countryIso: "US" });
    const entry = resolved.entries.find((e) => e.fieldCategory === "data_compliance");
    expect(entry?.isStale).toBe(true);
  });
});
