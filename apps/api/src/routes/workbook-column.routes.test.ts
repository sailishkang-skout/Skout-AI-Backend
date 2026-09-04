import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { resolveOrProvisionUser } from "../services/auth.service.js";

async function buildTestApp() {
  const config = loadEnv();
  return buildApp({ ...config, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined });
}

function json(email: string) {
  return { "x-stub-user-email": email, "content-type": "application/json" };
}

const { enrichmentWorkbooks, enrichmentWorkbookRuns, workbookColumnDefinitions, workbookColumnValues } = schema;
const config = loadEnv();
const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
const seededWorkbookIds: string[] = [];

afterAll(async () => {
  for (const id of seededWorkbookIds) {
    await db.delete(workbookColumnValues).where(eq(workbookColumnValues.workbookRunId, id)).catch(() => {});
    await db.delete(workbookColumnDefinitions).where(eq(workbookColumnDefinitions.workbookId, id)).catch(() => {});
    await db.delete(enrichmentWorkbookRuns).where(eq(enrichmentWorkbookRuns.workbookId, id)).catch(() => {});
    await db.delete(enrichmentWorkbooks).where(eq(enrichmentWorkbooks.id, id)).catch(() => {});
  }
  await sql.end();
});

describe("workbook column routes", () => {
  it("creates, lists, and deletes a derived column end to end", async () => {
    const app = await buildTestApp();
    const owner = await resolveOrProvisionUser(db, "stub:wb-col-owner@test.com", "wb-col-owner@test.com", "Owner");

    const [wb] = await db
      .insert(enrichmentWorkbooks)
      .values({ workspaceId: owner.workspaceId, name: "Route Test Workbook", fields: ["company"] })
      .returning();
    seededWorkbookIds.push(wb!.id);

    const createRes = await app.inject({
      method: "POST",
      url: `/api/v1/workbooks/${wb!.id}/columns`,
      headers: json("wb-col-owner@test.com"),
      payload: { key: "summary", label: "Summary", columnType: "derived", template: "{{company}} Inc" },
    });
    expect(createRes.statusCode).toBe(201);
    const created = (createRes.json() as { key: string; id: string }).key;
    expect(created).toBe("summary");
    const columnId = (createRes.json() as { id: string }).id;

    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/workbooks/${wb!.id}/columns`,
      headers: json("wb-col-owner@test.com"),
    });
    expect(listRes.statusCode).toBe(200);
    expect((listRes.json() as { total: number }).total).toBe(1);

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/workbooks/${wb!.id}/columns/${columnId}`,
      headers: json("wb-col-owner@test.com"),
    });
    expect(deleteRes.statusCode).toBe(204);

    await app.close();
  });

  it("rejects an ai_research column missing promptTemplate", async () => {
    const app = await buildTestApp();
    const owner = await resolveOrProvisionUser(db, "stub:wb-col-invalid@test.com", "wb-col-invalid@test.com", "Owner");
    const [wb] = await db
      .insert(enrichmentWorkbooks)
      .values({ workspaceId: owner.workspaceId, name: "Invalid Body Workbook", fields: ["company"] })
      .returning();
    seededWorkbookIds.push(wb!.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workbooks/${wb!.id}/columns`,
      headers: json("wb-col-invalid@test.com"),
      payload: { key: "research", label: "Research", columnType: "ai_research" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 422 for a template referencing an unknown column", async () => {
    const app = await buildTestApp();
    const owner = await resolveOrProvisionUser(db, "stub:wb-col-unknown@test.com", "wb-col-unknown@test.com", "Owner");
    const [wb] = await db
      .insert(enrichmentWorkbooks)
      .values({ workspaceId: owner.workspaceId, name: "Unknown Ref Workbook", fields: ["company"] })
      .returning();
    seededWorkbookIds.push(wb!.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workbooks/${wb!.id}/columns`,
      headers: json("wb-col-unknown@test.com"),
      payload: { key: "bad", label: "Bad", columnType: "derived", template: "{{not_real}}" },
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("does not create a column on a workbook belonging to a different workspace (cross-tenant isolation)", async () => {
    const app = await buildTestApp();
    const owner = await resolveOrProvisionUser(db, "stub:wb-col-tenant-owner@test.com", "wb-col-tenant-owner@test.com", "Owner");
    const [wb] = await db
      .insert(enrichmentWorkbooks)
      .values({ workspaceId: owner.workspaceId, name: "Tenant Isolation Workbook", fields: ["company"] })
      .returning();
    seededWorkbookIds.push(wb!.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workbooks/${wb!.id}/columns`,
      headers: json("wb-col-tenant-intruder@test.com"),
      payload: { key: "hijack", label: "Hijack", columnType: "derived", template: "x" },
    });
    expect(res.statusCode).toBe(404);

    const columns = await db.select().from(workbookColumnDefinitions).where(eq(workbookColumnDefinitions.workbookId, wb!.id));
    expect(columns).toHaveLength(0);
    await app.close();
  });

  it("returns computed values for a run, scoped to the caller's workspace", async () => {
    const app = await buildTestApp();
    const owner = await resolveOrProvisionUser(db, "stub:wb-col-values@test.com", "wb-col-values@test.com", "Owner");
    const [wb] = await db
      .insert(enrichmentWorkbooks)
      .values({ workspaceId: owner.workspaceId, name: "Values Workbook", fields: ["company"] })
      .returning();
    seededWorkbookIds.push(wb!.id);

    const [run] = await db
      .insert(enrichmentWorkbookRuns)
      .values({ workbookId: wb!.id, workspaceId: owner.workspaceId, listId: "00000000-0000-0000-0000-000000000000", mode: "sample" })
      .returning();
    const [col] = await db
      .insert(workbookColumnDefinitions)
      .values({
        workspaceId: owner.workspaceId,
        workbookId: wb!.id,
        key: "summary",
        label: "Summary",
        columnType: "derived",
        config: { template: "{{company}}" },
      })
      .returning();
    await db.insert(workbookColumnValues).values({
      workspaceId: owner.workspaceId,
      workbookRunId: run!.id,
      columnDefinitionId: col!.id,
      prospectId: "prospect-1",
      status: "succeeded",
      value: "Acme",
      computedAt: new Date(),
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workbooks/${wb!.id}/runs/${run!.id}/columns`,
      headers: json("wb-col-values@test.com"),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { value: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.data[0]?.value).toBe("Acme");

    const crossTenantRes = await app.inject({
      method: "GET",
      url: `/api/v1/workbooks/${wb!.id}/runs/${run!.id}/columns`,
      headers: json("wb-col-values-intruder@test.com"),
    });
    expect((crossTenantRes.json() as { total: number }).total).toBe(0);

    await app.close();
  });
});
