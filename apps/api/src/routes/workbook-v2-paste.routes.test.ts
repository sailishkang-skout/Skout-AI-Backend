import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { invalidateWorkspaceAccess } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { withFailingCellInserts } from "../test/failing-cell-inserts.js";

/**
 * WB2-022: pasted blocks and typed rows, through the real routes against a real database. Typing a new row uses the
 * Rows API (`POST /rows`); a paste uses `POST /paste`.
 */
const base = loadEnv();
const hasDatabase = Boolean(base.DATABASE_URL);
const URL_BASE = "/api/v1/workbooks-v2";
const MISSING = "00000000-0000-4000-8000-0000000000ff";
const {
  workbooks, workbookColumns, workbookRows, workbookCells, workbookRuns, entitlements, auditLogs, enrichmentJobs, enrichmentResults,
  creditBalances, creditTransactions, asyncJobs,
} = schema;

interface Result {
  added: number;
  updated: number;
  cellsWritten: number;
  cellsCleared: number;
  rowCount: number;
  blankRows: number;
  invalid: { count: number; cells: Array<{ row: number; columnId: string; errorCode: string }> };
  rejected: { count: number; cells: Array<{ row: number; columnId: string; reason: string }> };
  skippedColumns: Array<{ columnId: string; values: number }>;
}

