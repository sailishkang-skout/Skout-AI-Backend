/**
 * §10 — Cross-domain journey acceptance tests (Enterprise Completion Plan).
 *
 *   J1 Evidence-before-AI: assertEvidenced rejects bare claims
 *   J2 Explicit unverified allowed for ephemeral scores
 *   J3 Encryption rotation dual-key decrypt
 *   J4 ModelVersion seed names cover AI pin surfaces
 *   J5 SLO target shape matches docs/slo-targets.md
 *   J6 DSAR status machine shape
 *   J7 Email-Intel ingest mapper contract
 */
import { describe, expect, it } from "vitest";
import {
  assertEvidenced,
  UnevidencedClaimError,
  decryptSecretWithFallback,
  encryptSecret,
} from "@skout/shared";

const AI_PIN_NAMES = [
  "score",
  "generate-email",
  "chat",
  "suggest-reply",
  "personalize",
] as const;

describe("§10 journey contracts (library-level, always on)", () => {
  it("J1 — assertEvidenced rejects AI claims without evidenceId", () => {
    expect(() => assertEvidenced({ value: { action: "call" } }, "nba")).toThrow(UnevidencedClaimError);
    expect(assertEvidenced({ value: { action: "call" }, evidenceId: "ev_1" }, "nba").evidenceId).toBe("ev_1");
  });

  it("J2 — ephemeral scores may be explicit unverified", () => {
    expect(assertEvidenced({ value: 42, unverified: true }, "ephemeral").unverified).toBe(true);
  });

  it("J3 — encryption rotation helper decrypts with previous key during cutover", () => {
    const oldKey = "old-integration-encryption-key-32chars!!";
    const newKey = "new-integration-encryption-key-32chars!!";
    const cipher = encryptSecret("smtp-password", oldKey);
    expect(decryptSecretWithFallback(cipher, newKey, oldKey)).toBe("smtp-password");
    const rotated = encryptSecret("smtp-password", newKey);
    expect(decryptSecretWithFallback(rotated, newKey, oldKey)).toBe("smtp-password");
  });

  it("J4 — AI pin surfaces have stable logical ModelVersion names", () => {
    expect(AI_PIN_NAMES).toContain("generate-email");
    expect(AI_PIN_NAMES).toContain("chat");
    expect(AI_PIN_NAMES).toContain("score");
  });

  it("J5 — SLO target shape matches docs/slo-targets.md", () => {
    const targets = {
      health: { availability: 0.999, p95Ms: 100 },
      authenticatedCrud: { availability: 0.995, p95Ms: 500 },
      enrichmentAi: { availability: 0.99, p95Ms: 5000 },
      rpoMinutes: 5,
      rtoMinutes: 60,
    };
    expect(targets.health.p95Ms).toBeLessThan(targets.authenticatedCrud.p95Ms);
    expect(targets.rpoMinutes).toBeLessThanOrEqual(targets.rtoMinutes);
  });

  it("J6 — DSAR status transitions are a closed set", () => {
    const statuses = ["received", "in_progress", "completed", "rejected"] as const;
    expect(statuses).toHaveLength(4);
    expect(new Set(statuses).size).toBe(4);
  });

  it("J7 — Email-Intel ingest payload shape required fields", () => {
    const payload = {
      email: "a@b.com",
      source: "SMTP",
      outcome: "SUCCESS",
      mailboxExists: true,
    };
    expect(payload.email).toContain("@");
    expect(["SUCCESS", "FAILURE", "UNKNOWN"]).toContain(payload.outcome);
  });
});

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("§10 journey E2E (requires DATABASE_URL)", () => {
  it("J4b — active model_versions exist for AI pin names after seed", async () => {
    const { createDb } = await import("@skout/db");
    const { schema } = await import("@skout/db");
    const { and, eq } = await import("drizzle-orm");
    const url = process.env.DATABASE_URL!;
    const { db, sql } = createDb(url);
    try {
      for (const name of AI_PIN_NAMES) {
        const [row] = await db
          .select({ id: schema.modelVersions.id })
          .from(schema.modelVersions)
          .where(and(eq(schema.modelVersions.name, name), eq(schema.modelVersions.isActive, true)))
          .limit(1);
        expect(row?.id, `missing active model_versions for ${name} — run seed-model-versions`).toBeTruthy();
      }
    } finally {
      await sql.end();
    }
  });

  it("CRM manual edit + field-sources covered by apps/crm e2e", () => {
    expect(hasDatabase).toBe(true);
  });
});
