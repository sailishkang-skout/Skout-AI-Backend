import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { and, asc, eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { invalidateWorkspaceAccess } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { withFailingCellInserts } from "../test/failing-cell-inserts.js";
import { importStorage } from "../services/workbook-import-storage.js";
import { runImportJob, sweepImports, type ImportJob, type ImportQueue } from "../services/workbook-import-runner.js";
import { MAX_IMPORT_BYTES, MAX_IMPORT_ROWS } from "../services/workbook-import-csv.js";

/**
 * WB2-020: CSV import through the real routes against a real database, with files kept in a private local folder.
 * Redis is replaced by a recorder: background jobs are run here by calling what the worker calls.
 */
const queue = vi.hoisted(() => ({ ready: true, failEnqueue: false, jobs: [] as Array<{ importId: string; workspaceId: string }> }));
vi.mock("../workers/workbook-import.queue.js", () => ({
  workbookImportQueue: () => ({
    ready: async () => queue.ready,
    enqueue: async (job: { importId: string; workspaceId: string }) => {
      if (queue.failEnqueue) throw new Error("redis is down");
      queue.jobs.push(job);
    },
  }),
  closeWorkbookImportQueue: async () => {},
}));

const base = loadEnv();
const hasDatabase = Boolean(base.DATABASE_URL);
const URL_BASE = "/api/v1/workbooks-v2";
const { workbooks, workbookColumns, workbookRows, workbookCells, workbookImports, workbookImportIssues, entitlements, auditLogs } = schema;

interface ImportBody {
  id: string;
  status: string;
  fileName: string;
  counts: { total: number; processed: number; imported: number; duplicates: number; skipped: number; failed: number };
  progress: number;
  background: boolean;
  error: { code: string; message: string } | null;
  report: { available: boolean; rows: number };
  preview: {
    delimiter: string;
    headers: Array<{ index: number; name: string; fits: string[] }>;
    rows: Array<{ line: number; values: string[]; problem?: string }>;
    suggestions: Array<{ header: number; target: { columnId?: string; newColumn?: { name: string; dataType: string } } | null }>;
  } | null;
  mapping: { columns: Array<{ header: number; columnId: string; columnName: string }>; dedupe: { key: string; header?: number } } | null;
  finishedAt: string | null;
}

describe.skipIf(!hasDatabase)("Workbooks V2 CSV import", () => {
  const { db, sql } = createDb(base.DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  const config = { ...base, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal" as const, OPENSEARCH_URL: undefined, EARLY_ACCESS_GATE_ENABLED: "true" as never, RATE_LIMIT_MAX: 100_000, PLATFORM_ADMIN_EMAILS: [], EXPORTS_BUCKET: undefined };
  const before = { dir: process.env.WORKBOOK_IMPORTS_LOCAL_DIR, tmp: process.env.TMPDIR };
  let root: string;
  let filesDir: string;
  let tempRoot: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let n = 0;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "wb2-import-test-"));
    filesDir = path.join(root, "files");
    tempRoot = path.join(root, "tmp");
    await import("node:fs/promises").then((fs) => fs.mkdir(tempRoot, { recursive: true }));
    // Private folders, so "nothing is left behind" can be checked while other test files run.
    process.env.WORKBOOK_IMPORTS_LOCAL_DIR = filesDir;
    process.env.TMPDIR = tempRoot;
    app = await buildApp(config);
  });
  beforeEach(() => {
    queue.ready = true;
    queue.failEnqueue = false;
    queue.jobs.length = 0;
  });
  afterAll(async () => {
    await app.close();
    await sql.end();
    process.env.WORKBOOK_IMPORTS_LOCAL_DIR = before.dir;
    process.env.TMPDIR = before.tmp;
    if (before.dir === undefined) delete process.env.WORKBOOK_IMPORTS_LOCAL_DIR;
    if (before.tmp === undefined) delete process.env.TMPDIR;
    await rm(root, { recursive: true, force: true });
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
    const email = `wb2-import-${suffix}-${n}@test.com`;
    const ip = `15.${Math.floor(n / 250)}.${n % 250}.7`;
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
    const key = `import-${suffix}-${++n}`;
    const [role] = await db.insert(schema.roles).values({ workspaceId: owner.workspaceId, key, name: key, description: "test", isSystem: false }).returning();
    if (permissions.length) await db.insert(schema.rolePermissions).values(permissions.map((permissionKey) => ({ roleId: role!.id, permissionKey })));
    await db.insert(schema.workspaceMemberRoles).values({ workspaceId: owner.workspaceId, userId: other.userId, roleId: role!.id });
    return { ...other, workspaceId: owner.workspaceId, headers: { ...other.headers, "x-workspace-id": owner.workspaceId } };
  }

  type Method = "GET" | "POST" | "PATCH" | "DELETE";
  const call = (u: User, method: Method, p: string, body?: unknown) =>
    app.inject({
      method,
      url: `${URL_BASE}${p}`,
      remoteAddress: u.ip,
      headers: { ...u.headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });

  interface Book {
    id: string;
    col: { name: string; email: string; linkedin: string; domain: string; notes: string; work: string };
  }

  async function book(u: User): Promise<Book> {
    const res = await call(u, "POST", "", { name: "Import" });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().data.id as string;
    const spec = [
      ["name", "Name", "input", "text"],
      ["email", "Email", "input", "email"],
      ["linkedin", "LinkedIn URL", "input", "linkedin_url"],
      ["domain", "Domain", "input", "domain"],
      ["notes", "Notes", "input", "text"],
      ["work", "Work email", "enrichment", null],
    ] as const;
    const col = Object.fromEntries(spec.map(([key]) => [key, randomUUID()])) as Book["col"];
    await db.insert(workbookColumns).values(spec.map(([key, name, type, dataType], position) => ({ id: col[key], workbookId: id, name, type, position, config: dataType ? { dataType } : {} })));
    return { id, col };
  }

  // ── Imports ────────────────────────────────────────────────────────────────

  const upload = (u: User, workbookId: string, content: string | Buffer | Readable, opts: { name?: string | null; type?: string; headers?: Record<string, string> } = {}) =>
    app.inject({
      method: "POST",
      url: `${URL_BASE}/${workbookId}/imports`,
      remoteAddress: u.ip,
      headers: {
        ...u.headers,
        "content-type": opts.type ?? "text/csv",
        ...(opts.name === null ? {} : { "x-file-name": encodeURIComponent(opts.name ?? "leads.csv") }),
        ...opts.headers,
      },
      payload: content,
    });

  async function uploaded(u: User, workbookId: string, content: string, name?: string): Promise<ImportBody> {
    const res = await upload(u, workbookId, content, { name });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().data;
  }

  const csv = (header: string, rows: string[]) => `${[header, ...rows].join("\n")}\n`;
  const confirm = (u: User, workbookId: string, importId: string, columns: unknown[], dedupe: unknown = { key: "none" }) =>
    call(u, "POST", `/${workbookId}/imports/${importId}/confirm`, { columns, dedupe });

  async function status(u: User, workbookId: string, importId: string): Promise<ImportBody> {
    const res = await call(u, "GET", `/${workbookId}/imports/${importId}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data;
  }

  const storage = () => importStorage(config)!;
  const work = (importId: string, lastAttempt = false) => runImportJob(db, storage(), importId, lastAttempt);

  async function report(u: User, workbookId: string, importId: string): Promise<string[]> {
    const res = await call(u, "GET", `/${workbookId}/imports/${importId}/report`);
    expect(res.statusCode, res.body).toBe(200);
    return res.body.replace(/^\uFEFF/, "").trimEnd().split("\r\n");
  }

  /** The workbook's values by row position, as `{ columnKey: value }`. */
  async function stored(b: Book) {
    const rows = await db.select().from(workbookRows).where(eq(workbookRows.workbookId, b.id)).orderBy(asc(workbookRows.position));
    const cells = await db.select().from(workbookCells).where(eq(workbookCells.workbookId, b.id));
    const key = new Map(Object.entries(b.col).map(([k, id]) => [id, k]));
    const byRow = new Map<number, Record<string, unknown>>();
    for (const c of cells) byRow.set(c.rowId, { ...byRow.get(c.rowId), [key.get(c.columnId) ?? c.columnId]: c.value });
    return rows.map((r) => ({ ...r, values: byRow.get(r.id) ?? {} }));
  }

  const rowCountOf = async (b: Book) => (await db.select({ n: workbooks.rowCount }).from(workbooks).where(eq(workbooks.id, b.id)))[0]!.n;
  const recordOf = async (importId: string) => (await db.select().from(workbookImports).where(eq(workbookImports.id, importId)))[0]!;
  const columnsOf = (b: Book) => db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, b.id)).orderBy(asc(workbookColumns.position));
  const issuesOf = (importId: string) => db.select().from(workbookImportIssues).where(eq(workbookImportIssues.importId, importId));
  const addedEvents = async (b: Book) =>
    (await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, b.id), eq(auditLogs.action, "workbook.rows.added")))).map((e) => ({ actorId: e.actorId, ...(e.afterState as Record<string, unknown>) }));

  async function filesUnder(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
  }
  const filesOf = async (importId: string) => (await filesUnder(filesDir)).filter((f) => f.includes(importId)).map((f) => path.basename(f));
  const tempFiles = () => filesUnder(path.join(tempRoot, "skout-workbook-imports"));

  /** An uploaded and confirmed import of `rows` numbered people, waiting for the worker. */
  async function queuedImport(u: User, b: Book, rows: string[], dedupe: unknown = { key: "none" }) {
    const imp = await uploaded(u, b.id, csv("Name,Email", rows));
    const res = await confirm(u, b.id, imp.id, [{ header: 0, columnId: b.col.name }, { header: 1, columnId: b.col.email }], dedupe);
    expect(res.statusCode, res.body).toBe(202);
    return imp.id;
  }
  const people = (count: number, tag = "p") => Array.from({ length: count }, (_, i) => `${tag}${i + 1},${tag}${i + 1}-${suffix}@x.com`);
  const BOOM = `boom-${suffix}`;
  /** Fails the chunk holding the row named BOOM while `run` executes. */
  const failingAtBoom = <T>(run: () => Promise<T>) => withFailingCellInserts(sql, `wb2_import_boom_${suffix}`, `new.value = '"${BOOM}"'::jsonb`, run);
  const withBoomAt = (rows: string[], index: number) => rows.map((r, i) => (i === index ? r.replace(/^[^,]+/, BOOM) : r));

  // ── Upload and preview ─────────────────────────────────────────────────────

  describe("upload and preview", () => {
    it("shows the headers, the first 20 rows and a suggested mapping, and adds nothing", async () => {
      const u = await user();
      const b = await book(u);
      const res = await upload(u, b.id, csv("name,E-mail,Company website,Seats", Array.from({ length: 30 }, (_, i) => `p${i},p${i}@x.com,co${i}.com,${i + 1}`)), { name: "Q4 leads (final).csv" });
      expect(res.statusCode, res.body).toBe(201);
      const imp = res.json().data as ImportBody;
      expect(imp).toMatchObject({ status: "awaiting_confirmation", fileName: "Q4 leads (final).csv", counts: { total: 30, processed: 0, imported: 0 }, progress: 0, background: false, mapping: null, report: { available: false } });
      expect(imp.preview!.rows).toHaveLength(20);
      expect(imp.preview!.rows[19]).toEqual({ line: 21, values: ["p19", "p19@x.com", "co19.com", "20"] });
      expect(imp.preview!.headers.map((h) => h.name)).toEqual(["name", "E-mail", "Company website", "Seats"]);
      expect(imp.preview!.suggestions.map((s) => s.target)).toEqual([{ columnId: b.col.name }, { columnId: b.col.email }, { columnId: b.col.domain }, { newColumn: { name: "Seats", dataType: "number" } }]);
      expect(await stored(b)).toEqual([]);
      expect(await columnsOf(b)).toHaveLength(6);
      expect(await filesOf(imp.id)).toEqual(["upload.csv"]);
      expect(await tempFiles()).toEqual([]);
      // Nothing says where the file is.
      expect(res.body).not.toContain("workbook-imports");
      expect(res.body).not.toContain(root);
      expect(await status(u, b.id, imp.id)).toEqual(imp);
    });

    it.each(["text/csv; charset=utf-8", "application/vnd.ms-excel", "application/octet-stream", "text/plain"])("accepts a CSV sent as %s", async (type) => {
      const u = await user();
      const b = await book(u);
      expect((await upload(u, b.id, "a\n1\n", { type })).statusCode).toBe(201);
    });

    it("keeps only the file's own name", async () => {
      const u = await user();
      const b = await book(u);
      expect((await uploaded(u, b.id, "a\n1\n", "..\\..\\etc/pass‮wd.csv")).fileName).toBe("passwd.csv");
    });

    it.each<[string, string | Buffer, { name?: string | null; type?: string }, number, string]>([
      ["a file not ending in .csv", "a\n1\n", { name: "leads.xlsx" }, 415, "UNSUPPORTED_FILE_TYPE"],
      ["a content type that is not CSV", "a\n1\n", { type: "image/png" }, 415, "UNSUPPORTED_FILE_TYPE"],
      ["a JSON request", '{"a":1}', { type: "application/json" }, 415, "UNSUPPORTED_FILE_TYPE"],
      ["no file name", "a\n1\n", { name: null }, 415, "UNSUPPORTED_FILE_TYPE"],
      ["an empty file", "", {}, 422, "INVALID_CSV"],
      ["an Excel file renamed to .csv", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), {}, 422, "INVALID_CSV"],
      ["binary content claiming to be CSV", Buffer.from([0x61, 0x0a, 0x00, 0x01]), {}, 422, "INVALID_CSV"],
      ["a broken quote", 'a,b\n1,"x\n', {}, 422, "INVALID_CSV"],
      ["a header with no rows", "a,b\n", {}, 422, "INVALID_CSV"],
    ])("refuses %s and keeps nothing", async (_name, content, opts, code, error) => {
      const u = await user();
      const b = await book(u);
      const filesBefore = (await filesUnder(filesDir)).length;
      const res = await upload(u, b.id, content, opts);
      expect(res.statusCode, res.body).toBe(code);
      expect(res.json()).toMatchObject({ code: error, message: expect.any(String) });
      expect(res.body).not.toContain(root);
      expect(await db.select().from(workbookImports).where(eq(workbookImports.workbookId, b.id))).toEqual([]);
      expect((await filesUnder(filesDir)).length).toBe(filesBefore);
      expect(await tempFiles()).toEqual([]);
    });

    /** `MAX_IMPORT_ROWS` rows padded to exactly `bytes`. */
    function sized(bytes: number): Buffer {
      const header = "a,b\n";
      const rows = 60_000;
      const each = Math.floor((bytes - header.length) / rows);
      const buffer = Buffer.alloc(bytes, "x");
      buffer.write(header, 0);
      for (let i = 0; i < rows; i++) {
        const start = header.length + i * each;
        buffer.write("1,", start);
        if (i < rows - 1) buffer.write("\n", start + each - 1);
      }
      buffer.write("\n", bytes - 1);
      return buffer;
    }

    it("accepts a file of exactly 50 MB", async () => {
      const u = await user();
      const b = await book(u);
      const res = await upload(u, b.id, sized(MAX_IMPORT_BYTES));
      expect(res.statusCode, res.body.slice(0, 500)).toBe(201);
      expect(res.json().data).toMatchObject({ fileBytes: 52_428_800, counts: { total: 60_000 } });
    });

    it("refuses one byte more, from the declared length", async () => {
      const u = await user();
      const b = await book(u);
      const res = await upload(u, b.id, sized(MAX_IMPORT_BYTES + 1));
      expect(res.statusCode).toBe(413);
      expect(res.json()).toMatchObject({ code: "FILE_TOO_LARGE", message: expect.stringContaining("50 MB") });
      expect(await tempFiles()).toEqual([]);
    });

    it("refuses an oversized file that does not declare its length, while it is still arriving", async () => {
      const u = await user();
      const b = await book(u);
      const chunk = Buffer.from("1\n".repeat(512 * 1024));
      let sent = 0;
      const body = new Readable({
        read() {
          sent += 1;
          this.push(sent <= 60 ? chunk : null);
        },
      });
      const res = await upload(u, b.id, body);
      expect(res.statusCode, res.body).toBe(413);
      expect(res.json().code).toBe("FILE_TOO_LARGE");
      expect(await db.select().from(workbookImports).where(eq(workbookImports.workbookId, b.id))).toEqual([]);
      expect(await tempFiles()).toEqual([]);
    });

    it(`accepts ${MAX_IMPORT_ROWS} rows and refuses ${MAX_IMPORT_ROWS + 1}`, async () => {
      const u = await user();
      const b = await book(u);
      expect((await uploaded(u, b.id, `a\n${"1\n".repeat(MAX_IMPORT_ROWS)}`)).counts.total).toBe(MAX_IMPORT_ROWS);
      const res = await upload(u, b.id, `a\n${"1\n".repeat(MAX_IMPORT_ROWS + 1)}`);
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe("TOO_MANY_ROWS");
    });

    it("limits how many unfinished imports a workspace can pile up", async () => {
      const u = await user();
      const b = await book(u);
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) ids.push((await uploaded(u, b.id, "a\n1\n")).id);
      const res = await upload(u, b.id, "a\n1\n");
      expect(res.statusCode).toBe(429);
      expect(res.json().code).toBe("TOO_MANY_PENDING_IMPORTS");
      await call(u, "DELETE", `/${b.id}/imports/${ids[0]}`);
      expect((await upload(u, b.id, "a\n1\n")).statusCode).toBe(201);
    });
  });

  // ── Mapping and confirming ─────────────────────────────────────────────────

  describe("confirming", () => {
    it("imports into existing and new columns as mapped, and nothing else", async () => {
      const u = await user();
      const b = await book(u);
      const imp = await uploaded(u, b.id, csv("Full name,Contact,Seats,Secret", ["Ann,ann@x.com,5,no", '"Lee, Bo",,0007,no']), "crm.csv");
      const res = await confirm(u, b.id, imp.id, [
        // Chosen by hand: the file calls it something else, and the person points it at Notes.
        { header: 1, columnId: b.col.email },
        { header: 0, columnId: b.col.notes },
        { header: 2, newColumn: { name: " Seats ", dataType: "text" } },
      ]);
      expect(res.statusCode, res.body).toBe(200);
      const done = res.json().data as ImportBody;
      expect(done).toMatchObject({ status: "completed", progress: 100, counts: { total: 2, processed: 2, imported: 2, duplicates: 0, skipped: 0, failed: 0 }, preview: null, error: null });
      expect(done.mapping!.columns.map((c) => c.columnName)).toEqual(["Notes", "Email", "Seats"]);
      const columns = await columnsOf(b);
      expect(columns.at(-1)).toMatchObject({ name: "Seats", type: "input", config: { dataType: "text" }, position: 6 });
      const seats = columns.at(-1)!.id;
      const rows = await stored(b);
      expect(rows.map((r) => r.values)).toEqual([
        { notes: "Ann", email: "ann@x.com", [seats]: "5" },
        { notes: "Lee, Bo", [seats]: "0007" },
      ]);
      expect(rows.map((r) => r.position)).toEqual([0, 1]);
      expect(rows[0]!.source).toEqual({ type: "csv", fileName: "crm.csv", importId: imp.id, importedAt: (await recordOf(imp.id)).confirmedAt!.toISOString() });
      expect(await rowCountOf(b)).toBe(2);
      // Visible through the rows API, like any other rows.
      const window = await call(u, "GET", `/${b.id}/rows`);
      expect(window.json().window.total).toBe(2);
      expect(window.json().data[0].cells[b.col.notes]).toMatchObject({ value: "Ann", state: "found", creditsCharged: 0 });
      expect(await addedEvents(b)).toEqual([{ actorId: u.userId, source: "csv", rows: 2, rowCount: 2 }]);
      expect(await filesOf(imp.id)).toEqual([]);
      expect((await recordOf(imp.id)).fileKey).toBeNull();
      expect(await tempFiles()).toEqual([]);
      const log = await call(u, "GET", `/${b.id}/activity`);
      expect(log.json().data.map((e: { type: string }) => e.type).sort()).toEqual(["column.added", "rows.added"]);
    });

    it("adds after the existing rows and never changes them", async () => {
      const u = await user();
      const b = await book(u);
      await call(u, "POST", `/${b.id}/rows`, { cells: { [b.col.name]: "Original", [b.col.email]: "same@x.com" } });
      const before = await stored(b);
      const imp = await uploaded(u, b.id, "Name,Email\nReplacement,same@x.com\nNew,new@x.com\n");
      const res = await confirm(u, b.id, imp.id, [{ header: 0, columnId: b.col.name }, { header: 1, columnId: b.col.email }], { key: "email" });
      expect(res.json().data.counts).toMatchObject({ imported: 1, duplicates: 1 });
      const after = await stored(b);
      expect(after[0]).toEqual(before[0]);
      expect(after[1]!.values).toEqual({ name: "New", email: "new@x.com" });
    });

    it.each<[string, (b: Book) => unknown[], unknown, string]>([
      ["two file columns into one column", (b) => [{ header: 0, columnId: b.col.name }, { header: 1, columnId: b.col.name }], { key: "none" }, "COLUMN_MAPPED_TWICE"],
      ["a column that is not an input", (b) => [{ header: 0, columnId: b.col.work }], { key: "none" }, "NOT_AN_INPUT_COLUMN"],
      ["a column from nowhere", () => [{ header: 0, columnId: "00000000-0000-4000-8000-0000000000ff" }], { key: "none" }, "UNKNOWN_COLUMN"],
      ["a new column with a name in use", () => [{ header: 0, newColumn: { name: "email", dataType: "text" } }], { key: "none" }, "COLUMN_NAME_IN_USE"],
      ["a header the file lacks", (b) => [{ header: 7, columnId: b.col.name }], { key: "none" }, "UNKNOWN_HEADER"],
      ["nothing at all", () => [], { key: "none" }, "NOTHING_MAPPED"],
      ["a dedupe key with no column for it", (b) => [{ header: 0, columnId: b.col.name }], { key: "email" }, "DEDUPE_COLUMN_REQUIRED"],
      ["a valid new column beside a bad mapping", (b) => [{ header: 0, newColumn: { name: "Fresh", dataType: "text" } }, { header: 1, columnId: b.col.work }], { key: "none" }, "NOT_AN_INPUT_COLUMN"],
    ])("refuses %s, changing nothing", async (_name, mapping, dedupe, code) => {
      const u = await user();
      const b = await book(u);
      const imp = await uploaded(u, b.id, "a,b\n1,2\n");
      const res = await confirm(u, b.id, imp.id, mapping(b), dedupe);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().code).toBe("INVALID_IMPORT_MAPPING");
      expect(res.json().details.errors.map((e: { code: string }) => e.code)).toContain(code);
      expect(await columnsOf(b)).toHaveLength(6);
      expect(await stored(b)).toEqual([]);
      expect((await status(u, b.id, imp.id)).status).toBe("awaiting_confirmation");
      expect(await filesOf(imp.id)).toEqual(["upload.csv"]);
    });

    it.each<[string, unknown]>([
      ["no dedupe choice", { columns: [{ header: 0, newColumn: { name: "A", dataType: "text" } }] }],
      ["an unknown dedupe key", { columns: [], dedupe: { key: "phone" } }],
      ["both a column and a new column", { columns: [{ header: 0, columnId: "00000000-0000-4000-8000-000000000001", newColumn: { name: "A", dataType: "text" } }], dedupe: { key: "none" } }],
      ["neither", { columns: [{ header: 0 }], dedupe: { key: "none" } }],
      ["a blank column name", { columns: [{ header: 0, newColumn: { name: "  ", dataType: "text" } }], dedupe: { key: "none" } }],
      ["an unknown data type", { columns: [{ header: 0, newColumn: { name: "A", dataType: "money" } }], dedupe: { key: "none" } }],
      ["a workspace id", { columns: [], dedupe: { key: "none" }, workspaceId: "00000000-0000-4000-8000-000000000001" }],
    ])("refuses a request with %s", async (_name, body) => {
      const u = await user();
      const b = await book(u);
      const imp = await uploaded(u, b.id, "a\n1\n");
      const res = await call(u, "POST", `/${b.id}/imports/${imp.id}/confirm`, body);
      expect(res.statusCode, res.body).toBe(422);
      expect(await stored(b)).toEqual([]);
    });

    it("imports once however many times it is confirmed", async () => {
      const u = await user();
      const b = await book(u);
      const imp = await uploaded(u, b.id, "a\n1\n2\n");
      const mapping = [{ header: 0, columnId: b.col.name }];
      const both = await Promise.all([confirm(u, b.id, imp.id, mapping), confirm(u, b.id, imp.id, mapping)]);
      expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const again = await confirm(u, b.id, imp.id, mapping);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: "IMPORT_STATE_CONFLICT", details: { status: "completed" } });
      expect((await call(u, "DELETE", `/${b.id}/imports/${imp.id}`)).statusCode).toBe(409);
      expect(await stored(b)).toHaveLength(2);
      expect(await addedEvents(b)).toHaveLength(1);
    });

    /** Starts the requests together: each is past its first look at the import before any of them can change it. */
    async function together<T>(importId: string, requests: Array<() => PromiseLike<T>>): Promise<T[]> {
      let sent!: Promise<T[]>;
      await db.transaction(async (tx) => {
        await tx.select().from(workbookImports).where(eq(workbookImports.id, importId)).for("no key update");
        sent = Promise.all(requests.map(async (request) => request()));
        await vi.waitFor(async () => {
          const [waiting] = await sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%from "workbook_imports"%for no key update%'`;
          expect(waiting!.n).toBeGreaterThanOrEqual(requests.length);
        }, { timeout: 20_000, interval: 25 });
      });
      return sent;
    }

    it("starts one import when two confirmations arrive at the same moment", async () => {
      const u = await user();
      const b = await book(u);
      const imp = await uploaded(u, b.id, "a\n1\n2\n");
      const send = () => confirm(u, b.id, imp.id, [{ header: 0, columnId: b.col.name }]);
      const both = await together(imp.id, [send, send]);
      expect(both.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(await stored(b)).toHaveLength(2);
      expect(await addedEvents(b)).toHaveLength(1);
    });

    it("either imports or cancels when both arrive at the same moment", async () => {
      const u = await user();
      const b = await book(u);
      const imp = await uploaded(u, b.id, "a\n1\n");
      const [confirmed, cancelled] = await together(imp.id, [() => confirm(u, b.id, imp.id, [{ header: 0, columnId: b.col.name }]), () => call(u, "DELETE", `/${b.id}/imports/${imp.id}`)]);
      expect([confirmed!.statusCode, cancelled!.statusCode].sort()).toEqual([200, 409]);
      const done = await status(u, b.id, imp.id);
      expect([done.status, (await stored(b)).length]).toEqual(confirmed!.statusCode === 200 ? ["completed", 1] : ["cancelled", 0]);
      expect(await filesOf(imp.id)).toEqual([]);
    });

    it("can be cancelled before confirming, which removes the file", async () => {
      const u = await user();
      const b = await book(u);
      const imp = await uploaded(u, b.id, "a\n1\n");
      const res = await call(u, "DELETE", `/${b.id}/imports/${imp.id}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toMatchObject({ status: "cancelled", preview: null });
      expect(await filesOf(imp.id)).toEqual([]);
      expect((await confirm(u, b.id, imp.id, [{ header: 0, columnId: b.col.name }])).statusCode).toBe(409);
      expect(await stored(b)).toEqual([]);
    });

    it("ends as failed, without internal detail, when a small import cannot be written", async () => {
      const u = await user();
      const b = await book(u);
      const imp = await uploaded(u, b.id, `a\n${BOOM}\n`);
      const res = await failingAtBoom(() => confirm(u, b.id, imp.id, [{ header: 0, columnId: b.col.name }]));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toMatchObject({ status: "failed", error: { code: "IMPORT_FAILED" }, counts: { imported: 0 } });
      expect(res.body).not.toMatch(/boom|insert|trigger|workbook_cells/i);
      expect(await stored(b)).toEqual([]);
      expect(await addedEvents(b)).toEqual([]);
      expect(await filesOf(imp.id)).toEqual([]);
      expect(await tempFiles()).toEqual([]);
    });
  });

  // ── Deduplication ──────────────────────────────────────────────────────────

  describe("deduplication", () => {
    const cases = [
      { key: "email", column: "email", existing: "Ann@Acme.com", same: "ann@acme.COM", other: "bo@acme.com", otherAgain: " BO@acme.com ", bad: "not-an-email" },
      { key: "linkedin_url", column: "linkedin", existing: "https://www.linkedin.com/in/ann/", same: "linkedin.com/in/Ann?trk=x", other: "https://linkedin.com/in/bo", otherAgain: "https://uk.linkedin.com/in/bo/en", bad: "https://example.com/ann" },
      { key: "domain", column: "domain", existing: "acme.com", same: "WWW.Acme.com", other: "other.io", otherAgain: "www.other.io", bad: "not a domain" },
    ] as const;

    it.each(cases)("skips and counts duplicates by $key, against the workbook and within the file", async ({ key, column, existing, same, other, otherAgain, bad }) => {
      const u = await user();
      const b = await book(u);
      await call(u, "POST", `/${b.id}/rows`, { cells: { [b.col.name]: "existing", [b.col[column]]: existing } });
      const imp = await uploaded(u, b.id, csv("Name,Key", [`dup-of-existing,${same}`, `first,${other}`, `dup-in-file,${otherAgain}`, "no-key,", `bad-key,${bad}`, "no-key-2,"]));
      const res = await confirm(u, b.id, imp.id, [{ header: 0, columnId: b.col.name }, { header: 1, columnId: b.col[column] }], { key });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data.counts).toEqual({ total: 6, processed: 6, imported: 3, duplicates: 2, skipped: 0, failed: 1 });
      expect((await stored(b)).map((r) => r.values.name)).toEqual(["existing", "first", "no-key", "no-key-2"]);
      const lines = await report(u, b.id, imp.id);
      expect(lines.map((l) => l.split(",").slice(0, 2).join(","))).toEqual(['"Line in file","Result"', '"2","Duplicate"', '"4","Duplicate"', '"6","Invalid value"']);
      expect(lines[1]).toContain("already in the workbook or earlier in this file");
      expect(lines[3]).toContain("Invalid field value");
    });

    it("applies no key when none is chosen", async () => {
      const u = await user();
      const b = await book(u);
      await call(u, "POST", `/${b.id}/rows`, { cells: { [b.col.email]: "a@x.com" } });
      const imp = await uploaded(u, b.id, "Email\na@x.com\na@x.com\n");
      const res = await confirm(u, b.id, imp.id, [{ header: 0, columnId: b.col.email }]);
      expect(res.json().data.counts).toMatchObject({ imported: 2, duplicates: 0 });
      expect(await stored(b)).toHaveLength(3);
    });

    it("reads the key from a text column when asked to, and from a new column", async () => {
      const u = await user();
      const b = await book(u);
      const imp = await uploaded(u, b.id, "Site\nhttps://www.acme.com/a\nacme.com\nother.io\n");
      const res = await confirm(u, b.id, imp.id, [{ header: 0, newColumn: { name: "Site", dataType: "url" } }], { key: "domain", header: 0 });
      // "acme.com" has no scheme, so it is not a valid web address for the new url column.
      expect(res.json().data.counts).toMatchObject({ imported: 1, duplicates: 0, failed: 2 });
      const text = await uploaded(u, b.id, "Site\nhttps://www.acme.com/a\nacme.com\nother.io\n");
      const second = await confirm(u, b.id, text.id, [{ header: 0, columnId: b.col.notes }], { key: "domain", header: 0 });
      expect(second.json().data.counts).toMatchObject({ imported: 2, duplicates: 1 });
    });

    it("finds duplicates across chunks of a large file and rows already there", async () => {
      const u = await user();
      const b = await book(u);
      await call(u, "POST", `/${b.id}/rows`, { cells: { [b.col.email]: `p2400-${suffix}@x.com` } });
      // 2,500 people, then the first 100 again.
      const id = await queuedImport(u, b, [...people(2_500), ...people(100)], { key: "email" });
      await work(id);
      expect((await status(u, b.id, id)).counts).toEqual({ total: 2_600, processed: 2_600, imported: 2_499, duplicates: 101, skipped: 0, failed: 0 });
      const emails = (await stored(b)).map((r) => r.values.email);
      expect(new Set(emails).size).toBe(emails.length);
      expect(emails).toHaveLength(2_500);
      expect(await report(u, b.id, id)).toHaveLength(102);
    });

    it("sees a row someone else adds while the import is running", async () => {
      const u = await user();
      const b = await book(u);
      const late = `p1500-${suffix}@x.com`;
      const id = await queuedImport(u, b, people(1_600), { key: "email" });
      let job!: Promise<void>;
      // Holds the workbook's lock, as any writer does, until the job is waiting for it with its first read already done.
      await db.transaction(async (tx) => {
        await tx.select().from(workbooks).where(eq(workbooks.id, b.id)).for("no key update");
        job = work(id);
        await vi.waitFor(async () => {
          const [waiting] = await sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%"workbooks"%for no key update%'`;
          expect(waiting!.n).toBeGreaterThan(0);
        }, { timeout: 20_000, interval: 25 });
        const [row] = await tx.insert(workbookRows).values({ workbookId: b.id, position: 0 }).returning();
        await tx.insert(workbookCells).values({ workbookId: b.id, rowId: row!.id, columnId: b.col.email, state: "found", value: late });
      });
      await job;
      expect((await status(u, b.id, id)).counts).toMatchObject({ imported: 1_599, duplicates: 1 });
    });

    it("keeps two imports of the same people into one workbook from adding anyone twice", async () => {
      const u = await user();
      const b = await book(u);
      const rows = people(2_200);
      const first = await queuedImport(u, b, rows, { key: "email" });
      const second = await queuedImport(u, b, rows, { key: "email" });
      await Promise.all([work(first), work(second)]);
      const [a, z] = [await status(u, b.id, first), await status(u, b.id, second)];
      expect(a.counts.imported + z.counts.imported).toBe(2_200);
      expect(a.counts.duplicates + z.counts.duplicates).toBe(2_200);
      expect(await rowCountOf(b)).toBe(2_200);
    });
  });

  // ── Rows that are not imported ─────────────────────────────────────────────

  describe("the skipped-rows report", () => {
    it("lists every row left out with its reason and values, safe to open in a spreadsheet", async () => {
      const u = await user();
      const b = await book(u);
      const imp = await uploaded(u, b.id, 'Name,Email,Extra\nok,ok@x.com,a\nshort\n,,only ignored\n"=HYPERLINK(""evil"")",nope,@cmd\n+1,also-bad,"two\nlines"\n', "mixed.csv");
      const res = await confirm(u, b.id, imp.id, [{ header: 0, columnId: b.col.name }, { header: 1, columnId: b.col.email }]);
      expect(res.json().data).toMatchObject({ status: "completed", counts: { total: 5, processed: 5, imported: 1, duplicates: 0, skipped: 1, failed: 3 }, report: { available: true, rows: 4 } });
      const download = await call(u, "GET", `/${b.id}/imports/${imp.id}/report`);
      expect(download.headers["content-type"]).toBe("text/csv; charset=utf-8");
      expect(download.headers["content-disposition"]).toBe(`attachment; filename="skipped-rows-${imp.id.slice(0, 8)}.csv"`);
      expect(download.headers["cache-control"]).toBe("private, no-store");
      expect(download.body).toBe(
        "\uFEFF" +
          [
            '"Line in file","Result","Reason","Name","Email","Extra"',
            '"3","Malformed row","Malformed CSV row: expected 3 values, found 1","short"',
            '"4","Skipped","Missing value: every mapped column is empty in this row","","","only ignored"',
            '"5","Invalid value","Invalid field value. Email: not a valid email address","\'=HYPERLINK(""evil"")","nope","\'@cmd"',
            '"6","Invalid value","Invalid field value. Email: not a valid email address","\'+1","also-bad","two\nlines"',
          ].join("\r\n") +
          "\r\n"
      );
      // The file is gone; the report stays, and the rows it came from are not kept twice.
      expect(await filesOf(imp.id)).toEqual(["report.csv"]);
      expect(await issuesOf(imp.id)).toEqual([]);
    });

    it("is not offered when every row was imported, or before the import finishes", async () => {
      const u = await user();
      const b = await book(u);
      const clean = await uploaded(u, b.id, "a\n1\n");
      const early = await call(u, "GET", `/${b.id}/imports/${clean.id}/report`);
      expect(early.statusCode).toBe(404);
      expect(early.json()).toMatchObject({ code: "REPORT_NOT_AVAILABLE", message: expect.stringContaining("when the import finishes") });
      await confirm(u, b.id, clean.id, [{ header: 0, columnId: b.col.name }]);
      const none = await call(u, "GET", `/${b.id}/imports/${clean.id}/report`);
      expect(none.statusCode).toBe(404);
      expect(none.json().message).toContain("Every row was imported");
      expect((await status(u, b.id, clean.id)).report).toEqual({ available: false, rows: 0 });
    });

    it("says so when the stored report has expired", async () => {
      const u = await user();
      const b = await book(u);
      const imp = await uploaded(u, b.id, "a,b\n,\n");
      await confirm(u, b.id, imp.id, [{ header: 0, columnId: b.col.name }]);
      await storage().remove((await recordOf(imp.id)).errorReportFile!);
      const res = await call(u, "GET", `/${b.id}/imports/${imp.id}/report`);
      expect(res.statusCode).toBe(404);
      expect(res.json().message).toContain("expired");
    });

    it("counts rows past the workbook's row limit as failed, and refuses a full workbook", async () => {
      const u = await user();
      const b = await book(u);
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 3);
      await call(u, "POST", `/${b.id}/rows`, { cells: { [b.col.name]: "first" } });
      const imp = await uploaded(u, b.id, "a\n1\n2\n3\n4\n");
      const res = await confirm(u, b.id, imp.id, [{ header: 0, columnId: b.col.name }]);
      expect(res.json().data.counts).toMatchObject({ imported: 2, failed: 2 });
      expect(await rowCountOf(b)).toBe(3);
      expect((await report(u, b.id, imp.id))[1]).toBe('"4","Over the row limit","The workbook reached its limit of 3 rows","3"');
      const another = await uploaded(u, b.id, "a\n9\n");
      const full = await confirm(u, b.id, another.id, [{ header: 0, newColumn: { name: "Never", dataType: "text" } }]);
      expect(full.statusCode).toBe(422);
      expect(full.json().code).toBe("ROW_LIMIT_EXCEEDED");
      expect(await columnsOf(b)).toHaveLength(6);
    });
  });

  // ── Background imports ─────────────────────────────────────────────────────

  describe("background imports", () => {
    it("runs up to 1,000 rows at once and queues more", async () => {
      const u = await user();
      const b = await book(u);
      const small = await uploaded(u, b.id, csv("Name,Email", people(1_000)));
      expect(small.background).toBe(false);
      const now = await confirm(u, b.id, small.id, [{ header: 0, columnId: b.col.name }, { header: 1, columnId: b.col.email }]);
      expect(now.statusCode).toBe(200);
      expect(now.json().data).toMatchObject({ status: "completed", counts: { imported: 1_000 } });
      expect(queue.jobs).toEqual([]);

      const big = await uploaded(u, b.id, csv("Name,Email", people(1_001, "q")));
      expect(big.background).toBe(true);
      const later = await confirm(u, b.id, big.id, [{ header: 0, columnId: b.col.name }, { header: 1, columnId: b.col.email }]);
      expect(later.statusCode).toBe(202);
      expect(later.json().data).toMatchObject({ status: "queued", progress: 0, counts: { total: 1_001, processed: 0, imported: 0 }, finishedAt: null });
      expect(queue.jobs).toEqual([{ importId: big.id, workspaceId: u.workspaceId }]);
      expect(await rowCountOf(b)).toBe(1_000);

      await work(big.id);
      expect(await status(u, b.id, big.id)).toMatchObject({ status: "completed", progress: 100, counts: { total: 1_001, processed: 1_001, imported: 1_001 }, finishedAt: expect.any(String) });
      expect(await rowCountOf(b)).toBe(2_001);
      expect((await call(u, "GET", `/${b.id}/imports`)).json().data.map((i: ImportBody) => [i.id, i.preview])).toEqual([
        [big.id, null],
        [small.id, null],
      ]);
    });

    it("reports the real progress and resumes after a failure without adding anything twice", async () => {
      const u = await user();
      const b = await book(u);
      const rows = withBoomAt(people(4_200), 2_499);
      const id = await queuedImport(u, b, rows);
      await failingAtBoom(() => expect(work(id)).rejects.toThrow());
      // Two whole chunks are in; the third is not, in any part.
      expect(await status(u, b.id, id)).toMatchObject({ status: "processing", progress: 47, counts: { total: 4_200, processed: 2_000, imported: 2_000 } });
      expect(await rowCountOf(b)).toBe(2_000);
      expect(await stored(b)).toHaveLength(2_000);
      expect(await filesOf(id)).toEqual(["upload.csv"]);
      expect(await addedEvents(b)).toEqual([]);

      await work(id);
      expect(await status(u, b.id, id)).toMatchObject({ status: "completed", progress: 100, counts: { processed: 4_200, imported: 4_200 } });
      const after = await stored(b);
      expect(after.map((r) => r.values.name)).toEqual(rows.map((r) => r.split(",")[0]));
      expect(after.map((r) => r.position)).toEqual(after.map((_, i) => i));
      expect(await rowCountOf(b)).toBe(4_200);
      expect(await addedEvents(b)).toEqual([{ actorId: u.userId, source: "csv", rows: 4_200, rowCount: 4_200 }]);
    });

    it("does nothing when a finished job is delivered again, and adds each row once when two workers run it", async () => {
      const u = await user();
      const b = await book(u);
      const id = await queuedImport(u, b, people(3_100));
      await Promise.all([work(id), work(id), work(id)]);
      await work(id);
      expect(await stored(b)).toHaveLength(3_100);
      expect((await status(u, b.id, id)).counts).toMatchObject({ processed: 3_100, imported: 3_100 });
      expect(await addedEvents(b)).toHaveLength(1);
    });

    it("keeps the workbook usable while it runs", async () => {
      const u = await user();
      const b = await book(u);
      const id = await queuedImport(u, b, people(5_000));
      const job = work(id);
      const added = [];
      for (let i = 0; i < 8; i++) added.push((await call(u, "POST", `/${b.id}/rows`, { cells: { [b.col.name]: `by hand ${i}` } })).statusCode);
      await job;
      expect(added).toEqual(Array(8).fill(201));
      expect(await rowCountOf(b)).toBe(5_008);
      const positions = (await stored(b)).map((r) => r.position);
      expect(new Set(positions).size).toBe(5_008);
    });

    it("passes on a failure without the values being written or where files are, which would end up in logs", async () => {
      const u = await user();
      const b = await book(u);
      const id = await queuedImport(u, b, withBoomAt(people(1_100), 5));
      const failure = await failingAtBoom(() => work(id).then(() => null, (error: Error) => error));
      const logged = `${failure!.name} ${failure!.message} ${JSON.stringify(failure)} ${failure!.stack} ${String((failure as { cause?: unknown }).cause ?? "")}`;
      expect(failure!.message).toContain(`Import ${id} could not be processed`);
      for (const secret of [BOOM, `-${suffix}@x.com`, "insert into", "INSERT INTO", filesDir, tempRoot]) expect(logged).not.toContain(secret);
    });

    it("is marked failed after the last attempt, keeping what was imported and reporting what was refused", async () => {
      const u = await user();
      const b = await book(u);
      const rows = withBoomAt(people(2_500), 1_700);
      rows[10] = "bad,nope";
      const id = await queuedImport(u, b, rows);
      await failingAtBoom(async () => {
        await expect(work(id, false)).rejects.toThrow();
        expect((await status(u, b.id, id)).status).toBe("processing");
        await expect(work(id, true)).rejects.toThrow();
      });
      const failed = await status(u, b.id, id);
      expect(failed).toMatchObject({ status: "failed", error: { code: "IMPORT_FAILED" }, counts: { processed: 1_000, imported: 999, failed: 1 }, report: { available: true } });
      expect(JSON.stringify(failed)).not.toMatch(/boom|trigger|insert into/i);
      expect(await rowCountOf(b)).toBe(999);
      expect(await report(u, b.id, id)).toHaveLength(2);
      expect(await filesOf(id)).toEqual(["report.csv"]);
      expect(await addedEvents(b)).toEqual([{ actorId: u.userId, source: "csv", rows: 999, rowCount: 999 }]);
      expect(await tempFiles()).toEqual([]);
      // A late retry changes nothing.
      await work(id);
      expect((await status(u, b.id, id)).status).toBe("failed");
      expect(await rowCountOf(b)).toBe(999);
    });

    it.each<[string, (b: Book, id: string) => Promise<unknown>, string]>([
      ["a mapped column was deleted", (b) => db.delete(workbookColumns).where(eq(workbookColumns.id, b.col.email)), "MAPPING_CHANGED"],
      ["a mapped column changed type", (b) => db.update(workbookColumns).set({ config: { dataType: "text" } }).where(eq(workbookColumns.id, b.col.email)), "MAPPING_CHANGED"],
      ["the uploaded file is gone", async (_b, id) => storage().remove((await recordOf(id)).fileKey!), "FILE_MISSING"],
      ["the workbook was deleted", (b) => db.update(workbooks).set({ deletedAt: new Date() }).where(eq(workbooks.id, b.id)), "WORKBOOK_DELETED"],
    ])("fails without retrying when %s", async (_name, change, code) => {
      const u = await user();
      const b = await book(u);
      const id = await queuedImport(u, b, people(1_200));
      await change(b, id);
      await work(id);
      expect(await recordOf(id)).toMatchObject({ status: "failed", error: { code }, fileKey: null });
      expect(await db.select().from(workbookRows).where(eq(workbookRows.workbookId, b.id))).toEqual([]);
      expect(await filesOf(id)).toEqual([]);
      expect(await tempFiles()).toEqual([]);
    });

    it("changes nothing when background work cannot be queued", async () => {
      const u = await user();
      const b = await book(u);
      const imp = await uploaded(u, b.id, csv("Name", people(1_001).map((p) => p.split(",")[0]!)));
      queue.ready = false;
      const res = await confirm(u, b.id, imp.id, [{ header: 0, newColumn: { name: "Fresh", dataType: "text" } }]);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "IMPORT_UNAVAILABLE", retryable: true });
      expect(await columnsOf(b)).toHaveLength(6);
      expect((await status(u, b.id, imp.id)).status).toBe("awaiting_confirmation");
    });
  });

  // ── Cleaning up ────────────────────────────────────────────────────────────

  describe("the sweep", () => {
    const sent: ImportJob[] = [];
    const recorder: ImportQueue = { ready: async () => true, enqueue: async (job) => void sent.push(job) };
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const sweep = () => sweepImports(db, storage(), recorder);

    it("removes files of imports never confirmed within a day", async () => {
      const u = await user();
      const b = await book(u);
      const old = await uploaded(u, b.id, "a\n1\n");
      const recent = await uploaded(u, b.id, "a\n1\n");
      await db.update(workbookImports).set({ createdAt: ago(24 * 60 + 1) }).where(eq(workbookImports.id, old.id));
      await db.update(workbookImports).set({ createdAt: ago(23 * 60) }).where(eq(workbookImports.id, recent.id));
      await sweep();
      expect(await status(u, b.id, old.id)).toMatchObject({ status: "cancelled", error: { code: "EXPIRED" }, preview: null });
      expect(await filesOf(old.id)).toEqual([]);
      expect((await status(u, b.id, recent.id)).status).toBe("awaiting_confirmation");
      expect(await filesOf(recent.id)).toEqual(["upload.csv"]);
    });

    it("queues an import whose job was lost, and leaves a fresh one alone", async () => {
      const u = await user();
      const b = await book(u);
      queue.failEnqueue = true;
      const lost = await queuedImport(u, b, people(1_001));
      expect((await status(u, b.id, lost)).status).toBe("queued");
      sent.length = 0;
      await sweep();
      expect(sent.filter((j) => j.importId === lost)).toEqual([]);
      await db.update(workbookImports).set({ updatedAt: ago(11) }).where(eq(workbookImports.id, lost));
      await sweep();
      expect(sent.filter((j) => j.importId === lost)).toEqual([{ importId: lost, workspaceId: u.workspaceId }]);
      await work(lost);
      expect((await status(u, b.id, lost)).status).toBe("completed");
    });

    it("gives up on one that has made no progress for hours", async () => {
      const u = await user();
      const b = await book(u);
      const id = await queuedImport(u, b, people(1_001));
      await db.update(workbookImports).set({ updatedAt: ago(11), confirmedAt: ago(6 * 60 + 1) }).where(eq(workbookImports.id, id));
      sent.length = 0;
      await sweep();
      expect(await status(u, b.id, id)).toMatchObject({ status: "failed", error: { code: "IMPORT_STALLED" } });
      expect(sent.filter((j) => j.importId === id)).toEqual([]);
      expect(await filesOf(id)).toEqual([]);
    });

    it("removes a file and writes a report that were left behind", async () => {
      const u = await user();
      const b = await book(u);
      const imp = await uploaded(u, b.id, "a\n1\n");
      // As left by a process that stopped between finishing and cleaning up.
      await db.insert(workbookImportIssues).values({ importId: imp.id, record: 1, line: 2, kind: "invalid", reason: "r", values: ["1"] });
      await db.update(workbookImports).set({ status: "failed", finishedAt: new Date(), preview: null }).where(eq(workbookImports.id, imp.id));
      await sweep();
      expect(await filesOf(imp.id)).toEqual(["report.csv"]);
      expect(await issuesOf(imp.id)).toEqual([]);
      expect((await recordOf(imp.id)).fileKey).toBeNull();
      expect((await report(u, b.id, imp.id))[1]).toBe('"2","Invalid value","r","1"');
    });
  });

  // ── Who may do what ────────────────────────────────────────────────────────

  describe("access", () => {
    it("lets a viewer follow imports and read reports, and nothing else", async () => {
      const owner = await user();
      const b = await book(owner);
      const done = await uploaded(owner, b.id, "a,b\n,\n");
      await confirm(owner, b.id, done.id, [{ header: 0, columnId: b.col.name }]);
      const waiting = await uploaded(owner, b.id, "a\n1\n");
      const viewer = await colleague(owner, ["enrichment:read"]);
      for (const p of ["", `/${done.id}`, `/${waiting.id}`, `/${done.id}/report`]) expect((await call(viewer, "GET", `/${b.id}/imports${p}`)).statusCode, p).toBe(200);
      const filesBefore = (await filesUnder(filesDir)).length;
      expect((await upload(viewer, b.id, "a\n1\n")).statusCode).toBe(403);
      expect((await confirm(viewer, b.id, waiting.id, [{ header: 0, columnId: b.col.name }])).statusCode).toBe(403);
      expect((await call(viewer, "DELETE", `/${b.id}/imports/${waiting.id}`)).statusCode).toBe(403);
      expect((await filesUnder(filesDir)).length).toBe(filesBefore);
      expect((await status(owner, b.id, waiting.id)).status).toBe("awaiting_confirmation");
      const nobody = await colleague(owner, []);
      for (const p of ["", `/${done.id}`, `/${done.id}/report`]) expect((await call(nobody, "GET", `/${b.id}/imports${p}`)).statusCode, p).toBe(403);
    });

    it("answers another workspace as if nothing were there", async () => {
      const [owner, other] = [await user(), await user()];
      const [theirs, mine] = [await book(owner), await book(other)];
      const imp = await uploaded(owner, theirs.id, "a,b\n,\n1,2\n");
      const done = await uploaded(owner, theirs.id, "a,b\n,\n");
      await confirm(owner, theirs.id, done.id, [{ header: 0, columnId: theirs.col.name }]);
      const filesBefore = (await filesUnder(filesDir)).length;
      const mapping = [{ header: 0, columnId: theirs.col.name }];
      const attempts = [
        await upload(other, theirs.id, "a\n1\n"),
        await call(other, "GET", `/${theirs.id}/imports`),
        // Their workbook, and my own workbook with their import's id.
        ...(await Promise.all(
          [theirs.id, mine.id].flatMap((wb) => [
            call(other, "GET", `/${wb}/imports/${imp.id}`),
            confirm(other, wb, imp.id, mapping),
            call(other, "DELETE", `/${wb}/imports/${imp.id}`),
            call(other, "GET", `/${wb}/imports/${done.id}/report`),
          ])
        )),
      ];
      for (const res of attempts) {
        expect(res.statusCode, res.body).toBe(404);
        expect(res.json().code).toBe("NOT_FOUND");
      }
      expect((await filesUnder(filesDir)).length).toBe(filesBefore);
      expect((await status(owner, theirs.id, imp.id)).status).toBe("awaiting_confirmation");
      expect((await call(other, "GET", `/${mine.id}/imports`)).json().data).toEqual([]);
    });

    it("needs somewhere to keep files in production", () => {
      expect(importStorage({ ...config, NODE_ENV: "production" })).toBeNull();
      expect(importStorage({ ...config, NODE_ENV: "production", EXPORTS_BUCKET: "bucket" })).not.toBeNull();
    });
  });
});
