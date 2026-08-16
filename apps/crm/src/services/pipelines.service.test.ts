// apps/crm/src/services/pipelines.service.test.ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, schema, type Db } from "@skout/db";
import { eq } from "drizzle-orm";
import { buildAuditService } from "./audit.service.js";
import { buildPipelinesService } from "./pipelines.service.js";

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
});
