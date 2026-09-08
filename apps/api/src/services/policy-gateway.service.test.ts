import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, schema } from "@skout/db";
import { eq } from "drizzle-orm";
import { loadEnv } from "../config/env.js";
import {
  applyOnboardingAutonomyMode,
  DEFAULT_ACTION_MODES,
  getActionMode,
  upsertActionMode,
} from "./policy-gateway.service.js";

const { automationPolicies, workspaces } = schema;

describe("applyOnboardingAutonomyMode (SS-09)", () => {
  const config = loadEnv();
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  let workspaceId: string;

  beforeAll(async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name: `Autonomy Test WS ${Date.now()}`, slug: `autonomy-test-${Date.now()}` })
      .returning();
    workspaceId = ws!.id;
  });

  afterAll(async () => {
    await db.delete(automationPolicies).where(eq(automationPolicies.workspaceId, workspaceId));
    await sql.end();
  });

  beforeEach(async () => {
    await db.delete(automationPolicies).where(eq(automationPolicies.workspaceId, workspaceId));
  });

  it("autonomous: forces every known action key to auto, even ones that default to approve/draft/ask", async () => {
    await applyOnboardingAutonomyMode(db, workspaceId, "autonomous");

    for (const actionKey of Object.keys(DEFAULT_ACTION_MODES)) {
      expect(await getActionMode(db, workspaceId, actionKey)).toBe("auto");
    }
  });

  it("manual: only overrides the one action key whose default is auto (sequence.enroll), leaving the rest at their defaults", async () => {
    await applyOnboardingAutonomyMode(db, workspaceId, "manual");

    expect(await getActionMode(db, workspaceId, "sequence.enroll")).toBe("ask");
    for (const [actionKey, defaultMode] of Object.entries(DEFAULT_ACTION_MODES)) {
      if (actionKey === "sequence.enroll") continue;
      expect(await getActionMode(db, workspaceId, actionKey)).toBe(defaultMode);
    }
  });

  it("assisted: clears any prior override back to system defaults instead of writing anything", async () => {
    // Simulate a workspace that previously chose "autonomous", then switches to "assisted".
    await upsertActionMode(db, workspaceId, "dexter.plan_invoke", "auto");
    await upsertActionMode(db, workspaceId, "sequence.enroll", "auto");

    await applyOnboardingAutonomyMode(db, workspaceId, "assisted");

    for (const [actionKey, defaultMode] of Object.entries(DEFAULT_ACTION_MODES)) {
      expect(await getActionMode(db, workspaceId, actionKey)).toBe(defaultMode);
    }
    const rows = await db.select().from(automationPolicies).where(eq(automationPolicies.workspaceId, workspaceId));
    expect(rows).toHaveLength(0);
  });

  it("switching from autonomous back to manual actually reverts the override, not just adds to it", async () => {
    await applyOnboardingAutonomyMode(db, workspaceId, "autonomous");
    expect(await getActionMode(db, workspaceId, "dexter.plan_invoke")).toBe("auto");

    await applyOnboardingAutonomyMode(db, workspaceId, "manual");
    // dexter.plan_invoke's default is "approve" (not "auto"), so manual mode should have left
    // it alone at its default rather than continuing to carry the stale "auto" override — but
    // "leaving it alone" after a prior explicit "auto" write means the stale row must be reset,
    // not skipped, or the workspace would stay auto-approved despite picking "Manual".
    expect(await getActionMode(db, workspaceId, "dexter.plan_invoke")).toBe("approve");
  });
});
