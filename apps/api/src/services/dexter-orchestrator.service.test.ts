import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, schema } from "@skout/db";
import { eq } from "drizzle-orm";
import { loadEnv } from "../config/env.js";
import { matchTriggers } from "./dexter-orchestrator.service.js";

const { dexterTriggers, workspaces } = schema;

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("matchTriggers", () => {
  const config = loadEnv();
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  let workspaceId: string;

  beforeAll(async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name: `Dexter Orchestrator Test WS ${Date.now()}`, slug: `dexter-orch-test-${Date.now()}` })
      .returning();
    workspaceId = ws!.id;
  });

  afterAll(async () => {
    await db.delete(dexterTriggers).where(eq(dexterTriggers.workspaceId, workspaceId));
    await sql.end();
  });

  it("returns only enabled triggers matching workspace + event type", async () => {
    await db.insert(dexterTriggers).values([
      {
        workspaceId,
        eventType: "regional_brief.approved",
        actionType: "enroll_sequence",
        actionParams: { sequenceId: "seq-1", listId: "list-1" },
        enabled: true,
      },
      {
        workspaceId,
        eventType: "regional_brief.approved",
        actionType: "enroll_sequence",
        actionParams: { sequenceId: "seq-2", listId: "list-2" },
        enabled: false,
      },
      {
        workspaceId,
        eventType: "icp.approved",
        actionType: "enroll_sequence",
        actionParams: { sequenceId: "seq-3", listId: "list-3" },
        enabled: true,
      },
    ]);

    const matched = await matchTriggers(db, workspaceId, "regional_brief.approved");
    expect(matched).toHaveLength(1);
    expect(matched[0]).toMatchObject({
      actionType: "enroll_sequence",
      actionParams: { sequenceId: "seq-1", listId: "list-1" },
    });
  });

  it("returns an empty array when no trigger matches", async () => {
    const matched = await matchTriggers(db, workspaceId, "tam.approved");
    expect(matched).toEqual([]);
  });
});
