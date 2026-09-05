import { describe, expect, it, vi } from "vitest";
import { activateWorkbook, createWorkbook, getWorkbook, listWorkbooks, updateWorkbook } from "./workbook.service.js";
import { HttpError } from "../utils/http.js";

const WORKSPACE = "ws-1";
const WORKBOOK_ID = "wb-1";

function selectChain(result: unknown[], terminal: "where" | "orderBy" = "where") {
  const c: Record<string, unknown> = {};
  c.from = vi.fn().mockReturnValue(c);
  c.where = terminal === "where" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  c.orderBy = terminal === "orderBy" ? vi.fn().mockResolvedValue(result) : vi.fn().mockReturnValue(c);
  return c;
}

function insertReturning(result: unknown[]) {
  return { values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) };
}

function updateReturning(result: unknown[]) {
  return { set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) }) };
}

const ROW = {
  id: WORKBOOK_ID,
  workspaceId: WORKSPACE,
  name: "Default outreach enrichment",
  fields: ["company", "email", "validation"],
  emailQualityThreshold: "0.60",
  budgetCreditsPerRun: 500,
  status: "draft",
  activatedAt: null,
  resultListId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const FAKE_CONFIG = {} as never;

describe("createWorkbook", () => {
  it("creates a draft workbook and serializes numeric/date fields", async () => {
    const db = { insert: vi.fn().mockReturnValue(insertReturning([ROW])) };
    const result = await createWorkbook(db as never, WORKSPACE, {
      name: "Default outreach enrichment",
      fields: ["company", "email", "validation"],
      emailQualityThreshold: 0.6,
      budgetCreditsPerRun: 500,
    });
    expect(result).toMatchObject({
      id: WORKBOOK_ID,
      status: "draft",
      emailQualityThreshold: 0.6,
      budgetCreditsPerRun: 500,
      activatedAt: null,
    });
    expect(result.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("listWorkbooks / getWorkbook", () => {
  it("lists workbooks newest first", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([ROW], "orderBy")) };
    const result = await listWorkbooks(db as never, WORKSPACE);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(WORKBOOK_ID);
  });

  it("returns null when the workbook isn't found", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) };
    const result = await getWorkbook(db as never, WORKSPACE, WORKBOOK_ID);
    expect(result).toBeNull();
  });
});

describe("updateWorkbook", () => {
  it("returns null when the workbook doesn't exist", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) };
    const result = await updateWorkbook(db as never, WORKSPACE, WORKBOOK_ID, { name: "New name" });
    expect(result).toBeNull();
  });

  it("applies a partial patch", async () => {
    const updated = { ...ROW, name: "Renamed" };
    const db = {
      select: vi.fn().mockReturnValue(selectChain([ROW])),
      update: vi.fn().mockReturnValue(updateReturning([updated])),
    };
    const result = await updateWorkbook(db as never, WORKSPACE, WORKBOOK_ID, { name: "Renamed" });
    expect(result?.name).toBe("Renamed");
  });
});

describe("activateWorkbook", () => {
  it("throws 404 when the workbook doesn't exist", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([])) };
    await expect(activateWorkbook(db as never, FAKE_CONFIG, WORKSPACE, WORKBOOK_ID)).rejects.toThrow(HttpError);
  });

  it("throws 409 when already active", async () => {
    const db = { select: vi.fn().mockReturnValue(selectChain([{ ...ROW, status: "active" }])) };
    await expect(
      activateWorkbook(db as never, FAKE_CONFIG, WORKSPACE, WORKBOOK_ID)
    ).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("flips a draft workbook to active, stamps activatedAt, and links a new results list", async () => {
    const activated = {
      ...ROW,
      status: "active",
      activatedAt: new Date("2026-02-01T00:00:00Z"),
      resultListId: "list-1",
    };
    const resultListRow = {
      id: "list-1",
      workspaceId: WORKSPACE,
      name: "Default outreach enrichment — Results",
      sourceFilters: null,
      createdAt: new Date("2026-02-01T00:00:00Z"),
    };
    const db = {
      select: vi.fn().mockReturnValue(selectChain([ROW])),
      insert: vi.fn().mockReturnValue(insertReturning([resultListRow])),
      update: vi.fn().mockReturnValue(updateReturning([activated])),
    };
    const result = await activateWorkbook(db as never, FAKE_CONFIG, WORKSPACE, WORKBOOK_ID);
    expect(result.status).toBe("active");
    expect(result.activatedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(result.resultListId).toBe("list-1");
  });
});