describe.skipIf(!hasDatabase)("Workbooks V2 paste and type", () => {
  const { db, sql } = createDb(base.DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  const config = { ...base, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal" as const, OPENSEARCH_URL: undefined, EARLY_ACCESS_GATE_ENABLED: "true" as never, RATE_LIMIT_MAX: 100_000, PLATFORM_ADMIN_EMAILS: [] };
  let app: Awaited<ReturnType<typeof buildApp>>;
  let n = 0;

  beforeAll(async () => {
    app = await buildApp(config);
  });
  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  // ── People and workbooks ───────────────────────────────────────────────────

  interface User {
    userId: string;
    workspaceId: string;
    ip: string;
    headers: Record<string, string>;
  }

  async function user(): Promise<User> {
    n += 1;
    const email = `wb2-paste-${suffix}-${n}@test.com`;
    const ip = `17.${Math.floor(n / 250)}.${n % 250}.7`;
    await app.inject({ method: "GET", url: "/api/v1/me", headers: { "x-stub-user-email": email }, remoteAddress: ip });
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u!.id));
    await db.update(schema.workspaces).set({ accessStatus: "active" }).where(eq(schema.workspaces.id, m!.workspaceId));
    await setEntitlement(m!.workspaceId, "feature.workbooks_v2", true);
    return { userId: u!.id, workspaceId: m!.workspaceId, ip, headers: { "x-stub-user-email": email } };
  }

  async function setEntitlement(workspaceId: string, key: string, value: unknown) {
    await db
      .insert(entitlements)
      .values({ workspaceId, key, value, source: "test" })
      .onConflictDoUpdate({ target: [entitlements.workspaceId, entitlements.key], set: { value } });
    invalidateWorkspaceAccess(workspaceId);
  }

  async function colleague(owner: User, permissions: string[]): Promise<User> {
    const other = await user();
    await db.insert(schema.workspaceMembers).values({ workspaceId: owner.workspaceId, userId: other.userId, role: "member" });
    await db.delete(schema.workspaceMemberRoles).where(and(eq(schema.workspaceMemberRoles.workspaceId, owner.workspaceId), eq(schema.workspaceMemberRoles.userId, other.userId)));
    const key = `paste-${suffix}-${++n}`;
    const [role] = await db.insert(schema.roles).values({ workspaceId: owner.workspaceId, key, name: key, description: "test", isSystem: false }).returning();
    if (permissions.length) await db.insert(schema.rolePermissions).values(permissions.map((permissionKey) => ({ roleId: role!.id, permissionKey })));
    await db.insert(schema.workspaceMemberRoles).values({ workspaceId: owner.workspaceId, userId: other.userId, roleId: role!.id });
    return { ...other, workspaceId: owner.workspaceId, headers: { ...other.headers, "x-workspace-id": owner.workspaceId } };
  }

  type Method = "GET" | "POST" | "PATCH" | "DELETE";
  const call = (u: User, method: Method, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url: `${URL_BASE}${p}`,
      remoteAddress: u.ip,
      headers: { ...u.headers, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });

  type Spec = { name: string; type?: "input" | "enrichment" | "formula" | "ai" | "action"; dataType?: string };
  async function workbook(u: User, specs: Spec[]) {
    const res = await call(u, "POST", "", { name: "Paste" });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().data.id as string;
    const made = specs.map((c, position) => ({
      id: randomUUID(),
      workbookId: id,
      name: c.name,
      type: c.type ?? ("input" as const),
      operation: c.type === "enrichment" ? "find_email" : c.type === "action" ? "add_to_list" : null,
      position,
      config: !c.type || c.type === "input" ? { dataType: c.dataType ?? "text" } : { inputs: {} },
    }));
    await db.insert(workbookColumns).values(made);
    return { id, col: Object.fromEntries(made.map((c) => [c.name, c.id])) as Record<string, string> };
  }

  type Start = { rowId: number; endRowId: number; rows: number };
  const paste = (u: User, workbookId: string, columnIds: string[], values: string[][], start?: Start, headers: Record<string, string> = {}) =>
    call(u, "POST", `/${workbookId}/paste`, { columnIds, values, ...(start ? { start } : {}) }, headers);

  async function pasted(u: User, workbookId: string, columnIds: string[], values: string[][], start?: Start): Promise<Result> {
    const res = await paste(u, workbookId, columnIds, values, start);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data;
  }

  async function refused(res: ReturnType<typeof paste>, status: number, code: string) {
    const answer = await res;
    expect(answer.statusCode, answer.body).toBe(status);
    expect(answer.json().code).toBe(code);
    return answer.json();
  }

  /** The workbook's rows in order, with each value by column name. */
  async function stored(workbookId: string) {
    const columns = await db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, workbookId));
    const name = new Map(columns.map((c) => [c.id, c.name]));
    const rows = await db.select().from(workbookRows).where(eq(workbookRows.workbookId, workbookId)).orderBy(asc(workbookRows.position));
    const cells = await db.select().from(workbookCells).where(eq(workbookCells.workbookId, workbookId));
    return rows.map((r) => {
      const mine = cells.filter((c) => c.rowId === r.id);
      return {
        ...r,
        cells: Object.fromEntries(mine.map((c) => [name.get(c.columnId)!, c])),
        values: Object.fromEntries(mine.map((c) => [name.get(c.columnId)!, c.value])),
      };
    });
  }
  const values = async (workbookId: string) => (await stored(workbookId)).map((r) => r.values);
  const rowCount = async (workbookId: string) => (await db.select({ n: workbooks.rowCount }).from(workbooks).where(eq(workbooks.id, workbookId)))[0]!.n;
  const added = async (workbookId: string) =>
    (await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, workbookId), eq(auditLogs.action, "workbook.rows.added"))).orderBy(asc(auditLogs.createdAt))).map((e) => e.afterState);
  /** The paste that lands on these stored rows, from the first to the last of them. */
  const over = (rows: Array<{ id: number }>): Start => ({ rowId: rows[0]!.id, endRowId: rows[rows.length - 1]!.id, rows: rows.length });

  const TYPED = [
    ["linkedin_url", ["https://www.linkedin.com/in/ada", "linkedin.com/in/grace", "https://uk.linkedin.com/in/alan"], "not a profile"],
    ["email", ["ada@example.com", "grace@example.org", "alan@example.co.uk"], "ada at example.com"],
    ["domain", ["example.com", "sub.example.org", "example.co.uk"], "https://example.com/about"],
  ] as const;

  // ── Single values and lists ────────────────────────────────────────────────

  describe.each(TYPED)("%s values", (dataType, good, bad) => {
    it("pastes a single value as one new row, marked as pasted", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "Value", dataType }]);
      const result = await pasted(u, b.id, [b.col.Value!], [[good[0]]]);
      expect(result).toMatchObject({ added: 1, updated: 0, rowCount: 1, invalid: { count: 0 }, rejected: { count: 0 } });
      const [row] = await stored(b.id);
      expect(row!.source).toEqual({ type: "paste" });
      expect(row!.cells.Value).toMatchObject({ value: good[0], state: "found", errorCode: null, creditsCharged: 0, foundVia: null });
      expect(await rowCount(b.id)).toBe(1);
      expect(await added(b.id)).toEqual([{ source: "paste", rows: 1, rowCount: 1 }]);
    });

    it("pastes a list as one row each, in order", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "Value", dataType }]);
      await pasted(u, b.id, [b.col.Value!], good.map((v) => [`  ${v}  `]));
      expect((await values(b.id)).map((r) => r.Value)).toEqual([...good]);
      expect((await stored(b.id)).map((r) => r.position)).toEqual([0, 1, 2]);
      expect(await added(b.id)).toEqual([{ source: "paste", rows: 3, rowCount: 3 }]);
    });

    it("keeps and flags the odd value that does not fit", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "Value", dataType }]);
      const result = await pasted(u, b.id, [b.col.Value!], [[good[0]], [bad], [good[1]]]);
      expect(result.invalid).toEqual({ count: 1, cells: [{ row: 1, columnId: b.col.Value, errorCode: `invalid_${dataType}` }] });
      expect((await stored(b.id))[1]!.cells.Value).toMatchObject({ value: bad, state: "error", errorCode: `invalid_${dataType}` });
    });

    it("refuses to put them into a column of another kind, saying what they look like", async () => {
      const u = await user();
      const other = dataType === "email" ? "domain" : "email";
      const b = await workbook(u, [{ name: "Value", dataType: other }]);
      const answer = await refused(paste(u, b.id, [b.col.Value!], good.map((v) => [v])), 422, "INCOMPATIBLE_COLUMN");
      expect(answer.details.columns).toEqual([{ columnId: b.col.Value, dataType: other, values: 3, invalid: 3, looksLike: dataType }]);
      expect(await stored(b.id)).toEqual([]);
      expect(await added(b.id)).toEqual([]);
    });
  });

  describe("which column takes what", () => {
    it("refuses a single wrong value, and a column that most values do not fit, but not an even split", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "Email", dataType: "email" }]);
      await refused(paste(u, b.id, [b.col.Email!], [["Ada Lovelace"]]), 422, "INCOMPATIBLE_COLUMN");
      await refused(paste(u, b.id, [b.col.Email!], [["a@example.com"], ["b"], ["c"]]), 422, "INCOMPATIBLE_COLUMN");
      expect(await stored(b.id)).toEqual([]);
      expect(await pasted(u, b.id, [b.col.Email!], [["a@example.com"], ["b"], [""]])).toMatchObject({ added: 2, blankRows: 1, invalid: { count: 1 } });
    });

    it("refuses the whole block when one of its columns is wrong", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "Name" }, { name: "Email", dataType: "email" }, { name: "Domain", dataType: "domain" }]);
      const answer = await refused(
        paste(u, b.id, [b.col.Name!, b.col.Email!, b.col.Domain!], [["Ada", "example.com", "ada@example.com"], ["Grace", "example.org", "grace@example.org"]]),
        422,
        "INCOMPATIBLE_COLUMN"
      );
      expect(answer.details.columns.map((c: { dataType: string; looksLike: string }) => [c.dataType, c.looksLike])).toEqual([["email", "domain"], ["domain", "email"]]);
      expect(await stored(b.id)).toEqual([]);
    });

    it("takes anything into a text column, and checks the other types as typing does", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "Text" }, { name: "Number", dataType: "number" }, { name: "Yes", dataType: "checkbox" }, { name: "When", dataType: "date" }]);
      await pasted(u, b.id, [b.col.Text!, b.col.Number!, b.col.Yes!, b.col.When!], [["ada@example.com", "42", "yes", "2026-01-31"]]);
      expect(await values(b.id)).toEqual([{ Text: "ada@example.com", Number: 42, Yes: true, When: "2026-01-31" }]);
    });
  });

  // ── Blocks ─────────────────────────────────────────────────────────────────

  describe("blocks", () => {
    const people = async (u: User) => {
      const b = await workbook(u, [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }]);
      await pasted(u, b.id, [b.col.A!, b.col.B!, b.col.C!, b.col.D!], [1, 2, 3, 4].map((i) => [`a${i}`, `b${i}`, `c${i}`, `d${i}`]));
      return { ...b, rows: await stored(b.id) };
    };

    it("keeps the shape of a block, empty cells included, and makes no row for an empty line", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "A" }, { name: "B" }, { name: "C" }]);
      const result = await pasted(u, b.id, [b.col.A!, b.col.B!, b.col.C!], [["a1", "", "c1"], ["", "", ""], ["", "b3", ""]]);
      expect(result).toMatchObject({ added: 2, blankRows: 1, cellsWritten: 3, rowCount: 2 });
      expect(await values(b.id)).toEqual([{ A: "a1", C: "c1" }, { B: "b3" }]);
    });

    it("overwrites from the starting cell, leaves everything outside the block alone, and adds the rows past the end", async () => {
      const u = await user();
      const b = await people(u);
      const result = await pasted(u, b.id, [b.col.B!, b.col.C!], [["B3", ""], ["B4", "C4"], ["B5", "C5"]], over(b.rows.slice(2)));
      expect(result).toMatchObject({ added: 1, updated: 2, cellsWritten: 5, cellsCleared: 1, rowCount: 5, blankRows: 0 });
      expect(await values(b.id)).toEqual([
        { A: "a1", B: "b1", C: "c1", D: "d1" },
        { A: "a2", B: "b2", C: "c2", D: "d2" },
        { A: "a3", B: "B3", D: "d3" },
        { A: "a4", B: "B4", C: "C4", D: "d4" },
        { B: "B5", C: "C5" },
      ]);
      const after = await stored(b.id);
      expect(after.slice(0, 4).map((r) => r.id)).toEqual(b.rows.map((r) => r.id));
      expect(after.map((r) => r.source.type)).toEqual(["paste", "paste", "paste", "paste", "paste"]);
      expect(await added(b.id)).toEqual([{ source: "paste", rows: 4, rowCount: 4 }, { source: "paste", rows: 1, rowCount: 5 }]);
    });

    it("writes only the rows it covers, in the middle of a workbook, and records no addition", async () => {
      const u = await user();
      const b = await people(u);
      const result = await pasted(u, b.id, [b.col.A!], [["A2"], ["A3"]], over(b.rows.slice(1, 3)));
      expect(result).toMatchObject({ added: 0, updated: 2, cellsWritten: 2, rowCount: 4 });
      expect((await values(b.id)).map((r) => r.A)).toEqual(["a1", "A2", "A3", "a4"]);
      expect(await added(b.id)).toHaveLength(1);
    });

    it("follows the order of the rows across gaps left by deleted ones", async () => {
      const u = await user();
      const b = await people(u);
      expect((await call(u, "DELETE", `/${b.id}/rows/${b.rows[1]!.id}`)).statusCode).toBe(200);
      const left = await stored(b.id);
      await pasted(u, b.id, [b.col.A!], [["x"], ["y"]], over(left.slice(0, 2)));
      expect((await values(b.id)).map((r) => r.A)).toEqual(["x", "y", "a4"]);
    });

    it("refuses a paste made against rows that have changed since", async () => {
      const u = await user();
      const b = await people(u);
      const three = over(b.rows.slice(0, 3));
      expect((await call(u, "DELETE", `/${b.id}/rows/${b.rows[1]!.id}`)).statusCode).toBe(200);
      const before = await values(b.id);
      const block = [["x"], ["y"], ["z"]];
      await refused(paste(u, b.id, [b.col.A!], block, three), 409, "ROWS_CHANGED");
      await refused(paste(u, b.id, [b.col.A!], block, { rowId: b.rows[1]!.id, endRowId: b.rows[3]!.id, rows: 3 }), 409, "ROWS_CHANGED");
      await refused(paste(u, b.id, [b.col.A!], block, { rowId: b.rows[0]!.id, endRowId: b.rows[3]!.id, rows: 2 }), 409, "ROWS_CHANGED");
      // More rows than there are from there on.
      await refused(paste(u, b.id, [b.col.A!], block, { rowId: b.rows[3]!.id, endRowId: b.rows[3]!.id, rows: 2 }), 409, "ROWS_CHANGED");
      expect(await values(b.id)).toEqual(before);
    });

    it("leaves out columns that cannot be edited, says how many values, and writes nothing into them", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "Name" }, { name: "Found", type: "enrichment" }, { name: "City" }]);
      const result = await pasted(u, b.id, [b.col.Name!, b.col.Found!, b.col.City!], [["Ada", "x@example.com", "London"], ["Grace", "", "Paris"]]);
      expect(result.skippedColumns).toEqual([{ columnId: b.col.Found, values: 1 }]);
      expect(await values(b.id)).toEqual([{ Name: "Ada", City: "London" }, { Name: "Grace", City: "Paris" }]);
      // Over existing rows too, even where the block has nothing for that column.
      await db.insert(workbookCells).values({ workbookId: b.id, rowId: (await stored(b.id))[0]!.id, columnId: b.col.Found!, state: "found", value: "kept@example.com" });
      await pasted(u, b.id, [b.col.Found!, b.col.City!], [["", "Rome"]], over((await stored(b.id)).slice(0, 1)));
      expect((await values(b.id))[0]).toEqual({ Name: "Ada", Found: "kept@example.com", City: "Rome" });
    });

    it("refuses a paste with nowhere to go, or into a column that has gone", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "Name" }, { name: "Found", type: "enrichment" }]);
      await refused(paste(u, b.id, [b.col.Found!], [["x"]]), 422, "NOT_AN_INPUT_COLUMN");
      await refused(paste(u, b.id, [b.col.Name!, MISSING], [["x", "y"]]), 422, "UNKNOWN_COLUMN");
      expect(await stored(b.id)).toEqual([]);
    });

    it("leaves a cell as it was when a value is more than it can hold, and reports it", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "A" }, { name: "B" }]);
      await pasted(u, b.id, [b.col.A!, b.col.B!], [["keep", "keep"]]);
      const long = "x".repeat(10_001);
      const result = await pasted(u, b.id, [b.col.A!, b.col.B!], [[long, "new"], ["nul\u0000", ""], ["ok", long]], over(await stored(b.id)));
      expect(result).toMatchObject({ added: 1, updated: 1, blankRows: 1, rejected: { count: 3 } });
      expect(result.rejected.cells.map((c) => [c.row, c.columnId])).toEqual([[0, b.col.A], [1, b.col.A], [2, b.col.B]]);
      expect(await values(b.id)).toEqual([{ A: "keep", B: "new" }, { A: "ok" }]);
    });

    it("drops what said where an overwritten value came from", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "Email", dataType: "email" }]);
      await pasted(u, b.id, [b.col.Email!], [["old@example.com"]]);
      await db.update(workbookCells).set({ foundVia: "cache", verification: "valid", confidence: 90, creditsCharged: 2, internalProvenance: { provider: "x" } }).where(eq(workbookCells.workbookId, b.id));
      await pasted(u, b.id, [b.col.Email!], [["new@example.com"]], over(await stored(b.id)));
      expect((await stored(b.id))[0]!.cells.Email).toMatchObject({ value: "new@example.com", foundVia: null, verification: null, confidence: null, creditsCharged: 0, internalProvenance: null });
    });

    it("never answers with provenance", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "Name" }]);
      const res = await paste(u, b.id, [b.col.Name!], [["Ada"]]);
      expect(res.body).not.toMatch(/provenance|provider/i);
    });
  });

  // ── Row limit ──────────────────────────────────────────────────────────────

  describe("row limit", () => {
    it("fills a workbook exactly, then refuses a paste that does not fit without changing anything", async () => {
      const u = await user();
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 3);
      const b = await workbook(u, [{ name: "A" }]);
      await pasted(u, b.id, [b.col.A!], [["1"], ["2"]]);
      const rows = await stored(b.id);
      const answer = await refused(paste(u, b.id, [b.col.A!], [["x"], ["y"], ["z"], ["w"]], over(rows)), 422, "ROW_LIMIT_EXCEEDED");
      expect(answer.details).toEqual({ limit: 3, rows: 2, adding: 2 });
      expect(answer.message).toContain("room for 1 more");
      expect((await values(b.id)).map((r) => r.A)).toEqual(["1", "2"]);
      // Empty lines take no room.
      expect(await pasted(u, b.id, [b.col.A!], [[""], ["3"], [""]])).toMatchObject({ added: 1, rowCount: 3, blankRows: 2 });
      // Overwriting needs none.
      expect(await pasted(u, b.id, [b.col.A!], [["one"]], over(rows.slice(0, 1)))).toMatchObject({ added: 0, updated: 1 });
      await refused(paste(u, b.id, [b.col.A!], [["4"]]), 422, "ROW_LIMIT_EXCEEDED");
      expect((await call(u, "POST", `/${b.id}/rows`, { cells: { [b.col.A!]: "4" } })).json().code).toBe("ROW_LIMIT_EXCEEDED");
      expect(await rowCount(b.id)).toBe(3);
    });

    it("does not let concurrent pastes pass the limit", async () => {
      const u = await user();
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 10);
      const b = await workbook(u, [{ name: "A" }]);
      const block = Array.from({ length: 4 }, (_, i) => [`v${i}`]);
      const answers = await Promise.all([0, 1, 2, 3].map(() => paste(u, b.id, [b.col.A!], block)));
      expect(answers.map((r) => r.statusCode).sort()).toEqual([200, 200, 422, 422]);
      expect(await rowCount(b.id)).toBe(8);
      expect(new Set((await stored(b.id)).map((r) => r.position)).size).toBe(8);
    });
  });

  // ── Retries and duplicates ─────────────────────────────────────────────────

  describe("retries", () => {
    it("adds a retried paste once, and a retried typed row once", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "A" }]);
      const key = { "idempotency-key": randomUUID() };
      const first = await paste(u, b.id, [b.col.A!], [["1"], ["2"]], undefined, key);
      const again = await paste(u, b.id, [b.col.A!], [["1"], ["2"]], undefined, key);
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual(first.json());
      const typed = { "idempotency-key": randomUUID() };
      for (let i = 0; i < 2; i++) expect((await call(u, "POST", `/${b.id}/rows`, { cells: { [b.col.A!]: "typed" } }, typed)).statusCode).toBe(201);
      expect((await values(b.id)).map((r) => r.A)).toEqual(["1", "2", "typed"]);
      expect(await added(b.id)).toHaveLength(2);
      expect((await paste(u, b.id, [b.col.A!], [["other"]], undefined, key)).statusCode).toBeGreaterThanOrEqual(400);
      expect(await rowCount(b.id)).toBe(3);
    });

    it("adds once when the same paste arrives twice at the same moment", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "A" }]);
      const key = { "idempotency-key": randomUUID() };
      const answers = await Promise.all([0, 1, 2].map(() => paste(u, b.id, [b.col.A!], [["1"], ["2"]], undefined, key)));
      expect(answers.every((r) => r.statusCode === 200 || r.statusCode === 409), answers.map((r) => r.body).join()).toBe(true);
      expect(await rowCount(b.id)).toBe(2);
    });

    it("keeps nothing of a paste that fails part way, and takes the same key again", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "A" }]);
      await pasted(u, b.id, [b.col.A!], [["before"]]);
      const rows = await stored(b.id);
      const boom = `boom-${suffix}`;
      const block = [["over"], ...Array.from({ length: 5_000 }, (_, i) => [i === 4_500 ? boom : `v${i}`])];
      const key = { "idempotency-key": randomUUID() };
      const failed = await withFailingCellInserts(sql, `wb2_paste_boom_${suffix}`, `new.value = '"${boom}"'::jsonb`, () => paste(u, b.id, [b.col.A!], block, over(rows), key));
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain("boom");
      expect(await values(b.id)).toEqual([{ A: "before" }]);
      expect(await rowCount(b.id)).toBe(1);
      expect(await added(b.id)).toHaveLength(1);
      const retried = await paste(u, b.id, [b.col.A!], block, over(rows), key);
      expect(retried.statusCode, retried.body).toBe(200);
      expect(await rowCount(b.id)).toBe(5_001);
    });

    // Reuses the workbook's existing behaviour (WB2-022 scope): only imports deduplicate.
    it("does not deduplicate: the same values pasted again are new rows", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "Email", dataType: "email" }]);
      await pasted(u, b.id, [b.col.Email!], [["a@example.com"], ["a@example.com"]]);
      await pasted(u, b.id, [b.col.Email!], [["a@example.com"]]);
      expect(await rowCount(b.id)).toBe(3);
    });
  });

  // ── Typing ─────────────────────────────────────────────────────────────────

  describe("typed rows", () => {
    it("creates a row from one typed value, marked and logged as manual entry", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "Name" }, { name: "Email", dataType: "email" }]);
      const res = await call(u, "POST", `/${b.id}/rows`, { cells: { [b.col.Email!]: "ada@example.com" } });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({ rowCount: 1, data: { source: { type: "manual" } } });
      expect(await values(b.id)).toEqual([{ Email: "ada@example.com" }]);
      expect(await added(b.id)).toEqual([{ source: "manual", rows: 1, rowCount: 1 }]);
    });

    it("refuses typing into a column that cannot be edited", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "Found", type: "enrichment" }]);
      expect((await call(u, "POST", `/${b.id}/rows`, { cells: { [b.col.Found!]: "x" } })).json().code).toBe("NOT_AN_INPUT_COLUMN");
      expect(await stored(b.id)).toEqual([]);
    });
  });

  // ── Nothing runs ───────────────────────────────────────────────────────────

  it("runs and charges nothing when rows are pasted or typed into a workbook with runnable columns", async () => {
    const u = await user();
    const b = await workbook(u, [{ name: "Domain", dataType: "domain" }, { name: "Find", type: "enrichment" }, { name: "Shout", type: "formula" }, { name: "Think", type: "ai" }, { name: "Send", type: "action" }]);
    const spending = async () => ({
      balance: await db.select().from(creditBalances).where(eq(creditBalances.workspaceId, u.workspaceId)),
      ledger: await db.select().from(creditTransactions).where(eq(creditTransactions.workspaceId, u.workspaceId)),
      jobs: await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.workspaceId, u.workspaceId)),
      results: await db.select().from(enrichmentResults).where(eq(enrichmentResults.workspaceId, u.workspaceId)),
      async: await db.select().from(asyncJobs).where(eq(asyncJobs.workspaceId, u.workspaceId)),
      runs: await db.select().from(workbookRuns).where(eq(workbookRuns.workbookId, b.id)),
    });
    const before = await spending();
    await pasted(u, b.id, [b.col.Domain!], [["example.com"], ["example.org"]]);
    await call(u, "POST", `/${b.id}/rows`, { cells: { [b.col.Domain!]: "example.net" } });
    await pasted(u, b.id, [b.col.Domain!], [["changed.com"]], over((await stored(b.id)).slice(0, 1)));
    expect(await spending()).toEqual(before);
    const cells = await db.select().from(workbookCells).where(eq(workbookCells.workbookId, b.id));
    expect(cells.every((c) => c.columnId === b.col.Domain)).toBe(true);
    expect(cells).toHaveLength(3);
  });

  // ── Requests, permissions and workspaces ───────────────────────────────────

  describe("requests", () => {
    it("refuses a request that is not a block", async () => {
      const u = await user();
      const b = await workbook(u, [{ name: "A" }, { name: "B" }]);
      const [A, B] = [b.col.A!, b.col.B!];
      const bodies: unknown[] = [
        {},
        { columnIds: [], values: [["x"]] },
        { columnIds: [A], values: [] },
        { columnIds: [A, B], values: [["x"]] },
        { columnIds: [A], values: [["x", "y"]] },
        { columnIds: [A, A.toUpperCase()], values: [["x", "y"]] },
        { columnIds: [A], values: [[1]] },
        { columnIds: [A], values: [["x"]], source: { type: "manual" } },
        { columnIds: [A], values: [["x"]], prospectId: "p" },
        { columnIds: [A], values: [["x"]], start: { rowId: 1, endRowId: 1, rows: 2 } },
        { columnIds: [A], values: [["x"]], start: { rowId: 1, rows: 1 } },
        { columnIds: [A], values: Array.from({ length: 10_001 }, () => ["x"]) },
        { columnIds: Array.from({ length: 11 }, () => randomUUID()), values: Array.from({ length: 9_100 }, () => Array.from({ length: 11 }, () => "")) },
      ];
      for (const body of bodies) {
        const res = await call(u, "POST", `/${b.id}/paste`, body);
        expect(res.statusCode, `${JSON.stringify(body).slice(0, 80)} ${res.body.slice(0, 200)}`).toBe(422);
        expect(res.json().code).toBe("VALIDATION_FAILED");
      }
      expect(await stored(b.id)).toEqual([]);
    });

    it("takes the largest paste: 10,000 rows of 10 columns", async () => {
      const u = await user();
      const b = await workbook(u, Array.from({ length: 10 }, (_, i) => ({ name: `C${i}` })));
      const columns = Object.values(b.col);
      const block = Array.from({ length: 10_000 }, (_, r) => columns.map((_, c) => `row ${r} column ${c} some more text`));
      const first = await pasted(u, b.id, columns, block);
      expect(first).toMatchObject({ added: 10_000, cellsWritten: 100_000, rowCount: 10_000 });
      // And over all of them again.
      const ids = await db.select({ id: workbookRows.id }).from(workbookRows).where(eq(workbookRows.workbookId, b.id)).orderBy(asc(workbookRows.position));
      const second = await pasted(u, b.id, columns, block.map((row) => row.map((v, c) => (c === 0 ? "" : v.toUpperCase()))), over(ids));
      expect(second).toMatchObject({ added: 0, updated: 10_000, cellsWritten: 90_000, cellsCleared: 10_000 });
      const [check] = await sql`select count(*)::int as n, count(*) filter (where value #>> '{}' like 'ROW %')::int as upper from workbook_cells where workbook_id = ${b.id}`;
      expect(check).toEqual({ n: 90_000, upper: 90_000 });
    }, 120_000);

    it("lets someone who may edit paste, and nobody else", async () => {
      const owner = await user();
      const b = await workbook(owner, [{ name: "A" }]);
      const viewer = await colleague(owner, ["enrichment:read"]);
      const editor = await colleague(owner, ["enrichment:read", "enrichment:capture"]);
      expect((await paste(viewer, b.id, [b.col.A!], [["x"]])).statusCode).toBe(403);
      expect((await paste(viewer, b.id, [b.col.A!], [["x"]], undefined, { "idempotency-key": randomUUID() })).statusCode).toBe(403);
      expect((await paste(editor, b.id, [b.col.A!], [["y"]])).statusCode).toBe(200);
      expect(await values(b.id)).toEqual([{ A: "y" }]);
    });

    it("hides another workspace's workbook, a deleted one, and the whole feature when it is off", async () => {
      const [mine, theirs] = [await user(), await user()];
      const b = await workbook(theirs, [{ name: "A" }]);
      await refused(paste(mine, b.id, [b.col.A!], [["x"]]), 404, "NOT_FOUND");
      await refused(paste(theirs, MISSING, [b.col.A!], [["x"]]), 404, "NOT_FOUND");
      await setEntitlement(theirs.workspaceId, "feature.workbooks_v2", false);
      expect((await paste(theirs, b.id, [b.col.A!], [["x"]])).statusCode).toBe(403);
      await setEntitlement(theirs.workspaceId, "feature.workbooks_v2", true);
      expect((await call(theirs, "DELETE", `/${b.id}`)).statusCode).toBe(200);
      await refused(paste(theirs, b.id, [b.col.A!], [["x"]]), 404, "NOT_FOUND");
      expect(await stored(b.id)).toEqual([]);
    });
  });
});
