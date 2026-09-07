import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { createColumn, deleteColumn, listColumns } from "./workbook-column.service.js";

const { workspaces, enrichmentWorkbooks, workbookColumnDefinitions } = schema;

describe("workbook-column.service", () => {
  const config = loadEnv();
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  let workspaceId: string;
  let otherWorkspaceId: string;
  let workbookId: string;

  beforeAll(async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name: `Workbook Column Test WS ${Date.now()}`, slug: `workbook-column-test-${Date.now()}` })
      .returning();
    workspaceId = ws!.id;

    const [otherWs] = await db
      .insert(workspaces)
      .values({ name: `Workbook Column Other WS ${Date.now()}`, slug: `workbook-column-other-${Date.now()}` })
      .returning();
    otherWorkspaceId = otherWs!.id;

    const [wb] = await db
      .insert(enrichmentWorkbooks)
      .values({ workspaceId, name: "Test Workbook", fields: ["company", "email"] })
      .returning();
    workbookId = wb!.id;
  });

  beforeEach(async () => {
    await db.delete(workbookColumnDefinitions).where(eq(workbookColumnDefinitions.workbookId, workbookId));
  });

  afterAll(async () => {
    await db.delete(workbookColumnDefinitions).where(eq(workbookColumnDefinitions.workbookId, workbookId));
    await db.delete(enrichmentWorkbooks).where(eq(enrichmentWorkbooks.id, workbookId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, otherWorkspaceId));
    await sql.end();
  });

  it("throws workbook_not_found for a nonexistent workbook", async () => {
    await expect(
      createColumn(db, workspaceId, "00000000-0000-0000-0000-000000000000", {
        key: "greeting",
        label: "Greeting",
        columnType: "derived",
        config: { template: "hi" },
      })
    ).rejects.toThrow("workbook_not_found");
  });

  it("cross-tenant isolation: does not find a workbook belonging to a different workspace", async () => {
    await expect(
      createColumn(db, otherWorkspaceId, workbookId, {
        key: "greeting",
        label: "Greeting",
        columnType: "derived",
        config: { template: "hi" },
      })
    ).rejects.toThrow("workbook_not_found");
  });

  it("rejects an invalid key format", async () => {
    await expect(
      createColumn(db, workspaceId, workbookId, {
        key: "Not Valid!",
        label: "x",
        columnType: "derived",
        config: { template: "hi" },
      })
    ).rejects.toThrow("invalid_column_key");
  });

  it("creates a derived column referencing a fixed field", async () => {
    const col = await createColumn(db, workspaceId, workbookId, {
      key: "summary",
      label: "Summary",
      columnType: "derived",
      config: { template: "{{company}} — {{title}}" },
    });
    expect(col.key).toBe("summary");
    expect(col.orderIndex).toBe(0);
  });

  it("rejects a template referencing an unknown column", async () => {
    await expect(
      createColumn(db, workspaceId, workbookId, {
        key: "bad",
        label: "Bad",
        columnType: "derived",
        config: { template: "{{not_a_real_column}}" },
      })
    ).rejects.toThrow("unknown_template_reference");
  });

  it("allows a later column to reference an earlier one, in order", async () => {
    await createColumn(db, workspaceId, workbookId, {
      key: "first",
      label: "First",
      columnType: "derived",
      config: { template: "{{company}}" },
    });
    const second = await createColumn(db, workspaceId, workbookId, {
      key: "second",
      label: "Second",
      columnType: "derived",
      config: { template: "{{first}} extra" },
    });
    expect(second.orderIndex).toBe(1);
  });

  it("rejects a duplicate key within the same workbook", async () => {
    await createColumn(db, workspaceId, workbookId, {
      key: "dup",
      label: "Dup",
      columnType: "derived",
      config: { template: "{{company}}" },
    });
    await expect(
      createColumn(db, workspaceId, workbookId, {
        key: "dup",
        label: "Dup Again",
        columnType: "ai_research",
        config: { promptTemplate: "research {{company}}" },
      })
    ).rejects.toThrow("column_key_already_exists");
  });

  it("lists columns in order_index order", async () => {
    await createColumn(db, workspaceId, workbookId, { key: "a", label: "A", columnType: "derived", config: { template: "{{company}}" } });
    await createColumn(db, workspaceId, workbookId, { key: "b", label: "B", columnType: "derived", config: { template: "{{a}}" } });
    const cols = await listColumns(db, workspaceId, workbookId);
    expect(cols.map((c) => c.key)).toEqual(["a", "b"]);
  });

  it("deletes a column with no dependents", async () => {
    const col = await createColumn(db, workspaceId, workbookId, {
      key: "removable",
      label: "Removable",
      columnType: "derived",
      config: { template: "{{company}}" },
    });
    const deleted = await deleteColumn(db, workspaceId, workbookId, col.id);
    expect(deleted).toBe(true);
    expect(await listColumns(db, workspaceId, workbookId)).toHaveLength(0);
  });

  it("refuses to delete a column still referenced by another column", async () => {
    const base = await createColumn(db, workspaceId, workbookId, {
      key: "base",
      label: "Base",
      columnType: "derived",
      config: { template: "{{company}}" },
    });
    await createColumn(db, workspaceId, workbookId, {
      key: "dependent",
      label: "Dependent",
      columnType: "derived",
      config: { template: "{{base}} extra" },
    });
    await expect(deleteColumn(db, workspaceId, workbookId, base.id)).rejects.toThrow("column_still_referenced");
  });

  it("returns false when deleting a nonexistent column", async () => {
    const deleted = await deleteColumn(db, workspaceId, workbookId, "00000000-0000-0000-0000-000000000000");
    expect(deleted).toBe(false);
  });
});
