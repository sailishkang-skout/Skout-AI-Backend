import { describe, expect, it } from "vitest";
import { createDb, schema } from "@skout/db";
import { loadEnv } from "../config/env.js";
import {
  classifyConfidence,
  classifyFreshness,
  getAccountEvidence,
  HIGH_CONFIDENCE_THRESHOLD,
  LOW_CONFIDENCE_THRESHOLD,
} from "./evidence.service.js";

describe("classifyConfidence", () => {
  it("classifies at/above the high threshold as high", () => {
    expect(classifyConfidence(HIGH_CONFIDENCE_THRESHOLD)).toBe("high");
    expect(classifyConfidence(0.95)).toBe("high");
  });

  it("classifies below the low threshold as low", () => {
    expect(classifyConfidence(LOW_CONFIDENCE_THRESHOLD - 0.01)).toBe("low");
    expect(classifyConfidence(0)).toBe("low");
  });

  it("classifies everything in between as medium", () => {
    expect(classifyConfidence(LOW_CONFIDENCE_THRESHOLD)).toBe("medium");
    expect(classifyConfidence(0.65)).toBe("medium");
  });
});

describe("classifyFreshness", () => {
  const now = new Date("2026-09-04T00:00:00.000Z");

  it("returns no_expiry when there is no expiry date", () => {
    expect(classifyFreshness(null, now)).toBe("no_expiry");
    expect(classifyFreshness(undefined, now)).toBe("no_expiry");
  });

  it("returns expired once the expiry date has passed", () => {
    expect(classifyFreshness(new Date("2026-09-03T00:00:00.000Z"), now)).toBe("expired");
  });

  it("returns expiring_soon within the 7-day window", () => {
    expect(classifyFreshness(new Date("2026-09-10T00:00:00.000Z"), now)).toBe("expiring_soon");
  });

  it("returns fresh outside the 7-day window", () => {
    expect(classifyFreshness(new Date("2026-10-01T00:00:00.000Z"), now)).toBe("fresh");
  });
});

describe("getAccountEvidence", () => {
  it("groups evidence by attribute, newest first, with confidence/freshness tiers attached", async () => {
    const config = loadEnv();
    const { db } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `ws-evidence-${Date.now()}`, slug: `ws-evidence-${Date.now()}` })
      .returning();
    const [company] = await db
      .insert(schema.companies)
      .values({ workspaceId: workspace!.id, name: "Acme Corp" })
      .returning();

    const now = new Date();
    const soon = new Date(now.getTime() + 2 * 86_400_000);
    const later = new Date(now.getTime() + 1000);
    const earlier = new Date(now.getTime() - 1000);

    await db.insert(schema.evidenceLedger).values([
      {
        workspaceId: workspace!.id,
        entityType: "company",
        entityId: company!.id,
        attribute: "industry",
        value: "SaaS",
        source: "clearbit",
        observedAt: earlier,
        confidence: 0.92,
        freshnessExpiresAt: null,
      },
      {
        workspaceId: workspace!.id,
        entityType: "company",
        entityId: company!.id,
        attribute: "industry",
        value: "Software",
        source: "manual",
        observedAt: later,
        confidence: 0.4,
        freshnessExpiresAt: soon,
      },
      {
        workspaceId: workspace!.id,
        entityType: "company",
        entityId: company!.id,
        attribute: "employeeCount",
        value: 250,
        source: "hunter",
        observedAt: now,
        confidence: 0.7,
      },
      // A different entity/company must never leak in.
      {
        workspaceId: workspace!.id,
        entityType: "contact",
        entityId: company!.id,
        attribute: "title",
        value: "CEO",
        source: "manual",
        observedAt: now,
        confidence: 1,
      },
    ]);

    const groups = await getAccountEvidence(db, workspace!.id, company!.id);

    expect(groups.map((g) => g.attribute)).toEqual(["industry", "employeeCount"]);

    const industry = groups.find((g) => g.attribute === "industry")!;
    expect(industry.entries).toHaveLength(2);
    // Newest observation first.
    expect(industry.entries[0]!.source).toBe("manual");
    expect(industry.entries[0]!.confidenceTier).toBe("low");
    expect(industry.entries[0]!.freshnessStatus).toBe("expiring_soon");
    expect(industry.entries[1]!.source).toBe("clearbit");
    expect(industry.entries[1]!.confidenceTier).toBe("high");
    expect(industry.entries[1]!.freshnessStatus).toBe("no_expiry");

    const employeeCount = groups.find((g) => g.attribute === "employeeCount")!;
    expect(employeeCount.entries).toHaveLength(1);
    expect(employeeCount.entries[0]!.confidenceTier).toBe("medium");
  });
});
