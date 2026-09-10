// apps/crm/src/services/pipelines.service.test.ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, schema, type Db } from "@skout/db";
import { eq } from "drizzle-orm";
import { buildAuditService } from "./audit.service.js";
import { buildPipelinesService, PipelinesService } from "./pipelines.service.js";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("PipelinesService.ensureDefaultPipeline concurrency", () => {
  let db: Db;
  let closeDb: () => Promise<void>;

  beforeAll(() => {
    const created = createDb(process.env.DATABASE_URL!);
    db = created.db;
    closeDb = () => created.sql.end();
  });

  afterAll(async () => {
    await closeDb?.();
  });

  it("never leaves two default pipelines for the same workspace after concurrent calls", async () => {
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: "Race Test Workspace", slug: `race-test-${randomUUID()}` })
      .returning();

    const auditService = buildAuditService(db)!;
    const svcA = buildPipelinesService(db, auditService)!;
    const svcB = buildPipelinesService(db, auditService)!;

    const results = await Promise.allSettled([
      svcA.ensureDefaultPipeline(workspace.id),
      svcB.ensureDefaultPipeline(workspace.id),
    ]);

    for (const result of results) {
      expect(result.status).toBe("fulfilled");
    }

    const rows = await db.select().from(schema.pipelines).where(eq(schema.pipelines.workspaceId, workspace.id));
    const defaultRows = rows.filter((p) => p.isDefault);
    expect(defaultRows).toHaveLength(1);
  });

  it("frees the default slot when the default pipeline is soft-deleted, so a later call creates a new one", async () => {
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: "Soft Delete Test Workspace", slug: `soft-delete-test-${randomUUID()}` })
      .returning();

    const auditService = buildAuditService(db)!;
    const svc = buildPipelinesService(db, auditService)!;

    const original = await svc.ensureDefaultPipeline(workspace.id);

    const deleted = await svc.softDelete(workspace.id, original.id, undefined);
    expect(deleted).toBe(true);

    const replacement = await svc.ensureDefaultPipeline(workspace.id);

    expect(replacement.id).not.toBe(original.id);
    expect(replacement.isDefault).toBe(true);

    const rows = await db.select().from(schema.pipelines).where(eq(schema.pipelines.workspaceId, workspace.id));
    const liveDefaultRows = rows.filter((p) => p.isDefault && !p.deletedAt);
    expect(liveDefaultRows).toHaveLength(1);
    expect(liveDefaultRows[0]!.id).toBe(replacement.id);
  });
});

// ---------------------------------------------------------------------------
// ensureDefaultPipeline — deterministic 23505 recovery (mocked db, no real Postgres)
// ---------------------------------------------------------------------------

function selectChain(result: unknown[], terminal: "orderBy" | "limit" = "limit") {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.limit = terminal === "limit" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.orderBy = terminal === "orderBy" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  return c;
}

describe("PipelinesService.ensureDefaultPipeline 23505 recovery", () => {
  it("returns the winner's pipeline when the insert transaction races and loses to the partial unique index", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const winnerRow = {
      id: "winner-pipeline-id",
      workspaceId: "ws-1",
      name: "Sales Pipeline",
      isDefault: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    const db = { select: vi.fn(), transaction: vi.fn() };
    // 1st select: initial "does a default already exist" lookup -> none yet
    db.select.mockReturnValueOnce(selectChain([], "limit"));
    // transaction: the insert races and loses, surfacing a 23505 the way the postgres
    // driver's error looks once drizzle-orm wraps it (pgErrorCode checks `.code` directly).
    db.transaction.mockRejectedValueOnce(Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }));
    // 2nd select: the recovery re-query inside the catch -> finds the winner
    db.select.mockReturnValueOnce(selectChain([winnerRow], "limit"));
    // 3rd select: withStages() fetching the winner's stages -> none needed for this assertion
    db.select.mockReturnValueOnce(selectChain([], "orderBy"));

    const svc = new PipelinesService(db as any, {} as any);

    const result = await svc.ensureDefaultPipeline("ws-1");

    expect(result.id).toBe("winner-pipeline-id");
    expect(result.isDefault).toBe(true);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.select).toHaveBeenCalledTimes(3);
  });
});
