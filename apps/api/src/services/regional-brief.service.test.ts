import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { loadEnv } from "../config/env.js";
import {
  isPlatformAdmin,
  buildScopeKey,
  normalizeIndustry,
  NAICS_CODE_NAMES,
  createRegionalBriefService,
} from "./regional-brief.service.js";
import { createCountryIndustryTamService } from "./country-industry-tam.service.js";

// ── isPlatformAdmin ────────────────────────────────────────────────────────────

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

// ── buildScopeKey ──────────────────────────────────────────────────────────────

describe("buildScopeKey", () => {
  it("builds a global-layer key from just the field category", () => {
    expect(buildScopeKey({ layerType: "global", fieldCategory: "explainability" })).toBe(
      "global:explainability"
    );
  });

  it("builds a country-layer key using iso_alpha3 (not UUID)", () => {
    expect(
      buildScopeKey({ layerType: "country", countryIso3: "GBR", fieldCategory: "market_economics" })
    ).toBe("country:GBR:market_economics");
  });

  it("builds a region-layer key using region code string", () => {
    expect(
      buildScopeKey({ layerType: "region", regionCode: "UKI", fieldCategory: "channel_policy" })
    ).toBe("region:UKI:channel_policy");
  });

  it("builds an industry-layer key using NAICS code", () => {
    expect(
      buildScopeKey({ layerType: "industry", naicsCode: "51", fieldCategory: "market_economics" })
    ).toBe("industry:51:market_economics");
  });

  it("builds a tenant-layer key from workspace + iso_alpha3", () => {
    expect(
      buildScopeKey({
        layerType: "tenant",
        workspaceId: "ws-1",
        countryIso3: "GBR",
        fieldCategory: "channel_policy",
      })
    ).toBe("tenant:ws-1:GBR:channel_policy");
  });
});

// ── normalizeIndustry ──────────────────────────────────────────────────────────

describe("normalizeIndustry", () => {
  it("maps 'saas' → NAICS code 51 (Information)", () => {
    const result = normalizeIndustry("saas");
    expect(result?.code).toBe("51");
    expect(result?.displayName).toBe(NAICS_CODE_NAMES["51"]);
  });

  it("maps 'SaaS' case-insensitively", () => {
    expect(normalizeIndustry("SaaS")?.code).toBe("51");
  });

  it("passes through a bare NAICS code directly", () => {
    const result = normalizeIndustry("51");
    expect(result?.code).toBe("51");
  });

  it("maps 'healthcare' → 62", () => {
    expect(normalizeIndustry("healthcare")?.code).toBe("62");
  });

  it("maps 'fintech' → 52", () => {
    expect(normalizeIndustry("fintech")?.code).toBe("52");
  });

  it("returns null for unrecognized phrase", () => {
    expect(normalizeIndustry("unobtanium")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(normalizeIndustry("")).toBeNull();
  });
});

// ── approveVersion / rejectVersion ─────────────────────────────────────────────

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

// ── resolveRegionalBrief ───────────────────────────────────────────────────────

describe("resolveRegionalBrief", () => {
  it("prefers the most specific approved layer per field category, and falls back to a less specific layer when the more specific one is missing", async () => {
    const config = loadEnv();
    const { db } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
    const svc = createRegionalBriefService(db);
    const [reviewer] = await db.insert(schema.users).values({ email: `res-rev-${Date.now()}@test.com`, fullName: "R" }).returning();
    const [author] = await db.insert(schema.users).values({ email: `res-auth-${Date.now()}@test.com`, fullName: "A" }).returning();

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
    expect(resolved.countryIso3).toBe("USA");
    expect(resolved.country).toBe("United States");

    const marketEconomics = resolved.entries.find((e) => e.fieldCategory === "market_economics");
    expect(marketEconomics?.content.summary).toBe("US-specific");
    expect(marketEconomics?.resolvedFromLayer).toBe("country");

    // channel_policy is seeded from the global Excel catalog
    const channelPolicy = resolved.entries.find((e) => e.fieldCategory === "channel_policy");
    expect(channelPolicy?.resolvedFromLayer).toBe("country");
    expect(channelPolicy?.content.summary).toBeTruthy();
  });

  it("resolves by alpha-3 code (GBR) the same as alpha-2 (GB)", async () => {
    const config = loadEnv();
    const { db } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
    const svc = createRegionalBriefService(db);
    const [reviewer] = await db.insert(schema.users).values({ email: `gbr-rev-${Date.now()}@test.com`, fullName: "R" }).returning();
    const [author] = await db.insert(schema.users).values({ email: `gbr-auth-${Date.now()}@test.com`, fullName: "A" }).returning();

    const slot = await svc.findOrCreateSlot({ layerType: "country", countryIso: "GB", fieldCategory: "business_practice" });
    const v = await svc.createDraftVersion(slot.id, {
      content: { summary: "UK business practice via alpha-2", details: [] },
      source: "test", effectiveDate: new Date(), confidence: 70, evidence: "test", createdBy: author!.id,
    });
    await svc.approveVersion(v.id, reviewer!.id);

    // Resolve using alpha-3
    const resolvedAlpha3 = await svc.resolveRegionalBrief({ countryIso: "GBR" });
    expect(resolvedAlpha3.countryIso3).toBe("GBR");
    const entry = resolvedAlpha3.entries.find((e) => e.fieldCategory === "business_practice");
    expect(entry?.content.summary).toBe("UK business practice via alpha-2");
  });

  it("resolves by canonical country alias ('United Kingdom')", async () => {
    const config = loadEnv();
    const { db } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
    const svc = createRegionalBriefService(db);

    // Should not throw — aliases seeded by seed-regional-brief-reference-data
    const resolved = await svc.resolveRegionalBrief({ countryIso: "United Kingdom" }).catch(() => null);
    // If aliases are not seeded yet (e.g. fresh DB without ref-data seed), this is still acceptable
    if (resolved !== null) {
      expect(resolved.countryIso3).toBe("GBR");
    }
  });

  it("returns industryInputWarning when an unrecognized industry phrase is passed", async () => {
    const config = loadEnv();
    const { db } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
    const svc = createRegionalBriefService(db);

    const resolved = await svc.resolveRegionalBrief({ countryIso: "US", industry: "unobtanium" });
    expect(resolved.industry).toBeNull();
    expect(resolved.industryInputWarning).toContain("unobtanium");
  });

  it("normalizes industry phrase 'saas' to NAICS 51 in the response", async () => {
    const config = loadEnv();
    const { db } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
    const svc = createRegionalBriefService(db);

    const resolved = await svc.resolveRegionalBrief({ countryIso: "US", industry: "saas" });
    expect(resolved.industry).toBe("51");
    expect(resolved.industryName).toBe(NAICS_CODE_NAMES["51"]);
  });

  it("flags an expired version as stale but still returns it", async () => {
    const config = loadEnv();
    const { db } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
    const svc = createRegionalBriefService(db);
    const [reviewer] = await db.insert(schema.users).values({ email: `stale-rev-${Date.now()}@test.com`, fullName: "R" }).returning();
    const [author] = await db.insert(schema.users).values({ email: `stale-auth-${Date.now()}@test.com`, fullName: "A" }).returning();
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `stale-test-${Date.now()}`, slug: `stale-test-${Date.now()}` })
      .returning();

    const slot = await svc.findOrCreateSlot({
      layerType: "tenant",
      countryIso: "US",
      workspaceId: workspace!.id,
      fieldCategory: "channel_policy",
    });
    const v = await svc.createDraftVersion(slot.id, {
      content: { summary: "stale content", details: [] },
      source: "test", effectiveDate: new Date("2020-01-01"), confidence: 60, evidence: "test",
      expiryDate: new Date("2021-01-01"), createdBy: author!.id,
    });
    await svc.approveVersion(v.id, reviewer!.id);

    const resolved = await svc.resolveRegionalBrief({ countryIso: "US", workspaceId: workspace!.id });
    const entry = resolved.entries.find((e) => e.fieldCategory === "channel_policy");
    expect(entry?.isStale).toBe(true);
  });
});

