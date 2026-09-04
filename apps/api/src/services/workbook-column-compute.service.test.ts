import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { loadEnv } from "../config/env.js";
import type { WorkbookColumnConfig, WorkbookColumnRecord, WorkbookColumnType } from "./workbook-column.service.js";

const createCompletion = vi.fn();
vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: (...args: unknown[]) => createCompletion(...args) } };
  },
}));

const { computeColumnsForRow } = await import("./workbook-column-compute.service.js");

const { workspaces, enrichmentWorkbooks, enrichmentWorkbookRuns, workbookColumnDefinitions, workbookColumnValues, evidenceLedger } =
  schema;

describe("computeColumnsForRow", () => {
  const config = loadEnv();
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  let workspaceId: string;
  let workbookId: string;
  let workbookRunId: string;
  const prospectId = "prospect-1";

  async function makeColumn(overrides: {
    key: string;
    orderIndex?: number;
    columnType?: WorkbookColumnType;
    config: WorkbookColumnConfig;
  }): Promise<WorkbookColumnRecord> {
    const [row] = await db
      .insert(workbookColumnDefinitions)
      .values({
        workspaceId,
        workbookId,
        key: overrides.key,
        label: overrides.key,
        columnType: overrides.columnType ?? "derived",
        config: overrides.config,
        orderIndex: overrides.orderIndex ?? 0,
      })
      .returning();
    return {
      id: row!.id,
      workspaceId: row!.workspaceId,
      workbookId: row!.workbookId,
      key: row!.key,
      label: row!.label,
      columnType: row!.columnType as WorkbookColumnType,
      config: row!.config as WorkbookColumnConfig,
      orderIndex: row!.orderIndex,
      createdAt: row!.createdAt.toISOString(),
      updatedAt: row!.updatedAt.toISOString(),
    };
  }

  beforeAll(async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name: `Compute Test WS ${Date.now()}`, slug: `compute-test-${Date.now()}` })
      .returning();
    workspaceId = ws!.id;

    const [wb] = await db
      .insert(enrichmentWorkbooks)
      .values({ workspaceId, name: "Compute Test Workbook", fields: ["company"] })
      .returning();
    workbookId = wb!.id;

    const [run] = await db
      .insert(enrichmentWorkbookRuns)
      .values({ workbookId, workspaceId, listId: "00000000-0000-0000-0000-000000000000", mode: "sample" })
      .returning();
    workbookRunId = run!.id;
  });

  afterEach(() => {
    createCompletion.mockReset();
  });

  afterAll(async () => {
    await db.delete(workbookColumnValues).where(eq(workbookColumnValues.workbookRunId, workbookRunId));
    await db.delete(workbookColumnDefinitions).where(eq(workbookColumnDefinitions.workbookId, workbookId));
    await db.delete(evidenceLedger).where(eq(evidenceLedger.workspaceId, workspaceId));
    await db.delete(enrichmentWorkbookRuns).where(eq(enrichmentWorkbookRuns.id, workbookRunId));
    await db.delete(enrichmentWorkbooks).where(eq(enrichmentWorkbooks.id, workbookId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await sql.end();
  });

  it("computes a derived column successfully and writes a succeeded value", async () => {
    const col = await makeColumn({ key: "summary", config: { template: "{{company}} Inc" } });
    await computeColumnsForRow(db, config, workspaceId, workbookRunId, [col], prospectId, { company: "Acme" });

    const [row] = await db
      .select()
      .from(workbookColumnValues)
      .where(and(eq(workbookColumnValues.workbookRunId, workbookRunId), eq(workbookColumnValues.columnDefinitionId, col.id)));
    expect(row?.status).toBe("succeeded");
    expect(row?.value).toBe("Acme Inc");
  });

  it("marks a derived column failed when a referenced field is missing", async () => {
    const col = await makeColumn({ key: "summary2", config: { template: "{{nonexistent}}" } });
    await computeColumnsForRow(db, config, workspaceId, workbookRunId, [col], prospectId, { company: "Acme" });

    const [row] = await db
      .select()
      .from(workbookColumnValues)
      .where(and(eq(workbookColumnValues.workbookRunId, workbookRunId), eq(workbookColumnValues.columnDefinitionId, col.id)));
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("nonexistent");
  });

  it("a later derived column can reference an earlier column's just-computed value", async () => {
    const first = await makeColumn({ key: "first", orderIndex: 0, config: { template: "{{company}}!" } });
    const second = await makeColumn({ key: "second", orderIndex: 1, config: { template: "{{first}} again" } });
    await computeColumnsForRow(db, config, workspaceId, workbookRunId, [first, second], prospectId, { company: "Acme" });

    const [row] = await db
      .select()
      .from(workbookColumnValues)
      .where(and(eq(workbookColumnValues.workbookRunId, workbookRunId), eq(workbookColumnValues.columnDefinitionId, second.id)));
    expect(row?.value).toBe("Acme! again");
  });

  it("computes an AI research column, writes an evidence-pinned succeeded value", async () => {
    createCompletion.mockResolvedValue({ choices: [{ message: { content: "Acme is a widget maker." } }] });
    const configWithKey = { ...config, OPENROUTER_API_KEY: "test-key" } as typeof config;
    const col = await makeColumn({
      key: "research",
      columnType: "ai_research",
      config: { promptTemplate: "What does {{company}} do?" },
    });

    await computeColumnsForRow(db, configWithKey, workspaceId, workbookRunId, [col], prospectId, { company: "Acme" });

    const [row] = await db
      .select()
      .from(workbookColumnValues)
      .where(and(eq(workbookColumnValues.workbookRunId, workbookRunId), eq(workbookColumnValues.columnDefinitionId, col.id)));
    expect(row?.status).toBe("succeeded");
    expect(row?.value).toBe("Acme is a widget maker.");
    expect(row?.evidenceId).toBeTruthy();

    const [evidence] = await db.select().from(evidenceLedger).where(eq(evidenceLedger.id, row!.evidenceId!));
    expect(evidence?.source).toBe("workbook_ai_research");
  });

  it("marks an AI research column failed (not throwing) when no LLM is configured", async () => {
    const configNoKey = { ...config, OPENROUTER_API_KEY: undefined } as typeof config;
    const col = await makeColumn({
      key: "research2",
      columnType: "ai_research",
      config: { promptTemplate: "What does {{company}} do?" },
    });

    await expect(
      computeColumnsForRow(db, configNoKey, workspaceId, workbookRunId, [col], prospectId, { company: "Acme" })
    ).resolves.toBeUndefined();

    const [row] = await db
      .select()
      .from(workbookColumnValues)
      .where(and(eq(workbookColumnValues.workbookRunId, workbookRunId), eq(workbookColumnValues.columnDefinitionId, col.id)));
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe("ai_not_configured");
  });

  it("does not call the LLM when the prompt has a missing reference", async () => {
    const configWithKey = { ...config, OPENROUTER_API_KEY: "test-key" } as typeof config;
    const col = await makeColumn({
      key: "research3",
      columnType: "ai_research",
      config: { promptTemplate: "What does {{nope}} do?" },
    });

    await computeColumnsForRow(db, configWithKey, workspaceId, workbookRunId, [col], prospectId, { company: "Acme" });

    expect(createCompletion).not.toHaveBeenCalled();
    const [row] = await db
      .select()
      .from(workbookColumnValues)
      .where(and(eq(workbookColumnValues.workbookRunId, workbookRunId), eq(workbookColumnValues.columnDefinitionId, col.id)));
    expect(row?.status).toBe("failed");
  });
});
