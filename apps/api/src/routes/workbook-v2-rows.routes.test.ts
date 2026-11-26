import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { invalidateWorkspaceAccess } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

/** WB2-012: the Rows API through the real routes against a real database. */
const base = loadEnv();
const hasDatabase = Boolean(base.DATABASE_URL);
const URL_BASE = "/api/v1/workbooks-v2";
const MISSING = "00000000-0000-4000-8000-0000000000ff";
const { workbooks, workbookColumns, workbookRows, workbookCells, entitlements, auditLogs } = schema;

interface Cell {
  value: unknown;
  state: string;
  confidence: number | null;
  creditsCharged: number;
  foundVia: string | null;
  errorCode: string | null;
  updatedAt: string;
}
interface Row {
  id: number;
  position: number;
  index: number;
  source: { type: string } & Record<string, unknown>;
  prospectId: string | null;
  crmRef: unknown;
  suppressed: boolean;
  cells: Record<string, Cell>;
}

describe.skipIf(!hasDatabase)("Workbooks V2 rows routes", () => {
  const { db, sql } = createDb(base.DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  let n = 0;
  let app: Awaited<ReturnType<typeof buildApp>>;

  interface User {
    email: string;
    userId: string;
    workspaceId: string;
    ip: string;
    headers: Record<string, string>;
  }

  async function user(opts: { flag?: boolean } = {}): Promise<User> {
    n += 1;
    const email = `wb2-rows-${suffix}-${n}@test.com`;
    const ip = `11.${Math.floor(n / 250)}.${n % 250}.7`;
    await app.inject({ method: "GET", url: "/api/v1/me", headers: { "x-stub-user-email": email }, remoteAddress: ip });
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u!.id));
    await db.update(schema.workspaces).set({ accessStatus: "active" }).where(eq(schema.workspaces.id, m!.workspaceId));
    if (opts.flag !== false) await setEntitlement(m!.workspaceId, "feature.workbooks_v2", true);
    return { email, userId: u!.id, workspaceId: m!.workspaceId, ip, headers: { "x-stub-user-email": email } };
  }

  async function setEntitlement(workspaceId: string, key: string, value: unknown) {
    await db
      .insert(entitlements)
      .values({ workspaceId, key, value, source: "test" })
      .onConflictDoUpdate({ target: [entitlements.workspaceId, entitlements.key], set: { value } });
    invalidateWorkspaceAccess(workspaceId);
  }

  /** A second person in `owner`'s workspace holding only these permissions. */
  async function colleague(owner: User, permissions: string[]): Promise<User> {
    const other = await user();
    await db.insert(schema.workspaceMembers).values({ workspaceId: owner.workspaceId, userId: other.userId, role: "member" });
    await db.delete(schema.workspaceMemberRoles).where(and(eq(schema.workspaceMemberRoles.workspaceId, owner.workspaceId), eq(schema.workspaceMemberRoles.userId, other.userId)));
    const key = `rows-${suffix}-${++n}`;
    const [role] = await db.insert(schema.roles).values({ workspaceId: owner.workspaceId, key, name: key, description: "test", isSystem: false }).returning();
    if (permissions.length) await db.insert(schema.rolePermissions).values(permissions.map((permissionKey) => ({ roleId: role!.id, permissionKey })));
    await db.insert(schema.workspaceMemberRoles).values({ workspaceId: owner.workspaceId, userId: other.userId, roleId: role!.id });
    return { ...other, workspaceId: owner.workspaceId, headers: { ...other.headers, "x-workspace-id": owner.workspaceId } };
  }

  type Method = "GET" | "POST" | "PATCH" | "DELETE";
  const call = (u: User, method: Method, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url: `${URL_BASE}${path}`,
      remoteAddress: u.ip,
      headers: { ...u.headers, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { payload: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });

  const COLUMNS = [
    { key: "name", type: "input", dataType: "text" },
    { key: "employees", type: "input", dataType: "number" },
    { key: "email", type: "input", dataType: "email" },
    { key: "founded", type: "input", dataType: "date" },
    { key: "active", type: "input", dataType: "checkbox" },
    { key: "work", type: "enrichment" },
    { key: "ai", type: "ai" },
    { key: "formula", type: "formula" },
    { key: "action", type: "action" },
  ] as const;
  type Key = (typeof COLUMNS)[number]["key"];

  interface Book {
    id: string;
    col: Record<Key, string>;
  }

  /** An empty workbook with one column of every type. */
  async function book(u: User): Promise<Book> {
    const res = await call(u, "POST", "", { name: "Rows" });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().data.id as string;
    const col = Object.fromEntries(COLUMNS.map((c) => [c.key, randomUUID()])) as Record<Key, string>;
    await db.insert(workbookColumns).values(COLUMNS.map((c, position) => ({ id: col[c.key], workbookId: id, name: c.key, type: c.type, position, config: "dataType" in c ? { dataType: c.dataType } : {} })));
    return { id, col };
  }

  const cellsOf = (b: Book, values: Partial<Record<Key, unknown>>) => Object.fromEntries(Object.entries(values).map(([k, v]) => [b.col[k as Key], v]));

  async function add(u: User, b: Book, rows: Array<Partial<Record<Key, unknown>> & { source?: { type: string } }>) {
    const res = await call(u, "POST", `/${b.id}/rows/bulk`, { rows: rows.map(({ source, ...values }) => ({ cells: cellsOf(b, values), ...(source ? { source } : {}) })) });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json().data.rows as Array<{ id: number }>).map((r) => r.id);
  }

  /** A cell the server wrote (enrichment results are not client-writable). */
  async function serverCell(b: Book, rowId: number, key: Key, fields: Partial<typeof workbookCells.$inferInsert>) {
    await db.insert(workbookCells).values({ workbookId: b.id, rowId, columnId: b.col[key], state: "found", ...fields });
  }

  async function query(u: User, b: Book, body: Record<string, unknown> = {}) {
    const res = await call(u, "POST", `/${b.id}/rows/query`, body);
    expect(res.statusCode, `${JSON.stringify(body)} ${res.body}`).toBe(200);
    return res.json() as { data: Row[]; window: { offset: number; limit: number; returned: number; matched: number; total: number; hasMore: boolean; nextOffset: number | null } };
  }

  const storedRows = (b: Book) => db.select().from(workbookRows).where(eq(workbookRows.workbookId, b.id)).orderBy(asc(workbookRows.position));
  const storedCells = (b: Book) => db.select().from(workbookCells).where(eq(workbookCells.workbookId, b.id));
  const storedWorkbook = async (b: Book) => (await db.select().from(workbooks).where(eq(workbooks.id, b.id)))[0]!;
  /** Everything about a workbook's rows, to show a refused request changed nothing. */
  const snapshot = async (b: Book) => ({
    workbook: await storedWorkbook(b),
    rows: await storedRows(b),
    cells: (await storedCells(b)).sort((a, z) => a.rowId - z.rowId || a.columnId.localeCompare(z.columnId)),
  });

  beforeAll(async () => {
    app = await buildApp({ ...base, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, EARLY_ACCESS_GATE_ENABLED: "true", RATE_LIMIT_MAX: 10_000, PLATFORM_ADMIN_EMAILS: [] });
  });
  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  // ── Add ─────────────────────────────────────────────────────────────────────

  describe("POST /rows (one row)", () => {
    it("adds a row with its values, source and CRM reference, and updates the count and timestamp", async () => {
      const u = await user();
      const b = await book(u);
      const before = await storedWorkbook(b);
      const res = await call(u, "POST", `/${b.id}/rows`, {
        cells: cellsOf(b, { name: "Acme", employees: "250", active: "yes" }),
        source: { type: "hubspot", listId: "42" },
        crmRef: { provider: "hubspot", id: "901" },
      });
      expect(res.statusCode, res.body).toBe(201);
      const { data, rowCount } = res.json();
      expect(rowCount).toBe(1);
      expect(data).toMatchObject({ position: 0, source: { type: "hubspot", listId: "42" }, crmRef: { provider: "hubspot", id: "901" }, suppressed: false, prospectId: null });
      expect(Object.keys(data.cells).sort()).toEqual([b.col.name, b.col.employees, b.col.active].sort()); // empty columns have no cell
      expect(data.cells[b.col.name]).toMatchObject({ value: "Acme", state: "found", errorCode: null, creditsCharged: 0, confidence: null, foundVia: null });
      expect(data.cells[b.col.employees].value).toBe(250);
      expect(data.cells[b.col.active].value).toBe(true);
      const after = await storedWorkbook(b);
      expect(after.rowCount).toBe(1);
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
      expect(await storedRows(b)).toHaveLength(1);
      expect(await storedCells(b)).toHaveLength(3);
    });

    it("adds an empty row, marked manual, after the last one", async () => {
      const u = await user();
      const b = await book(u);
      await add(u, b, [{ name: "a" }, { name: "b" }]);
      const res = await call(u, "POST", `/${b.id}/rows`, {});
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({ rowCount: 3, data: { position: 2, source: { type: "manual" }, cells: {} } });
    });

    it("returns text that looks like JSON exactly as typed", async () => {
      const u = await user();
      const b = await book(u);
      for (const text of ["123", "true", "null", "1e5", '{"a":1}', "[1]", '"quoted"']) {
        const res = await call(u, "POST", `/${b.id}/rows`, { cells: cellsOf(b, { name: text }) });
        expect(res.json().data.cells[b.col.name].value, text).toBe(text);
      }
    });

    it("keeps a value that does not fit its column and flags it", async () => {
      const u = await user();
      const b = await book(u);
      const res = await call(u, "POST", `/${b.id}/rows/bulk`, { rows: [{ cells: cellsOf(b, { email: "nope", employees: "many" }) }] });
      expect(res.statusCode, res.body).toBe(201);
      const rowId = res.json().data.rows[0].id;
      expect(res.json().data.invalidCells.sort((x: { errorCode: string }, y: { errorCode: string }) => x.errorCode.localeCompare(y.errorCode))).toEqual([
        { rowId, columnId: b.col.email, errorCode: "invalid_email" },
        { rowId, columnId: b.col.employees, errorCode: "invalid_number" },
      ]);
      const [row] = (await query(u, b)).data;
      expect(row!.cells[b.col.email]).toMatchObject({ value: "nope", state: "error", errorCode: "invalid_email" });
    });

    it("applies an Idempotency-Key once", async () => {
      const u = await user();
      const b = await book(u);
      const key = { "idempotency-key": randomUUID() };
      const first = await call(u, "POST", `/${b.id}/rows`, { cells: cellsOf(b, { name: "once" }) }, key);
      const again = await call(u, "POST", `/${b.id}/rows`, { cells: cellsOf(b, { name: "once" }) }, key);
      expect(first.statusCode).toBe(201);
      expect(again.statusCode).toBe(201);
      expect(again.json().data.id).toBe(first.json().data.id);
      expect(await storedRows(b)).toHaveLength(1);

      const bulkKey = { "idempotency-key": randomUUID() };
      const rows = { rows: [{}, {}] };
      const one = await call(u, "POST", `/${b.id}/rows/bulk`, rows, bulkKey);
      const two = await call(u, "POST", `/${b.id}/rows/bulk`, rows, bulkKey);
      expect(two.json()).toEqual(one.json());
      expect((await storedWorkbook(b)).rowCount).toBe(3);
      expect(await storedRows(b)).toHaveLength(3);
    });
  });

  describe("POST /rows/bulk", () => {
    it("adds rows in the order sent with consecutive positions", async () => {
      const u = await user();
      const b = await book(u);
      await add(u, b, [{ name: "first" }]);
      const res = await call(u, "POST", `/${b.id}/rows/bulk`, { rows: ["x", "y", "z"].map((name) => ({ cells: cellsOf(b, { name }), source: { type: "csv" } })) });
      expect(res.statusCode).toBe(201);
      expect(res.json().data).toMatchObject({ added: 3, rowCount: 4, invalidCells: [] });
      expect(res.json().data.rows.map((r: { position: number }) => r.position)).toEqual([1, 2, 3]);
      const { data } = await query(u, b);
      expect(data.map((r) => r.cells[b.col.name]!.value)).toEqual(["first", "x", "y", "z"]);
      expect(data.slice(1).map((r) => r.id)).toEqual(res.json().data.rows.map((r: { id: number }) => r.id));
    });

    it("takes 1,000 rows with more cells than one insert statement carries", async () => {
      const u = await user();
      const b = await book(u);
      const rows = Array.from({ length: 1_000 }, (_, i) => ({ cells: cellsOf(b, { name: `n${i}`, employees: i, email: `p${i}@example.com`, founded: "2020-01-01", active: i % 2 === 0 }) }));
      const res = await call(u, "POST", `/${b.id}/rows/bulk`, { rows });
      expect(res.statusCode, res.body.slice(0, 500)).toBe(201);
      expect(res.json().data).toMatchObject({ added: 1_000, rowCount: 1_000 });
      expect(await storedCells(b)).toHaveLength(5_000);
      const last = await query(u, b, { offset: 999 });
      expect(last.data[0]!.cells[b.col.name]!.value).toBe("n999");
    });

    it("writes nothing when one row in the batch is bad, and says which", async () => {
      const u = await user();
      const b = await book(u);
      await add(u, b, [{ name: "kept" }]);
      const before = await snapshot(b);
      const res = await call(u, "POST", `/${b.id}/rows/bulk`, {
        rows: [{ cells: cellsOf(b, { name: "fine" }) }, { cells: cellsOf(b, { work: "x" }) }, { cells: { [MISSING]: "x" } }, { cells: cellsOf(b, { name: { not: "scalar" } }) }],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: "NOT_AN_INPUT_COLUMN", details: { errorCount: 3 } });
      expect(res.json().details.errors.map((e: { row: number; code: string }) => [e.row, e.code])).toEqual([
        [1, "NOT_AN_INPUT_COLUMN"],
        [2, "UNKNOWN_COLUMN"],
        [3, "INVALID_CELL_VALUE"],
      ]);
      expect(await snapshot(b)).toEqual(before);
    });

    it("rolls everything back when the database refuses part of the write", async () => {
      const u = await user();
      const b = await book(u);
      const name = `wb2_rows_boom_${suffix}`;
      await sql.unsafe(`create function ${name}() returns trigger language plpgsql as $$ begin if new.workbook_id = '${b.id}' then raise exception 'boom'; end if; return new; end $$`);
      await sql.unsafe(`create trigger ${name} before insert on workbook_cells for each row execute function ${name}()`);
      try {
        const before = await snapshot(b);
        const res = await call(u, "POST", `/${b.id}/rows/bulk`, { rows: [{ cells: cellsOf(b, { name: "x" }) }, {}] });
        expect(res.statusCode).toBe(500);
        expect(await snapshot(b)).toEqual(before); // the rows inserted before the cells are gone too
      } finally {
        await sql.unsafe(`drop trigger ${name} on workbook_cells`);
        await sql.unsafe(`drop function ${name}()`);
      }
    });

    it("takes a bulk body over the global 1 MB limit, up to 5 MB", async () => {
      const u = await user();
      const b = await book(u);
      const body = (count: number) => ({ rows: Array.from({ length: count }, () => ({ cells: cellsOf(b, { name: "x".repeat(10_000) }) })) });
      expect((await call(u, "POST", `/${b.id}/rows/bulk`, body(200))).statusCode).toBe(201); // about 2 MB
      const tooBig = await call(u, "POST", `/${b.id}/rows/bulk`, body(600)); // about 6 MB
      expect(tooBig.statusCode, tooBig.body.slice(0, 200)).toBe(413);
      expect((await storedWorkbook(b)).rowCount).toBe(200);
    });

    it("refuses the same column sent twice under different letter case", async () => {
      const u = await user();
      const b = await book(u);
      const res = await call(u, "POST", `/${b.id}/rows`, { cells: { [b.col.name]: "a", [b.col.name.toUpperCase()]: "b" } });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().code).toBe("INVALID_CELL_VALUE");
      expect(await storedRows(b)).toHaveLength(0);
    });

    it("refuses server-owned fields and malformed payloads", async () => {
      const u = await user();
      const b = await book(u);
      const bad: unknown[] = [
        {},
        { rows: [] },
        { rows: Array.from({ length: 1_001 }, () => ({})) },
        { rows: [{ position: 5 }] },
        { rows: [{ id: 5 }] },
        { rows: [{ suppressed: true }] },
        { rows: [{ prospectId: "p" }] },
        { rows: [{ workspaceId: u.workspaceId }] },
        { rows: [{ cells: [] }] },
        { rows: [{ cells: { "not-a-uuid": 1 } }] },
        { rows: [{ source: { file: "x" } }] },
        { rows: [{ source: { type: "Bad Type" } }] },
        { rows: [{ source: { type: "csv", nested: {} } }] },
        { rows: [{ source: { type: "csv", file: "a\u0000" } }] },
        { rows: [{ crmRef: { provider: "hubspot" } }] },
        { rows: [{ crmRef: { provider: "hubspot", id: "1", token: "x" } }] },
        { rows: [{}], workspaceId: u.workspaceId },
      ];
      for (const body of bad) {
        const res = await call(u, "POST", `/${b.id}/rows/bulk`, body);
        expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(422);
        expect(res.json().code).toBe("VALIDATION_FAILED");
      }
      expect((await call(u, "POST", `/${b.id}/rows`, "{not json")).statusCode).toBe(400);
      expect(await storedRows(b)).toHaveLength(0);
    });
  });

  describe("row limit", () => {
    it("allows exactly the limit, refuses one more, and writes nothing", async () => {
      const u = await user();
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 3);
      const b = await book(u);
      await add(u, b, [{ name: "1" }, { name: "2" }]);
      const before = await snapshot(b);
      const tooMany = await call(u, "POST", `/${b.id}/rows/bulk`, { rows: [{}, {}] });
      expect(tooMany.statusCode).toBe(422);
      expect(tooMany.json()).toMatchObject({ code: "ROW_LIMIT_EXCEEDED", details: { limit: 3, rows: 2, adding: 2 } });
      expect(await snapshot(b)).toEqual(before);
      expect((await call(u, "POST", `/${b.id}/rows`, {})).statusCode).toBe(201);
      const over = await call(u, "POST", `/${b.id}/rows`, {});
      expect(over.statusCode).toBe(422);
      expect(over.json().code).toBe("ROW_LIMIT_EXCEEDED");
      expect((await storedWorkbook(b)).rowCount).toBe(3);
    });

    it("counts the rows that exist, not the stored counter", async () => {
      const u = await user();
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 2);
      const b = await book(u);
      await add(u, b, [{}, {}]);
      await db.update(workbooks).set({ rowCount: 0 }).where(eq(workbooks.id, b.id));
      expect((await call(u, "POST", `/${b.id}/rows`, {})).statusCode).toBe(422);
    });

    it("follows a limit changed after the workbook was created, and frees room when rows are deleted", async () => {
      const u = await user();
      const b = await book(u);
      const [id] = await add(u, b, [{}]);
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 1);
      expect((await call(u, "POST", `/${b.id}/rows`, {})).statusCode).toBe(422);
      expect((await call(u, "DELETE", `/${b.id}/rows/${id}`)).statusCode).toBe(200);
      expect((await call(u, "POST", `/${b.id}/rows`, {})).statusCode).toBe(201);
    });

    it("holds under parallel inserts: unique positions, a true count and never past the limit", async () => {
      const u = await user();
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 25);
      const b = await book(u);
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => call(u, "POST", `/${b.id}/rows/bulk`, { rows: [0, 1, 2].map((j) => ({ cells: cellsOf(b, { name: `${i}-${j}` }) })) })));
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([...Array<number>(8).fill(201), ...Array<number>(4).fill(422)]);
      const rows = await storedRows(b);
      expect(rows).toHaveLength(24);
      expect(rows.map((r) => r.position)).toEqual(Array.from({ length: 24 }, (_, i) => i));
      expect((await storedWorkbook(b)).rowCount).toBe(24);
      expect(await storedCells(b)).toHaveLength(24);
    });
  });

  // ── Edit ────────────────────────────────────────────────────────────────────

  describe("PATCH /rows/:rowId", () => {
    it("sets, replaces and clears input cells, moving the timestamps", async () => {
      const u = await user();
      const b = await book(u);
      const [id, other] = await add(u, b, [{ name: "old", employees: 5 }, { name: "other" }]);
      const before = await snapshot(b);
      const res = await call(u, "PATCH", `/${b.id}/rows/${id}`, { cells: cellsOf(b, { name: "new", employees: null, email: "a@example.com" }) });
      expect(res.statusCode, res.body).toBe(200);
      const { data } = res.json();
      expect(data).toMatchObject({ id, position: 0 });
      expect(Object.keys(data.cells).sort()).toEqual([b.col.name, b.col.email].sort());
      expect(data.cells[b.col.name].value).toBe("new");
      const cells = await storedCells(b);
      expect(cells.filter((c) => c.rowId === id).map((c) => c.value).sort()).toEqual(["a@example.com", "new"]);
      expect(cells.filter((c) => c.rowId === other)).toEqual(before.cells.filter((c) => c.rowId === other));
      const was = before.cells.find((c) => c.rowId === id && c.columnId === b.col.name)!;
      expect(cells.find((c) => c.rowId === id && c.columnId === b.col.name)!.updatedAt.getTime()).toBeGreaterThan(was.updatedAt.getTime());
      expect((await storedWorkbook(b)).updatedAt.getTime()).toBeGreaterThan(before.workbook.updatedAt.getTime());
      expect((await storedWorkbook(b)).rowCount).toBe(2);
    });

    it("clears the flag and every earlier result field when a cell is rewritten", async () => {
      const u = await user();
      const b = await book(u);
      const [id] = await add(u, b, [{ email: "bad" }]);
      await db
        .update(workbookCells)
        .set({ confidence: 0.4, creditsCharged: 3, foundVia: "skout", internalProvenance: { provider: "p" } })
        .where(and(eq(workbookCells.workbookId, b.id), eq(workbookCells.rowId, id!)));
      const res = await call(u, "PATCH", `/${b.id}/rows/${id}`, { cells: cellsOf(b, { email: "good@example.com" }) });
      expect(res.json().data.cells[b.col.email]).toMatchObject({ value: "good@example.com", state: "found", errorCode: null, confidence: null, creditsCharged: 0, foundVia: null });
      expect((await storedCells(b))[0]!.internalProvenance).toBeNull();
      const flagged = await call(u, "PATCH", `/${b.id}/rows/${id}`, { cells: cellsOf(b, { email: "bad again" }) });
      expect(flagged.json().data.cells[b.col.email]).toMatchObject({ value: "bad again", state: "error", errorCode: "invalid_email" });
    });

    it("refuses enrichment, AI, formula and action cells, and writes none of the request", async () => {
      const u = await user();
      const b = await book(u);
      const [id] = await add(u, b, [{ name: "n" }]);
      await serverCell(b, id!, "work", { value: "found@example.com" });
      const before = await snapshot(b);
      for (const key of ["work", "ai", "formula", "action"] as const) {
        for (const value of ["overwritten", null]) {
          const res = await call(u, "PATCH", `/${b.id}/rows/${id}`, { cells: cellsOf(b, { name: "changed", [key]: value }) });
          expect(res.statusCode, `${key} ${value}`).toBe(422);
          expect(res.json()).toMatchObject({ code: "NOT_AN_INPUT_COLUMN", details: { errors: [{ columnId: b.col[key] }] } });
        }
      }
      expect(await snapshot(b)).toEqual(before);
    });

    it("refuses a column or row of another workbook, even in the same workspace", async () => {
      const u = await user();
      const b = await book(u);
      const second = await book(u);
      const [id] = await add(u, b, [{ name: "mine" }]);
      const [foreign] = await add(u, second, [{ name: "theirs" }]);
      const before = [await snapshot(b), await snapshot(second)];
      const column = await call(u, "PATCH", `/${b.id}/rows/${id}`, { cells: cellsOf(second, { name: "x" }) });
      expect(column.statusCode).toBe(422);
      expect(column.json().code).toBe("UNKNOWN_COLUMN");
      const row = await call(u, "PATCH", `/${b.id}/rows/${foreign}`, { cells: cellsOf(b, { name: "x" }) });
      expect(row.statusCode).toBe(404);
      expect([await snapshot(b), await snapshot(second)]).toEqual(before);
    });

    it("validates the row id and the payload", async () => {
      const u = await user();
      const b = await book(u);
      const [id] = await add(u, b, [{ name: "n" }]);
      for (const path of ["abc", "0", "-1", "1.5", "1e3", "99999999999999999"]) {
        expect((await call(u, "PATCH", `/${b.id}/rows/${path}`, { cells: cellsOf(b, { name: "x" }) })).statusCode, path).toBe(422);
      }
      for (const body of [{}, { cells: {} }, { cells: cellsOf(b, { name: "x" }), position: 4 }, { cells: cellsOf(b, { name: "x" }), source: { type: "csv" } }]) {
        expect((await call(u, "PATCH", `/${b.id}/rows/${id}`, body)).statusCode, JSON.stringify(body)).toBe(422);
      }
      for (const value of [{ a: 1 }, [1], "x".repeat(10_001), "a\u0000"]) {
        const res = await call(u, "PATCH", `/${b.id}/rows/${id}`, { cells: cellsOf(b, { name: value }) });
        expect(res.statusCode).toBe(422);
        expect(res.json().code).toBe("INVALID_CELL_VALUE");
      }
      expect((await call(u, "PATCH", `/not-a-uuid/rows/${id}`, { cells: cellsOf(b, { name: "x" }) })).statusCode).toBe(422);
      expect((await call(u, "PATCH", `/${b.id}/rows/999999999`, { cells: cellsOf(b, { name: "x" }) })).statusCode).toBe(404);
      expect((await storedCells(b)).map((c) => c.value)).toEqual(["n"]);
    });
  });

  // ── Delete ──────────────────────────────────────────────────────────────────

  describe("deleting rows", () => {
    it("deletes one row and its cells; the others keep their order and the count is true", async () => {
      const u = await user();
      const b = await book(u);
      const ids = await add(u, b, ["a", "b", "c"].map((name) => ({ name, employees: 1 })));
      const before = await storedWorkbook(b);
      const res = await call(u, "DELETE", `/${b.id}/rows/${ids[1]}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toEqual({ deleted: 1, rowCount: 2 });
      expect((await storedCells(b)).filter((c) => c.rowId === ids[1])).toEqual([]);
      expect(await storedCells(b)).toHaveLength(4);
      const after = await query(u, b);
      expect(after.data.map((r) => [r.cells[b.col.name]!.value, r.position, r.index])).toEqual([
        ["a", 0, 0],
        ["c", 2, 1], // positions are an order key; the gap is not renumbered
      ]);
      expect(after.window).toMatchObject({ total: 2, matched: 2 });
      expect((await storedWorkbook(b)).rowCount).toBe(2);
      expect((await storedWorkbook(b)).updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
      expect((await call(u, "DELETE", `/${b.id}/rows/${ids[1]}`)).statusCode).toBe(404);
    });

    it("deletes many rows at once, counting a repeated id once, and appends after the last remaining row", async () => {
      const u = await user();
      const b = await book(u);
      const ids = await add(u, b, Array.from({ length: 10 }, (_, i) => ({ name: `r${i}` })));
      const gone = [ids[0]!, ids[3]!, ids[9]!];
      const res = await call(u, "POST", `/${b.id}/rows/delete`, { rowIds: [...gone, ids[3]] });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toEqual({ deleted: 3, rowCount: 7 });
      expect((await storedCells(b)).filter((c) => gone.includes(c.rowId))).toEqual([]);
      await add(u, b, [{ name: "next" }]);
      const { data } = await query(u, b);
      expect(data.map((r) => r.cells[b.col.name]!.value)).toEqual(["r1", "r2", "r4", "r5", "r6", "r7", "r8", "next"]);
      expect(new Set(data.map((r) => r.position)).size).toBe(8);
    });

    it("audits each delete that happens, with ids and counts but no cell values", async () => {
      const u = await user();
      const b = await book(u);
      const ids = await add(u, b, [{ name: "very-private-value" }, {}, {}]);
      const audited = () => db.select().from(auditLogs).where(and(eq(auditLogs.workspaceId, u.workspaceId), eq(auditLogs.action, "workbook.rows.delete")));
      await call(u, "POST", `/${b.id}/rows/delete`, { rowIds: [ids[0], 999999999] }); // refused: nothing to record
      expect(await audited()).toEqual([]);
      expect((await call(u, "POST", `/${b.id}/rows/delete`, { rowIds: [ids[0], ids[1]] })).statusCode).toBe(200);
      const entries = await audited();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ actorId: u.userId, entityType: "workbook", entityId: b.id });
      expect(entries[0]!.afterState).toEqual({ deleted: 2, rowCount: 1, rowIds: [ids[0], ids[1]] });
      expect(JSON.stringify(entries[0])).not.toContain("very-private-value");
    });

    it("leaves no cell without a row", async () => {
      const u = await user();
      const b = await book(u);
      const ids = await add(u, b, [{ name: "a" }, { name: "b" }]);
      await call(u, "POST", `/${b.id}/rows/delete`, { rowIds: ids });
      const [orphans] = await sql`select count(*)::int as n from workbook_cells c where c.workbook_id = ${b.id} and not exists (select 1 from workbook_rows r where r.workbook_id = c.workbook_id and r.id = c.row_id)`;
      expect(orphans!.n).toBe(0);
      expect(await storedCells(b)).toEqual([]);
      expect((await storedWorkbook(b)).rowCount).toBe(0);
    });

    it("deletes nothing when any id is unknown or belongs to another workbook", async () => {
      const u = await user();
      const b = await book(u);
      const second = await book(u);
      const [mine] = await add(u, b, [{ name: "mine" }]);
      const [foreign] = await add(u, second, [{ name: "foreign" }]);
      const before = [await snapshot(b), await snapshot(second)];
      const res = await call(u, "POST", `/${b.id}/rows/delete`, { rowIds: [mine, foreign, 999999999] });
      expect(res.statusCode).toBe(404);
      expect(res.json().details).toEqual({ missingRowIds: [foreign, 999999999], missingCount: 2 });
      expect((await call(u, "DELETE", `/${b.id}/rows/${foreign}`)).statusCode).toBe(404);
      expect([await snapshot(b), await snapshot(second)]).toEqual(before);
    });

    it("validates the id list", async () => {
      const u = await user();
      const b = await book(u);
      for (const body of [{}, { rowIds: [] }, { rowIds: ["1"] }, { rowIds: [0] }, { rowIds: [1.5] }, { rowIds: Array.from({ length: 10_001 }, (_, i) => i + 1) }, { rowIds: [1], all: true }]) {
        expect((await call(u, "POST", `/${b.id}/rows/delete`, body)).statusCode, JSON.stringify(body).slice(0, 60)).toBe(422);
      }
    });

    it("keeps the count true when deletes and inserts run together", async () => {
      const u = await user();
      const b = await book(u);
      const ids = await add(u, b, Array.from({ length: 20 }, () => ({})));
      const results = await Promise.all([
        ...ids.slice(0, 10).map((id) => call(u, "DELETE", `/${b.id}/rows/${id}`)),
        ...Array.from({ length: 10 }, () => call(u, "POST", `/${b.id}/rows`, {})),
      ]);
      expect(results.map((r) => r.statusCode).filter((s) => s >= 300)).toEqual([]);
      const rows = await storedRows(b);
      expect(rows).toHaveLength(20);
      expect(new Set(rows.map((r) => r.position)).size).toBe(20);
      expect((await storedWorkbook(b)).rowCount).toBe(20);
    });
  });

  // ── Window ──────────────────────────────────────────────────────────────────

  describe("GET /rows (window)", () => {
    let u: User;
    let b: Book;
    let ids: number[];
    beforeAll(async () => {
      u = await user();
      b = await book(u);
      ids = await add(u, b, Array.from({ length: 450 }, (_, i) => ({ name: `row-${i}`, employees: i })));
    });
    const get = (path = "") => call(u, "GET", `/${b.id}/rows${path}`);

    it("returns 200 rows by default with what a grid needs to load more", async () => {
      const res = await get();
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
      const body = res.json();
      expect(body.window).toEqual({ offset: 0, limit: 200, returned: 200, matched: 450, total: 450, hasMore: true, nextOffset: 200 });
      expect(body.data.map((r: Row) => r.id)).toEqual(ids.slice(0, 200));
      expect(body.data[0]).toMatchObject({ index: 0, position: 0 });
    });

    it("pages through the workbook without overlap or gaps", async () => {
      const seen: number[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const body: { data: Row[]; window: { nextOffset: number | null } } = (await get(`?offset=${offset}&limit=200`)).json();
        seen.push(...body.data.map((r) => r.id));
        offset = body.window.nextOffset;
      }
      expect(seen).toEqual(ids);
    });

    it("returns the last partial window, and an empty one at or past the end", async () => {
      expect((await get("?offset=400")).json().window).toEqual({ offset: 400, limit: 200, returned: 50, matched: 450, total: 450, hasMore: false, nextOffset: null });
      for (const offset of [450, 451, 1_000_000]) {
        const body = (await get(`?offset=${offset}`)).json();
        expect(body.data).toEqual([]);
        expect(body.window).toEqual({ offset, limit: 200, returned: 0, matched: 450, total: 450, hasMore: false, nextOffset: null });
      }
    });

    it("returns an empty window for a workbook with no rows", async () => {
      const empty = await book(u);
      const body = (await call(u, "GET", `/${empty.id}/rows`)).json();
      expect(body).toEqual({ data: [], window: { offset: 0, limit: 200, returned: 0, matched: 0, total: 0, hasMore: false, nextOffset: null } });
    });

    it("returns only the requested columns' cells", async () => {
      const one = (await get(`?limit=2&columnIds=${b.col.employees}`)).json();
      expect(one.data.map((r: Row) => Object.keys(r.cells))).toEqual([[b.col.employees], [b.col.employees]]);
      const upper = (await get(`?limit=1&columnIds=${b.col.name.toUpperCase()}`)).json();
      expect(Object.keys(upper.data[0].cells)).toEqual([b.col.name]);
      const none = (await get("?limit=1&columnIds=")).json();
      expect(none.data[0].cells).toEqual({});
      expect((await get(`?columnIds=${MISSING}`)).json()).toMatchObject({ code: "UNKNOWN_COLUMN" });
    });

    it("refuses bad window parameters, and sort or filter parameters it would ignore", async () => {
      for (const q of ["?limit=0", "?limit=501", "?limit=abc", "?offset=-1", "?offset=1.5", "?offset=10000001", "?columnIds=nope", "?sort=name", "?filter=x", "?search=x", "?workspaceId=" + u.workspaceId]) {
        expect((await get(q)).statusCode, q).toBe(422);
      }
    });
  });

  // ── Sort, filter, search ────────────────────────────────────────────────────

  describe("POST /rows/query", () => {
    let u: User;
    let b: Book;
    /** Row ids by label. */
    let id: Record<string, number>;
    const LABELS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];

    beforeAll(async () => {
      u = await user();
      b = await book(u);
      const ids = await add(u, b, [
        { name: "alpha", employees: 100, founded: "2019-05-01", active: true, email: "alpha@acme.io", source: { type: "csv" } },
        { name: "Bravo", employees: 9, founded: "2021-01-15", active: false, email: "not-an-email", source: { type: "hubspot" } },
        { name: "charlie", employees: 1000, founded: "2010-12-31", active: true, source: { type: "csv" } },
        { name: "delta", employees: "unknown", source: { type: "webhook" } },
        { employees: 50, founded: "2019-05-01", source: { type: "hubspot" } },
        { name: "foxtrot 100% _x_ \\ done", source: { type: "csv" } },
      ]);
      id = Object.fromEntries(LABELS.map((label, i) => [label, ids[i]!]));
      await serverCell(b, id.alpha!, "work", { value: "a@work.com", confidence: 0.9, creditsCharged: 2, foundVia: "skout", internalProvenance: { provider: "secret-managed-provider" } });
      await serverCell(b, id.bravo!, "work", { state: "error", errorCode: "provider_unavailable", internalProvenance: { provider: "secret-managed-provider" } });
      await serverCell(b, id.charlie!, "work", { state: "queued" });
      await serverCell(b, id.delta!, "work", { state: "not_found", value: null });
      await serverCell(b, id.echo!, "work", { value: "" });
      await serverCell(b, id.echo!, "ai", { state: "running" });
      await serverCell(b, id.foxtrot!, "ai", { value: { summary: "structured zanzibar" } });
    });

    const labels = async (body: Record<string, unknown>) => {
      const res = await query(u, b, body);
      const byId = new Map(Object.entries(id).map(([label, rowId]) => [rowId, label]));
      return res.data.map((r) => byId.get(r.id)!);
    };
    const value = (key: Key, op: string, v?: unknown) => ({ type: "value", columnId: b.col[key], op, ...(v === undefined ? {} : { value: v }) });
    const where = async (...filters: unknown[]) => (await labels({ filters })).sort();
    const sortBy = (key: Key, direction: "asc" | "desc" = "asc") => labels({ sort: [{ columnId: b.col[key], direction }] });

    it("sorts text without case splitting the alphabet, empty last in both directions", async () => {
      expect(await sortBy("name")).toEqual(["alpha", "bravo", "charlie", "delta", "foxtrot", "echo"]);
      expect(await sortBy("name", "desc")).toEqual(["foxtrot", "delta", "charlie", "bravo", "alpha", "echo"]);
    });

    it("sorts numbers as numbers, flagged text after them and empty last", async () => {
      expect(await sortBy("employees")).toEqual(["bravo", "echo", "alpha", "charlie", "delta", "foxtrot"]);
      expect(await sortBy("employees", "desc")).toEqual(["charlie", "alpha", "echo", "bravo", "delta", "foxtrot"]);
    });

    it("sorts dates and checkboxes, breaking ties by row order", async () => {
      expect(await sortBy("founded")).toEqual(["charlie", "alpha", "echo", "bravo", "delta", "foxtrot"]);
      expect(await sortBy("active", "desc")).toEqual(["alpha", "charlie", "bravo", "delta", "echo", "foxtrot"]);
    });

    it("sorts by an enrichment column, treating queued, failed, not found and blank as empty", async () => {
      expect(await sortBy("work", "desc")).toEqual(["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"]);
    });

    it("sorts by several keys and by row fields", async () => {
      expect(await labels({ sort: [{ columnId: b.col.founded, direction: "asc" }, { columnId: b.col.employees, direction: "asc" }] })).toEqual(["charlie", "echo", "alpha", "bravo", "delta", "foxtrot"]);
      expect(await labels({ sort: [{ field: "position", direction: "desc" }] })).toEqual([...LABELS].reverse());
      expect(await labels({ sort: [{ field: "source" }, { field: "position", direction: "desc" }] })).toEqual(["foxtrot", "charlie", "alpha", "echo", "bravo", "delta"]);
      expect(await labels({ sort: [{ field: "createdAt" }] })).toEqual(LABELS); // one batch, one timestamp: row order
    });

    it("filters by value", async () => {
      expect(await where(value("name", "equals", "BRAVO"))).toEqual(["bravo"]);
      expect(await where(value("name", "not_equals", "bravo"))).toEqual(["alpha", "charlie", "delta", "echo", "foxtrot"]);
      expect(await where(value("name", "contains", "LI"))).toEqual(["charlie"]);
      expect(await where(value("name", "not_contains", "a"))).toEqual(["echo", "foxtrot"]);
      expect(await where(value("name", "starts_with", "br"))).toEqual(["bravo"]);
      expect(await where(value("name", "in", ["alpha", "delta", "zulu"]))).toEqual(["alpha", "delta"]);
      expect(await where(value("employees", "equals", 9))).toEqual(["bravo"]);
      expect(await where(value("employees", "in", [9, 1000]))).toEqual(["bravo", "charlie"]);
      expect(await where(value("active", "equals", false))).toEqual(["bravo"]);
      expect(await where(value("active", "equals", true))).toEqual(["alpha", "charlie"]);
    });

    it("compares numbers and dates; text in a number column never matches a comparison", async () => {
      expect(await where(value("employees", "gt", 50))).toEqual(["alpha", "charlie"]);
      expect(await where(value("employees", "gte", 50))).toEqual(["alpha", "charlie", "echo"]);
      expect(await where(value("employees", "lt", 50))).toEqual(["bravo"]);
      expect(await where(value("employees", "lte", 50))).toEqual(["bravo", "echo"]);
      expect(await where(value("founded", "gt", "2019-05-01"))).toEqual(["bravo"]);
      expect(await where(value("founded", "lte", "2019-05-01"))).toEqual(["alpha", "charlie", "echo"]);
    });

    it("treats % _ and \\ as ordinary characters", async () => {
      expect(await where(value("name", "contains", "%"))).toEqual(["foxtrot"]);
      expect(await where(value("name", "contains", "_x_"))).toEqual(["foxtrot"]);
      expect(await where(value("name", "contains", "\\"))).toEqual(["foxtrot"]);
      expect(await where(value("name", "starts_with", "%"))).toEqual([]);
      expect(await labels({ search: "100%" })).toEqual(["foxtrot"]);
      expect(await labels({ search: "a_p" })).toEqual([]);
    });

    it("filters has value and is empty: missing, null, blank and unfinished cells are all empty", async () => {
      expect(await where(value("work", "has_value"))).toEqual(["alpha"]);
      expect(await where(value("work", "is_empty"))).toEqual(["bravo", "charlie", "delta", "echo", "foxtrot"]);
      expect(await where(value("name", "is_empty"))).toEqual(["echo"]);
      expect(await where(value("active", "has_value"))).toEqual(["alpha", "bravo", "charlie"]); // false is a value
    });

    it("filters by cell state, for one column or any", async () => {
      const state = (states: string[], key?: Key) => ({ type: "state", states, ...(key ? { columnId: b.col[key] } : {}) });
      expect(await where(state(["queued"], "work"))).toEqual(["charlie"]);
      expect(await where(state(["error", "not_found"], "work"))).toEqual(["bravo", "delta"]);
      expect(await where(state(["error"], "email"))).toEqual(["bravo"]);
      expect(await where(state(["running"]))).toEqual(["echo"]);
      expect(await where(state(["error"]))).toEqual(["bravo", "delta"]); // delta's flagged number, bravo's two errors: each row once
      expect(await where(state(["needs_input"]))).toEqual([]);
    });

    it("filters by row source", async () => {
      expect(await where({ type: "source", sources: ["hubspot"] })).toEqual(["bravo", "echo"]);
      expect(await where({ type: "source", sources: ["hubspot", "webhook"] })).toEqual(["bravo", "delta", "echo"]);
      expect(await where({ type: "source", sources: ["salesforce"] })).toEqual([]);
    });

    it("combines filters, search and sort", async () => {
      const body = {
        filters: [{ type: "source", sources: ["csv", "hubspot"] }, value("employees", "has_value")],
        search: "2019",
        sort: [{ columnId: b.col.employees, direction: "desc" }],
      };
      expect(await labels(body)).toEqual(["alpha", "echo"]);
      expect((await query(u, b, body)).window).toMatchObject({ matched: 2, total: 6 });
      // The same column filtered twice, and filtered and sorted.
      expect(await labels({ filters: [value("employees", "gt", 9), value("employees", "lt", 1000)], sort: [{ columnId: b.col.employees }] })).toEqual(["echo", "alpha"]);
    });

    it("searches every column's text and numbers, ignoring case, but not structured values", async () => {
      expect(await labels({ search: "ACME.IO" })).toEqual(["alpha"]);
      expect(await labels({ search: "work.com" })).toEqual(["alpha"]);
      expect(await labels({ search: "1000" })).toEqual(["charlie"]);
      expect(await labels({ search: "zanzibar" })).toEqual([]);
      expect(await labels({ search: "secret-managed-provider" })).toEqual([]); // provenance is not searchable
      expect(await labels({ search: "   " })).toEqual(LABELS);
      expect(await labels({ search: "" })).toEqual(LABELS);
    });

    it("does not depend on which columns are returned", async () => {
      const res = await query(u, b, { columnIds: [b.col.name], filters: [value("work", "has_value")], sort: [{ columnId: b.col.employees }], search: "acme" });
      expect(res.data.map((r) => r.id)).toEqual([id.alpha]);
      expect(Object.keys(res.data[0]!.cells)).toEqual([b.col.name]);
    });

    it("pages a filtered, sorted list and reports the match count even past its end", async () => {
      const body = { filters: [value("employees", "has_value")], sort: [{ columnId: b.col.employees }], limit: 2 };
      const first = await query(u, b, body);
      expect(first.window).toEqual({ offset: 0, limit: 2, returned: 2, matched: 5, total: 6, hasMore: true, nextOffset: 2 });
      expect(first.data.map((r) => r.index)).toEqual([0, 1]);
      const last = await query(u, b, { ...body, offset: 4 });
      expect(last.window).toEqual({ offset: 4, limit: 2, returned: 1, matched: 5, total: 6, hasMore: false, nextOffset: null });
      for (const offset of [5, 6, 100]) {
        const past = await query(u, b, { ...body, offset });
        expect(past.window, String(offset)).toEqual({ offset, limit: 2, returned: 0, matched: 5, total: 6, hasMore: false, nextOffset: null });
      }
      expect((await query(u, b, { search: "zzzz" })).window).toMatchObject({ returned: 0, matched: 0, total: 6 });
    });

    it("never returns internal provenance, from any rows endpoint", async () => {
      const bodies = [
        (await call(u, "GET", `/${b.id}/rows`)).body,
        (await call(u, "POST", `/${b.id}/rows/query`, { search: "work" })).body,
        (await call(u, "PATCH", `/${b.id}/rows/${id.alpha}`, { cells: cellsOf(b, { name: "alpha" }) })).body,
      ];
      for (const body of bodies) {
        expect(body).toContain("a@work.com");
        expect(body).not.toMatch(/secret-managed-provider|internalProvenance|internal_provenance/);
      }
    });

    it("refuses invalid filters, sorts and parameters", async () => {
      const c = b.col.name;
      const bad: unknown[] = [
        { filters: [{ type: "value", columnId: c, op: "matches", value: "x" }] },
        { filters: [{ type: "value", columnId: c, op: "equals" }] },
        { filters: [{ type: "value", columnId: c, op: "is_empty", value: "x" }] },
        { filters: [{ type: "value", columnId: c, op: "contains", value: 5 }] },
        { filters: [{ type: "value", columnId: c, op: "contains", value: "" }] },
        { filters: [{ type: "value", columnId: c, op: "equals", value: { a: 1 } }] },
        { filters: [{ type: "value", columnId: c, op: "equals", value: "a\u0000" }] },
        { filters: [{ type: "value", columnId: c, op: "in", value: [] }] },
        { filters: [{ type: "value", columnId: c, op: "gt", value: "abc" }] },
        { filters: [{ type: "value", columnId: "name", op: "equals", value: "x" }] },
        { filters: [{ type: "value", columnId: `${c}' OR '1'='1`, op: "equals", value: "x" }] },
        { filters: [{ type: "state", states: ["done"] }] },
        { filters: [{ type: "state", states: [] }] },
        { filters: [{ type: "source", sources: [] }] },
        { filters: [{ type: "source", sources: ["csv') --"] }] },
        { filters: [{ type: "provenance", value: "x" }] },
        { filters: Array.from({ length: 11 }, () => ({ type: "source", sources: ["csv"] })) },
        { sort: [{ columnId: "name; DROP TABLE workbook_rows" }] },
        { sort: [{ field: "id" }] },
        { sort: [{ field: "internal_provenance" }] },
        { sort: [{ columnId: c, direction: "asc; DROP TABLE workbooks" }] },
        { sort: [{ columnId: c, field: "position" }] },
        { sort: Array.from({ length: 4 }, () => ({ field: "position" })) },
        { sort: "name" },
        { search: "x".repeat(201) },
        { search: "a\u0000" },
        { search: 5 },
        { limit: 0 },
        { limit: 501 },
        { offset: -1 },
        { offset: 1.5 },
        { limit: "10" },
        { where: "1=1" },
        { workspaceId: u.workspaceId },
        [],
      ];
      for (const body of bad) {
        const res = await call(u, "POST", `/${b.id}/rows/query`, body);
        expect(res.statusCode, JSON.stringify(body).slice(0, 100)).toBe(422);
        expect(res.json().code).toBe("VALIDATION_FAILED");
      }
      for (const body of [{ sort: [{ columnId: MISSING }] }, { filters: [{ type: "value", columnId: MISSING, op: "is_empty" }] }, { filters: [{ type: "state", columnId: MISSING, states: ["found"] }] }, { columnIds: [MISSING] }]) {
        const res = await call(u, "POST", `/${b.id}/rows/query`, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(422);
        expect(res.json().code).toBe("UNKNOWN_COLUMN");
      }
    });

    it("binds hostile text as a value", async () => {
      const before = await snapshot(b);
      for (const hostile of ["'; DROP TABLE workbook_rows; --", "x' OR '1'='1", "$$; delete from workbooks; $$", "$1"]) {
        for (const body of [{ search: hostile }, { filters: [value("name", "equals", hostile)] }, { filters: [value("name", "contains", hostile)] }, { filters: [value("name", "in", [hostile])] }]) {
          expect((await query(u, b, body)).data, hostile).toEqual([]);
        }
      }
      expect(await snapshot(b)).toEqual(before);
    });

    it("works at every limit at once: 10 filters, 3 sort keys and a search", async () => {
      const res = await query(u, b, {
        filters: Array.from({ length: 10 }, () => value("name", "has_value")),
        sort: [{ columnId: b.col.name }, { columnId: b.col.employees }, { columnId: b.col.founded }],
        search: "a",
      });
      expect(res.window.matched).toBe(4);
    });

    it("sorts, filters and searches across all rows, not only the first window", async () => {
      const big = await book(u);
      await add(u, big, Array.from({ length: 600 }, (_, i) => ({ name: i === 577 ? "needle" : `hay-${i}`, employees: (i * 7919) % 600, source: { type: i >= 590 ? "webhook" : "csv" } })));
      const top = await query(u, big, { sort: [{ columnId: big.col.employees, direction: "desc" }], limit: 3 });
      expect(top.data.map((r) => r.cells[big.col.employees]!.value)).toEqual([599, 598, 597]);
      const needle = await query(u, big, { search: "needle" });
      expect(needle.data.map((r) => r.position)).toEqual([577]);
      expect((await query(u, big, { filters: [{ type: "source", sources: ["webhook"] }] })).data.map((r) => r.position)).toEqual(Array.from({ length: 10 }, (_, i) => 590 + i));
      const all: number[] = [];
      for (let offset = 0; offset < 600; offset += 250) all.push(...(await query(u, big, { sort: [{ columnId: big.col.employees }], offset, limit: 250 })).data.map((r) => r.cells[big.col.employees]!.value as number));
      expect(all).toEqual(Array.from({ length: 600 }, (_, i) => i));
    });
  });

  // ── Security ────────────────────────────────────────────────────────────────

  describe("access control", () => {
    /** Every rows endpoint, aimed at `target`'s ids. */
    const attempts = (b: Book, rowId: number): Array<[Method, string, unknown?]> => [
      ["GET", `/${b.id}/rows`],
      ["POST", `/${b.id}/rows/query`, {}],
      ["POST", `/${b.id}/rows`, { cells: cellsOf(b, { name: "x" }) }],
      ["POST", `/${b.id}/rows/bulk`, { rows: [{}] }],
      ["PATCH", `/${b.id}/rows/${rowId}`, { cells: cellsOf(b, { name: "x" }) }],
      ["DELETE", `/${b.id}/rows/${rowId}`],
      ["POST", `/${b.id}/rows/delete`, { rowIds: [rowId] }],
    ];

    async function victim() {
      const owner = await user();
      const b = await book(owner);
      const [rowId] = await add(owner, b, [{ name: "victim-secret" }]);
      return { owner, b, rowId: rowId! };
    }

    it("hides another workspace's workbook from every endpoint, whatever the client claims", async () => {
      const { owner, b, rowId } = await victim();
      const intruder = await user();
      const before = await snapshot(b);
      const claims: Array<Record<string, string>> = [{}, { "x-workspace-id": owner.workspaceId }];
      for (const headers of claims) {
        for (const [method, path, body] of attempts(b, rowId)) {
          const res = await call(intruder, method, path, body, headers);
          expect([403, 404], `${method} ${path} ${res.body}`).toContain(res.statusCode);
          if (!("x-workspace-id" in headers)) expect(res.statusCode).toBe(404);
          expect(res.body).not.toContain("victim-secret");
        }
      }
      expect(await snapshot(b)).toEqual(before);
    });

    it("cannot reach another workspace's rows or columns through the caller's own workbook", async () => {
      const { b, rowId } = await victim();
      const intruder = await user();
      const own = await book(intruder);
      const [ownRow] = await add(intruder, own, [{ name: "own" }]);
      const before = [await snapshot(b), await snapshot(own)];
      expect((await call(intruder, "PATCH", `/${own.id}/rows/${rowId}`, { cells: cellsOf(own, { name: "x" }) })).statusCode).toBe(404);
      expect((await call(intruder, "PATCH", `/${own.id}/rows/${ownRow}`, { cells: cellsOf(b, { name: "x" }) })).json().code).toBe("UNKNOWN_COLUMN");
      expect((await call(intruder, "DELETE", `/${own.id}/rows/${rowId}`)).statusCode).toBe(404);
      expect((await call(intruder, "POST", `/${own.id}/rows/delete`, { rowIds: [ownRow, rowId] })).statusCode).toBe(404);
      for (const body of [{ filters: [{ type: "value", columnId: b.col.name, op: "has_value" }] }, { sort: [{ columnId: b.col.name }] }, { columnIds: [b.col.name] }]) {
        expect((await call(intruder, "POST", `/${own.id}/rows/query`, body)).json().code).toBe("UNKNOWN_COLUMN");
      }
      expect((await query(intruder, own, { search: "victim-secret" })).window.matched).toBe(0);
      expect([await snapshot(b), await snapshot(own)]).toEqual(before);
    });

    it("treats a deleted or unknown workbook as not found", async () => {
      const { owner, b, rowId } = await victim();
      expect((await call(owner, "DELETE", `/${b.id}`)).statusCode).toBeLessThan(300);
      const before = await snapshot(b);
      for (const [method, path, body] of attempts(b, rowId)) expect((await call(owner, method, path, body)).statusCode, `${method} ${path}`).toBe(404);
      for (const [method, path, body] of attempts({ ...b, id: MISSING }, rowId)) expect((await call(owner, method, path, body)).statusCode, `${method} ${path}`).toBe(404);
      expect(await snapshot(b)).toEqual(before);
    });

    it("lets a view-only member read and nothing else, and a member without access nothing", async () => {
      const { owner, b, rowId } = await victim();
      const viewer = await colleague(owner, ["enrichment:read"]);
      const outsider = await colleague(owner, []);
      const before = await snapshot(b);
      for (const [method, path, body] of attempts(b, rowId)) {
        const reads = method === "GET" || path.endsWith("/query");
        expect((await call(viewer, method, path, body)).statusCode, `viewer ${method} ${path}`).toBe(reads ? 200 : 403);
        expect((await call(outsider, method, path, body)).statusCode, `outsider ${method} ${path}`).toBe(403);
      }
      expect(await snapshot(b)).toEqual(before);
    });

    it("does not replay a stored response to someone who has lost permission", async () => {
      const { owner, b } = await victim();
      const editor = await colleague(owner, ["enrichment:read", "enrichment:capture"]);
      const key = { "idempotency-key": randomUUID() };
      expect((await call(editor, "POST", `/${b.id}/rows`, {}, key)).statusCode).toBe(201);
      await db.delete(schema.workspaceMemberRoles).where(and(eq(schema.workspaceMemberRoles.workspaceId, owner.workspaceId), eq(schema.workspaceMemberRoles.userId, editor.userId)));
      invalidateWorkspaceAccess(owner.workspaceId);
      expect((await call(editor, "POST", `/${b.id}/rows`, {}, key)).statusCode).toBe(403);
    });

    it("is switched off unless the workspace has Workbooks V2", async () => {
      const { owner, b, rowId } = await victim();
      await setEntitlement(owner.workspaceId, "feature.workbooks_v2", false);
      const before = await snapshot(b);
      for (const [method, path, body] of attempts(b, rowId)) {
        const res = await call(owner, method, path, body);
        expect(res.statusCode, `${method} ${path} ${res.body}`).toBe(403);
        expect(res.body).not.toContain("victim-secret");
      }
      expect(await snapshot(b)).toEqual(before);
    });

    it("requires a signed-in user", async () => {
      const { b, rowId } = await victim();
      const anonymous = await buildApp({ ...base, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, CLERK_SECRET_KEY: "sk_test_unused", CLERK_JWT_ISSUER: "https://clerk.example.test" });
      try {
        for (const [method, path, body] of attempts(b, rowId)) {
          const res = await anonymous.inject({ method, url: `${URL_BASE}${path}`, ...(body ? { headers: { "content-type": "application/json" }, payload: JSON.stringify(body) } : {}) });
          expect(res.statusCode, `${method} ${path}`).toBe(401);
        }
      } finally {
        await anonymous.close();
      }
    });
  });
});
