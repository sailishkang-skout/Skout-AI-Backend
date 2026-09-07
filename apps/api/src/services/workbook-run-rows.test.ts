import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { getRunRows } from "./workbook-run.service.js";

const { workspaces, enrichmentWorkbooks, enrichmentWorkbookRuns, workbookColumnDefinitions, workbookColumnValues, prospectActivations } =
  schema;

describe("getRunRows", () => {
  const config = loadEnv();
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  let workspaceId: string;
  let workbookId: string;
  let runId: string;
  const prospectA = "prospect-a";
  const prospectB = "prospect-b";

  beforeAll(async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name: `Run Rows Test WS ${Date.now()}`, slug: `run-rows-test-${Date.now()}` })
      .returning();
    workspaceId = ws!.id;

    const [wb] = await db
      .insert(enrichmentWorkbooks)
      .values({ workspaceId, name: "Run Rows Workbook", fields: ["company", "email"] })
      .returning();
    workbookId = wb!.id;

    await db.insert(prospectActivations).values([
      {
        workspaceId,
        prospectId: prospectA,
        companyId: "company-a",
        snapshot: { fullName: "Ada Lovelace", email: "ada@acme.com", company: { companyName: "Acme" } },
      },
      {
        workspaceId,
        prospectId: prospectB,
        companyId: "company-b",
        snapshot: { fullName: "Bob Builder", companyName: "Buildco" },
      },
    ]);

    const [run] = await db
      .insert(enrichmentWorkbookRuns)
      .values({
        workbookId,
        workspaceId,
        listId: "00000000-0000-0000-0000-000000000000",
        mode: "sample",
        targetProspectIds: [prospectA, prospectB],
        totalRows: 2,
      })
      .returning();
    runId = run!.id;

    const [col] = await db
      .insert(workbookColumnDefinitions)
      .values({
        workspaceId,
        workbookId,
        key: "summary",
        label: "Summary",
        columnType: "derived",
        config: { template: "{{company}}" },
      })
      .returning();

    await db.insert(workbookColumnValues).values({
      workspaceId,
      workbookRunId: runId,
      columnDefinitionId: col!.id,
      prospectId: prospectA,
      status: "succeeded",
      value: "Acme",
      computedAt: new Date(),
    });
  });

  afterAll(async () => {
    await db.delete(workbookColumnValues).where(eq(workbookColumnValues.workbookRunId, runId));
    await db.delete(workbookColumnDefinitions).where(eq(workbookColumnDefinitions.workbookId, workbookId));
    await db.delete(enrichmentWorkbookRuns).where(eq(enrichmentWorkbookRuns.id, runId));
    await db.delete(enrichmentWorkbooks).where(eq(enrichmentWorkbooks.id, workbookId));
    await db.delete(prospectActivations).where(eq(prospectActivations.workspaceId, workspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await sql.end();
  });

  it("returns null for a nonexistent run", async () => {
    const rows = await getRunRows(db, workspaceId, "00000000-0000-0000-0000-000000000000");
    expect(rows).toBeNull();
  });

  it("returns one row per target prospect with fixed fields and flexible-column cells merged in", async () => {
    const rows = await getRunRows(db, workspaceId, runId);
    expect(rows).toHaveLength(2);

    const rowA = rows!.find((r) => r.prospectId === prospectA)!;
    expect(rowA.fullName).toBe("Ada Lovelace");
    expect(rowA.email).toBe("ada@acme.com");
    expect(rowA.companyName).toBe("Acme"); // from the nested `company.companyName` shape
    expect(rowA.columns.summary).toEqual({ status: "succeeded", value: "Acme", error: null });

    const rowB = rows!.find((r) => r.prospectId === prospectB)!;
    expect(rowB.fullName).toBe("Bob Builder");
    expect(rowB.companyName).toBe("Buildco"); // falls back to the flat `companyName` field
    expect(rowB.email).toBeNull();
    expect(rowB.columns).toEqual({}); // no column value computed for this prospect yet
  });
});