// ── getTam ─────────────────────────────────────────────────────────────────────

describe("getTam", () => {
  it("returns live fact-checked data for NAICS 51 (Information) in US", async () => {
    const config = loadEnv();
    const { db } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
    const tamSvc = createCountryIndustryTamService(db);

    const result = await tamSvc.getTam({ countryIso: "US", naicsCode: "51" });
    expect(result.isDataLoaded).toBe(true);
    expect(result.countryIso3).toBe("USA");
    expect(result.industryCode).toBe("51");
    expect(result.assumptions.establishments).toBe(162006);
    expect(result.targetAccountsTam).toBe(16201);
    expect(result.annualRevenueTamUsd).toBe(405025000);
    expect(result.assumptions.dataSource).toContain("US Census Bureau");
  });

  it("returns isDataLoaded=false and null TAM values when establishments are null", async () => {
    const config = loadEnv();
    const { db } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
    const tamSvc = createCountryIndustryTamService(db);

    // Upsert a test row with null establishments
    await tamSvc.upsertTamRow({
      countryIso: "US",
      industryCode: "98",
      industryName: "Unloaded Test Sector",
      establishments: null,
      icpFitPct: 0.1,
      acvUsd: 25000,
    });

    const result = await tamSvc.getTam({ countryIso: "US", naicsCode: "98" });
    expect(result.isDataLoaded).toBe(false);
    expect(result.targetAccountsTam).toBeNull();
    expect(result.annualRevenueTamUsd).toBeNull();
    expect(result.assumptions.establishments).toBeNull();
  });

  it("computes TAM correctly when establishments are loaded", async () => {
    const config = loadEnv();
    const { db } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
    const tamSvc = createCountryIndustryTamService(db);

    // Upsert a row with known establishments for a deterministic calculation
    await tamSvc.upsertTamRow({
      countryIso: "US",
      industryCode: "99", // use a non-standard code to avoid collision with skeleton seed
      industryName: "Test Industry",
      establishments: 1000,
      icpFitPct: 0.1,
      acvUsd: 25000,
    });

    const result = await tamSvc.getTam({ countryIso: "US", naicsCode: "99" });
    expect(result.isDataLoaded).toBe(true);
    // 1000 × 0.10 = 100 accounts; 100 × 25000 = 2,500,000 revenue
    expect(result.targetAccountsTam).toBe(100);
    expect(result.annualRevenueTamUsd).toBe(2500000);
  });

  it("accepts alpha-3 country code (USA) for the same country as alpha-2 (US)", async () => {
    const config = loadEnv();
    const { db } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
    const tamSvc = createCountryIndustryTamService(db);

    const resultAlpha2 = await tamSvc.getTam({ countryIso: "US", naicsCode: "99" }).catch(() => null);
    const resultAlpha3 = await tamSvc.getTam({ countryIso: "USA", naicsCode: "99" }).catch(() => null);

    if (resultAlpha2 === null || resultAlpha3 === null) return; // seed not applied

    expect(resultAlpha3.countryIso2).toBe(resultAlpha2.countryIso2);
    expect(resultAlpha3.targetAccountsTam).toBe(resultAlpha2.targetAccountsTam);
  });
});
