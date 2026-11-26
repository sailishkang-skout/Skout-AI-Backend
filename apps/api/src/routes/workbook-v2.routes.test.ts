import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { invalidateWorkspaceAccess } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { remapColumnReferences } from "../services/workbook-v2.service.js";

/** WB2-011: one route test per operation, plus the row limit, permissions, the feature flag and isolation. */
const base = loadEnv();
const hasDatabase = Boolean(base.DATABASE_URL);
const URL_BASE = "/api/v1/workbooks-v2";
const MISSING = "00000000-0000-4000-8000-0000000000ff";
const DAY = 24 * 60 * 60 * 1000;
const { workbooks, workbookColumns, workbookRows, workbookCells, workbookRuns, workbookImports, workbookViews, workbookWebhooks, entitlements, auditLogs } = schema;

describe("remapColumnReferences", () => {
  const ids = new Map([
    ["aaaaaaaa-0000-4000-8000-000000000001", "bbbbbbbb-0000-4000-8000-000000000001"],
  ]);
  const [from, to] = [...ids][0]!;

  it("rewrites column ids in values, object keys, arrays and formula text, and leaves everything else", () => {
    const input = { inputs: { domain: from }, byColumn: { [from]: 1 }, list: [from, "x", 3, null, true], formula: `concat({{${from}}}, " ", {{${from}}})` };
    expect(remapColumnReferences(input, ids)).toEqual({ inputs: { domain: to }, byColumn: { [to]: 1 }, list: [to, "x", 3, null, true], formula: `concat({{${to}}}, " ", {{${to}}})` });
    expect(input.inputs.domain).toBe(from); // the source object is not changed
    expect(remapColumnReferences("unrelated", ids)).toBe("unrelated");
    expect(remapColumnReferences(null, ids)).toBeNull();
  });
});

describe.skipIf(!hasDatabase)("Workbooks V2 CRUD routes", () => {
  const { db, sql } = createDb(base.DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  const ADMIN = `wb2-crud-admin-${suffix}@test.com`;
  let n = 0;
  let app: Awaited<ReturnType<typeof buildApp>>;

  interface User {
    email: string;
    userId: string;
    workspaceId: string;
    ip: string;
    headers: Record<string, string>;
  }

  /** A stub user with their own workspace, Workbooks V2 switched on unless `flag` is false. */
  async function user(opts: { flag?: boolean } = {}): Promise<User> {
    n += 1;
    const email = `wb2-crud-${suffix}-${n}@test.com`;
    const ip = `10.${Math.floor(n / 250)}.${n % 250}.7`;
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

  /** A second person in `owner`'s workspace holding exactly one role (a system role, or a custom one with these permissions). */
  async function colleague(owner: User, role: { system: string } | { permissions: string[] }): Promise<User> {
    const other = await user();
    await db.insert(schema.workspaceMembers).values({ workspaceId: owner.workspaceId, userId: other.userId, role: "member" });
    await db.delete(schema.workspaceMemberRoles).where(and(eq(schema.workspaceMemberRoles.workspaceId, owner.workspaceId), eq(schema.workspaceMemberRoles.userId, other.userId)));
    let roleId: string;
    if ("system" in role) {
      const rows = await sql`select id from roles where key = ${role.system} and workspace_id is null limit 1`;
      roleId = rows[0]!.id as string;
    } else {
      const key = `custom-${suffix}-${++n}`;
      const [created] = await db.insert(schema.roles).values({ workspaceId: owner.workspaceId, key, name: key, description: "test", isSystem: false }).returning();
      roleId = created!.id;
      if (role.permissions.length) await db.insert(schema.rolePermissions).values(role.permissions.map((permissionKey) => ({ roleId, permissionKey })));
    }
    await db.insert(schema.workspaceMemberRoles).values({ workspaceId: owner.workspaceId, userId: other.userId, roleId });
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

  async function create(u: User, name = "Leads") {
    const res = await call(u, "POST", "", { name });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().data as { id: string; name: string; updatedAt: string };
  }

  /** Columns (the second refers to the first), `rows` rows with one cell per column, a run, an import, a view and a webhook. */
  async function fill(workbookId: string, rows: number) {
    const first = randomUUID();
    const second = randomUUID();
    await db.insert(workbookColumns).values([
      { id: second, workbookId, name: "Work email", type: "enrichment", operation: "find_email", position: 1, width: 220, config: { inputs: { domain: first }, template: `{{${first}}}` } },
      { id: first, workbookId, name: "Domain", type: "input", position: 0, frozen: true, hidden: false, width: 140 },
    ]);
    const inserted = rows
      ? await db
          .insert(workbookRows)
          .values(Array.from({ length: rows }, (_, i) => ({ workbookId, position: i, source: { type: "csv", file: "a.csv" }, prospectId: `p-${i}`, crmRef: { provider: "hubspot", id: String(i) }, suppressed: i === 1 })))
          .returning()
      : [];
    if (inserted.length) {
      await db.insert(workbookCells).values(
        inserted.flatMap((r, i) => [
          { workbookId, rowId: r.id, columnId: first, state: "found" as const, value: `site${i}.com` },
          { workbookId, rowId: r.id, columnId: second, state: "found" as const, value: `a${i}@site${i}.com`, confidence: 0.9, creditsCharged: 2, foundVia: "skout" as const, internalProvenance: { provider: "secret-managed-provider" } },
        ])
      );
    }
    await db.update(workbooks).set({ rowCount: rows }).where(eq(workbooks.id, workbookId));
    await db.insert(workbookRuns).values({ workbookId, columnId: second, scope: "all", status: "completed", creditsUsed: 4 });
    await db.insert(workbookImports).values({ workbookId, sourceType: "csv" });
    await db.insert(workbookViews).values({ workbookId, name: "Mine", hiddenColumns: [first] });
    await db.insert(workbookWebhooks).values({ workbookId, tokenHash: `hash-${workbookId}` });
    return { first, second, rows: inserted };
  }

  const stored = async (id: string) => (await db.select().from(workbooks).where(eq(workbooks.id, id)))[0];
  const total = async (u: User) => (await db.select().from(workbooks).where(eq(workbooks.workspaceId, u.workspaceId))).length;
  const childCount = async (table: string, id: string) => Number((await sql.unsafe(`select count(*)::int as n from ${table} where workbook_id = $1`, [id]))[0]!.n);
  const deletedAgo = (id: string, ms: number) => db.update(workbooks).set({ deletedAt: new Date(Date.now() - ms) }).where(eq(workbooks.id, id));

  beforeAll(async () => {
    app = await buildApp({ ...base, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, EARLY_ACCESS_GATE_ENABLED: "true", RATE_LIMIT_MAX: 10_000, PLATFORM_ADMIN_EMAILS: [ADMIN] });
  });
  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  // ── Create ──────────────────────────────────────────────────────────────────

  describe("POST /workbooks-v2 (create)", () => {
    it("creates a workbook for the caller's workspace, immediately usable, with creator and default row limit", async () => {
      const u = await user();
      const res = await call(u, "POST", "", { name: "  Q3 leads  " });
      expect(res.statusCode).toBe(201);
      const { data } = res.json();
      expect(data).toMatchObject({ name: "Q3 leads", rowCount: 0, rowLimit: 100_000, columnCount: 0, lastRun: null, columns: [], archivedSourceId: null, createdBy: { id: u.userId, email: u.email } });
      expect(data).not.toHaveProperty("status"); // no draft or active state
      const row = await stored(data.id);
      expect(row).toMatchObject({ workspaceId: u.workspaceId, createdBy: u.userId, rowLimit: 100_000, deletedAt: null });
      expect((await call(u, "GET", `/${data.id}`)).statusCode).toBe(200);
      expect((await call(u, "GET", "")).json().data.map((w: { id: string }) => w.id)).toEqual([data.id]);
    });

    it("stores the workspace's configured row limit", async () => {
      const u = await user();
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 250_000);
      const { id } = await create(u);
      expect((await stored(id))!.rowLimit).toBe(250_000);
      expect((await call(u, "GET", `/${id}`)).json().data.rowLimit).toBe(250_000);
    });

    it("falls back to 100,000 when the configured limit is not a valid non-negative integer", async () => {
      for (const bad of [-1, 1.5, "lots", {}, 3_000_000_000]) {
        const u = await user();
        await setEntitlement(u.workspaceId, "workbooks.row_limit", bad);
        const res = await call(u, "POST", "", { name: "x" });
        expect(res.json().data.rowLimit, JSON.stringify(bad)).toBe(100_000);
      }
    });

    it("rejects invalid payloads with 422 and creates nothing", async () => {
      const u = await user();
      const bad: unknown[] = [{}, { name: "" }, { name: "   " }, { name: "x".repeat(201) }, { name: 5 }, { name: null }, { name: "nul\u0000byte" }, []];
      for (const body of bad) {
        const res = await call(u, "POST", "", body);
        expect(res.statusCode, JSON.stringify(body)).toBe(422);
        expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
      }
      expect((await call(u, "POST", "", "{not json", {})).statusCode).toBe(400);
      expect(await total(u)).toBe(0);
    });

    it("accepts a name of exactly 200 characters", async () => {
      const u = await user();
      expect((await call(u, "POST", "", { name: "n".repeat(200) })).statusCode).toBe(201);
    });

    it("refuses server-owned fields, so a client cannot pick the workspace or get past the row limit", async () => {
      const u = await user();
      const victim = await user();
      for (const extra of [{ workspaceId: victim.workspaceId }, { rowLimit: 10_000_000 }, { rowCount: 500_000 }, { createdBy: victim.userId }, { status: "draft" }, { deletedAt: null }]) {
        const res = await call(u, "POST", "", { name: "x", ...extra });
        expect(res.statusCode, JSON.stringify(extra)).toBe(422);
      }
      // A workspace id in the query string is ignored: the session decides.
      const res = await call(u, "POST", `?workspaceId=${victim.workspaceId}`, { name: "mine" });
      expect(res.statusCode).toBe(201);
      expect((await stored(res.json().data.id))!.workspaceId).toBe(u.workspaceId);
      expect(await total(victim)).toBe(0);
    });

    it("replays one Idempotency-Key instead of creating twice, and refuses the key for a different body", async () => {
      const u = await user();
      const key = { "idempotency-key": `create-${randomUUID()}` };
      const one = await call(u, "POST", "", { name: "once" }, key);
      const two = await call(u, "POST", "", { name: "once" }, key);
      expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
      expect(two.json().data.id).toBe(one.json().data.id);
      expect(await total(u)).toBe(1);
      const other = await call(u, "POST", "", { name: "different" }, key);
      expect(other.statusCode).toBeGreaterThanOrEqual(400);
      expect(other.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(await total(u)).toBe(1);
    });

    it("without a key, two identical requests make two workbooks", async () => {
      const u = await user();
      await create(u, "same");
      await create(u, "same");
      expect(await total(u)).toBe(2);
    });

    it("two simultaneous requests with one key create exactly one workbook", async () => {
      const u = await user();
      const key = { "idempotency-key": `race-${randomUUID()}` };
      const results = await Promise.all([call(u, "POST", "", { name: "race" }, key), call(u, "POST", "", { name: "race" }, key)]);
      expect(results.map((r) => r.statusCode).filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.statusCode === 201 || r.statusCode === 409)).toBe(true);
      expect(await total(u)).toBe(1);
    });
  });

  // ── List ────────────────────────────────────────────────────────────────────

  describe("GET /workbooks-v2 (list)", () => {
    it("returns name, row count, column count, last run, creator and last edited, newest edit first", async () => {
      const u = await user();
      const older = await create(u, "Older");
      const newer = await create(u, "Newer");
      const { second } = await fill(older.id, 3);
      const [latest] = await db.insert(workbookRuns).values({ workbookId: older.id, columnId: second, scope: "failed", status: "running", createdAt: new Date(Date.now() + 60_000) }).returning();
      await db.update(workbooks).set({ updatedAt: new Date(Date.now() - DAY) }).where(eq(workbooks.id, older.id));

      const res = await call(u, "GET", "");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ total: 2, page: 1, pageSize: 25 });
      expect(body.data.map((w: { id: string }) => w.id)).toEqual([newer.id, older.id]);
      expect(body.data[1]).toMatchObject({
        name: "Older",
        rowCount: 3,
        columnCount: 2,
        rowLimit: 100_000,
        createdBy: { id: u.userId, email: u.email },
        lastRun: { id: latest!.id, columnId: second, status: "running" },
      });
      expect(body.data[1].updatedAt).toBeTruthy();
      expect(body.data[0]).toMatchObject({ name: "Newer", rowCount: 0, columnCount: 0, lastRun: null });
      expect(body.data[0]).not.toHaveProperty("columns");
    });

    it("lists only the caller's workspace and hides deleted workbooks", async () => {
      const a = await user();
      const b = await user();
      const keep = await create(a, "keep");
      const gone = await create(a, "gone");
      await create(b, "theirs");
      await call(a, "DELETE", `/${gone.id}`);
      const res = await call(a, "GET", `?workspaceId=${b.workspaceId}`);
      expect(res.json().data.map((w: { id: string }) => w.id)).toEqual([keep.id]);
      expect(res.json().total).toBe(1);
    });

    it("paginates and rejects invalid paging", async () => {
      const u = await user();
      for (const name of ["a", "b", "c"]) await create(u, name);
      const p1 = (await call(u, "GET", "?page=1&pageSize=2")).json();
      const p2 = (await call(u, "GET", "?page=2&pageSize=2")).json();
      expect([p1.data.length, p2.data.length, p1.total, p2.total]).toEqual([2, 1, 3, 3]);
      expect(new Set([...p1.data, ...p2.data].map((w: { id: string }) => w.id)).size).toBe(3);
      for (const q of ["?page=0", "?pageSize=0", "?pageSize=101", "?page=x"]) expect((await call(u, "GET", q)).statusCode, q).toBe(422);
      expect((await call(u, "GET", "?page=50")).json().data).toEqual([]);
    });

    it("returns an empty list for a workspace with none", async () => {
      const u = await user();
      expect((await call(u, "GET", "")).json()).toMatchObject({ data: [], total: 0 });
    });
  });

  // ── Get ─────────────────────────────────────────────────────────────────────

  describe("GET /workbooks-v2/:id (get)", () => {
    it("returns the metadata and the columns in position order, and no cell data", async () => {
      const u = await user();
      const wb = await create(u);
      const { first, second } = await fill(wb.id, 2);
      const res = await call(u, "GET", `/${wb.id}`);
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data).toMatchObject({ id: wb.id, name: "Leads", rowCount: 2, columnCount: 2 });
      expect(data.columns.map((c: { id: string }) => c.id)).toEqual([first, second]);
      expect(data.columns[0]).toEqual({ id: first, name: "Domain", type: "input", operation: null, config: {}, position: 0, width: 140, hidden: false, frozen: true });
      expect(res.body).not.toContain("secret-managed-provider");
      expect(res.body).not.toContain("internalProvenance");
    });

    it("answers 422 for a malformed id and 404 for a missing one", async () => {
      const u = await user();
      expect((await call(u, "GET", "/not-a-uuid")).statusCode).toBe(422);
      const res = await call(u, "GET", `/${MISSING}`);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ ok: false, code: "NOT_FOUND", message: "Workbook not found" });
      expect(res.json().request_id).toBeTruthy();
    });
  });

  // ── Rename ──────────────────────────────────────────────────────────────────

  describe("PATCH /workbooks-v2/:id (rename)", () => {
    it("renames, trims, and moves last edited forward", async () => {
      const u = await user();
      const wb = await create(u);
      await db.update(workbooks).set({ updatedAt: new Date(Date.now() - DAY) }).where(eq(workbooks.id, wb.id));
      const before = (await stored(wb.id))!.updatedAt;
      const res = await call(u, "PATCH", `/${wb.id}`, { name: "  Renamed " });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ id: wb.id, name: "Renamed" });
      expect((await stored(wb.id))!.updatedAt.getTime()).toBeGreaterThan(before.getTime());
    });

    it("rejects invalid input and leaves the name alone", async () => {
      const u = await user();
      const wb = await create(u, "unchanged");
      for (const body of [{}, { name: "" }, { name: "x".repeat(201) }, { name: "y", rowLimit: 9 }, { name: "z", workspaceId: MISSING }]) {
        expect((await call(u, "PATCH", `/${wb.id}`, body)).statusCode, JSON.stringify(body)).toBe(422);
      }
      expect((await stored(wb.id))!.name).toBe("unchanged");
      expect((await call(u, "PATCH", "/123", { name: "a" })).statusCode).toBe(422);
      expect((await call(u, "PATCH", `/${MISSING}`, { name: "a" })).statusCode).toBe(404);
    });
  });

  // ── Duplicate ───────────────────────────────────────────────────────────────

  describe("POST /workbooks-v2/:id/duplicate", () => {
    it("structure only: a new workbook with its own columns and nothing else", async () => {
      const u = await user();
      const source = await create(u, "Source");
      const ids = await fill(source.id, 3);
      const res = await call(u, "POST", `/${source.id}/duplicate`, { includeRows: false });
      expect(res.statusCode, res.body).toBe(201);
      const copy = res.json().data;
      expect(copy.id).not.toBe(source.id);
      expect(copy).toMatchObject({ name: "Source (copy)", rowCount: 0, columnCount: 2, lastRun: null, createdBy: { id: u.userId } });
      const [domain, email] = copy.columns;
      expect([domain.id, email.id]).not.toContain(ids.first);
      expect([domain.id, email.id]).not.toContain(ids.second);
      expect(domain).toMatchObject({ name: "Domain", type: "input", position: 0, frozen: true, width: 140 });
      expect(email).toMatchObject({ name: "Work email", type: "enrichment", operation: "find_email", position: 1, width: 220 });
      // References between columns point at the copy's own columns.
      expect(email.config).toEqual({ inputs: { domain: domain.id }, template: `{{${domain.id}}}` });
      for (const t of ["workbook_rows", "workbook_cells", "workbook_runs", "workbook_imports", "workbook_views", "workbook_webhooks"]) expect(await childCount(t, copy.id), t).toBe(0);
      expect(await childCount("workbook_rows", source.id)).toBe(3);
    });

    it("with rows: copies rows and cell values under new ids, without runs, imports, views, webhooks or charges", async () => {
      const u = await user();
      const source = await create(u, "Source");
      const ids = await fill(source.id, 3);
      const res = await call(u, "POST", `/${source.id}/duplicate`, { includeRows: true, name: "With rows" });
      expect(res.statusCode, res.body).toBe(201);
      const copy = res.json().data;
      expect(copy).toMatchObject({ name: "With rows", rowCount: 3, columnCount: 2, lastRun: null });
      expect(res.body).not.toContain("secret-managed-provider");
      for (const t of ["workbook_runs", "workbook_imports", "workbook_views", "workbook_webhooks"]) expect(await childCount(t, copy.id), t).toBe(0);

      const rows = await db.select().from(workbookRows).where(eq(workbookRows.workbookId, copy.id)).orderBy(asc(workbookRows.position));
      expect(rows.map((r) => [r.position, r.prospectId, r.suppressed])).toEqual([[0, "p-0", false], [1, "p-1", true], [2, "p-2", false]]);
      expect(rows[0]).toMatchObject({ source: { type: "csv", file: "a.csv" }, crmRef: { provider: "hubspot", id: "0" } });
      expect(rows.some((r) => ids.rows.some((o) => o.id === r.id))).toBe(false);

      const cells = await db.select().from(workbookCells).where(eq(workbookCells.workbookId, copy.id));
      expect(cells).toHaveLength(6);
      const emailColumn = copy.columns[1].id;
      for (const [i, row] of rows.entries()) {
        const cell = cells.find((c) => c.rowId === row.id && c.columnId === emailColumn)!;
        // Each value follows its own row; provenance stays server-side; nothing is billed to the copy.
        expect(cell).toMatchObject({ value: `a${i}@site${i}.com`, state: "found", foundVia: "skout", creditsCharged: 0, internalProvenance: { provider: "secret-managed-provider" } });
      }
      // The source is untouched, charges included.
      const sourceCells = await db.select().from(workbookCells).where(eq(workbookCells.workbookId, source.id));
      expect(sourceCells).toHaveLength(6);
      expect(sourceCells.reduce((sum, c) => sum + c.creditsCharged, 0)).toBe(6);
      expect(await childCount("workbook_runs", source.id)).toBe(1);
    });

    it("the copy is independent: changing or deleting it leaves the source as it was", async () => {
      const u = await user();
      const source = await create(u, "Original");
      await fill(source.id, 2);
      const copy = (await call(u, "POST", `/${source.id}/duplicate`, { includeRows: true })).json().data;
      await call(u, "PATCH", `/${copy.id}`, { name: "Changed" });
      await db.update(workbookCells).set({ value: "edited" }).where(eq(workbookCells.workbookId, copy.id));
      await db.delete(workbooks).where(eq(workbooks.id, copy.id));
      expect((await stored(source.id))!.name).toBe("Original");
      const cells = await db.select().from(workbookCells).where(eq(workbookCells.workbookId, source.id));
      expect(cells).toHaveLength(4);
      expect(cells.some((c) => c.value === "edited")).toBe(false);
    });

    it("leaves out cells that are still queued or running, since the copy has no run to finish them", async () => {
      const u = await user();
      const source = await create(u);
      const ids = await fill(source.id, 3);
      const set = (row: number, state: "queued" | "running" | "error") =>
        db.update(workbookCells).set({ state, value: null }).where(and(eq(workbookCells.workbookId, source.id), eq(workbookCells.rowId, ids.rows[row]!.id), eq(workbookCells.columnId, ids.second)));
      await set(0, "queued");
      await set(1, "running");
      await set(2, "error");
      const copy = (await call(u, "POST", `/${source.id}/duplicate`, { includeRows: true })).json().data;
      const cells = await db.select().from(workbookCells).where(eq(workbookCells.workbookId, copy.id));
      expect(cells.map((c) => c.state).sort()).toEqual(["error", "found", "found", "found"]);
      expect(copy.rowCount).toBe(3);
    });

    it("works for a workbook with no columns or rows, and with columns but no rows", async () => {
      const u = await user();
      const empty = await create(u, "Empty");
      const a = await call(u, "POST", `/${empty.id}/duplicate`, { includeRows: true });
      expect(a.statusCode).toBe(201);
      expect(a.json().data).toMatchObject({ rowCount: 0, columnCount: 0 });
      const columnsOnly = await create(u, "Columns");
      await fill(columnsOnly.id, 0);
      const b = await call(u, "POST", `/${columnsOnly.id}/duplicate`, { includeRows: true });
      expect(b.json().data).toMatchObject({ rowCount: 0, columnCount: 2 });
    });

    it("keeps a long name within the limit", async () => {
      const u = await user();
      const wb = await create(u, "L".repeat(200));
      const copy = (await call(u, "POST", `/${wb.id}/duplicate`, { includeRows: false })).json().data;
      expect(copy.name).toHaveLength(200);
      expect(copy.name.endsWith(" (copy)")).toBe(true);
    });

    it("requires includeRows, rejects unknown fields and bad ids", async () => {
      const u = await user();
      const wb = await create(u);
      for (const body of [{}, { includeRows: "yes" }, { includeRows: true, rowLimit: 9 }, { includeRows: true, name: "" }, { includeRows: false, workspaceId: MISSING }]) {
        expect((await call(u, "POST", `/${wb.id}/duplicate`, body)).statusCode, JSON.stringify(body)).toBe(422);
      }
      expect((await call(u, "POST", "/nope/duplicate", { includeRows: false })).statusCode).toBe(422);
      expect((await call(u, "POST", `/${MISSING}/duplicate`, { includeRows: false })).statusCode).toBe(404);
      expect(await total(u)).toBe(1);
    });

    it("replays one Idempotency-Key instead of copying twice", async () => {
      const u = await user();
      const wb = await create(u);
      await fill(wb.id, 2);
      const key = { "idempotency-key": `dup-${randomUUID()}` };
      const one = await call(u, "POST", `/${wb.id}/duplicate`, { includeRows: true }, key);
      const two = await call(u, "POST", `/${wb.id}/duplicate`, { includeRows: true }, key);
      expect(two.json().data.id).toBe(one.json().data.id);
      expect(await total(u)).toBe(2);
    });

    it("is all or nothing: a failure while copying cells leaves no new workbook", async () => {
      const u = await user();
      const wb = await create(u);
      const ids = await fill(wb.id, 2);
      const marker = `explode-${suffix}`;
      await db.update(workbookCells).set({ value: marker }).where(and(eq(workbookCells.workbookId, wb.id), eq(workbookCells.rowId, ids.rows[1]!.id), eq(workbookCells.columnId, ids.first)));
      await sql.unsafe(`create or replace function wb2_test_explode_${suffix}() returns trigger language plpgsql as $$ begin if new.value = to_jsonb('${marker}'::text) then raise exception 'boom'; end if; return new; end $$`);
      await sql.unsafe(`create trigger wb2_test_explode_${suffix} before insert on workbook_cells for each row execute function wb2_test_explode_${suffix}()`);
      try {
        const res = await call(u, "POST", `/${wb.id}/duplicate`, { includeRows: true });
        expect(res.statusCode).toBe(500);
        expect(res.body).not.toContain("boom"); // database errors are never returned to the client
        expect(await total(u)).toBe(1);
        const [orphans] = await sql`select count(*)::int as n from workbook_rows r join workbooks w on w.id = r.workbook_id where w.workspace_id = ${u.workspaceId} and w.id <> ${wb.id}`;
        expect(orphans!.n).toBe(0);
      } finally {
        await sql.unsafe(`drop trigger if exists wb2_test_explode_${suffix} on workbook_cells`);
        await sql.unsafe(`drop function if exists wb2_test_explode_${suffix}()`);
      }
    });

    it("limits how often one caller can start a copy", async () => {
      const u = await user();
      const wb = await create(u);
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await call(u, "POST", `/${wb.id}/duplicate`, { includeRows: false })).statusCode);
      expect(statuses.slice(0, 10)).toEqual(Array(10).fill(201));
      expect(statuses[10]).toBe(429);
    });
  });

  // ── Row limit ───────────────────────────────────────────────────────────────

  describe("workspace row limit", () => {
    it("rejects a copy with rows over the limit, with a consistent error and nothing created", async () => {
      const u = await user();
      const wb = await create(u);
      await fill(wb.id, 3);
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 2);
      const res = await call(u, "POST", `/${wb.id}/duplicate`, { includeRows: true });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ ok: false, code: "ROW_LIMIT_EXCEEDED", error: "ROW_LIMIT_EXCEEDED", details: { limit: 2, rows: 3 }, retryable: false });
      expect(res.json().message).toContain("2 rows per workbook");
      expect(await total(u)).toBe(1);
    });

    it("allows exactly the limit, and rejects one more", async () => {
      const u = await user();
      const wb = await create(u);
      await fill(wb.id, 3);
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 3);
      expect((await call(u, "POST", `/${wb.id}/duplicate`, { includeRows: true })).statusCode).toBe(201);
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 2);
      expect((await call(u, "POST", `/${wb.id}/duplicate`, { includeRows: true })).statusCode).toBe(422);
    });

    it("counts the real rows, not the stored row_count", async () => {
      const u = await user();
      const wb = await create(u);
      await fill(wb.id, 3);
      await db.update(workbooks).set({ rowCount: 0, rowLimit: 100_000 }).where(eq(workbooks.id, wb.id));
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 1);
      const res = await call(u, "POST", `/${wb.id}/duplicate`, { includeRows: true });
      expect(res.json()).toMatchObject({ code: "ROW_LIMIT_EXCEEDED", details: { rows: 3 } });
    });

    it("still allows a structure-only copy of a workbook that is over the limit, and creating empty workbooks", async () => {
      const u = await user();
      const wb = await create(u);
      await fill(wb.id, 3);
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 0);
      expect((await call(u, "POST", `/${wb.id}/duplicate`, { includeRows: false })).statusCode).toBe(201);
      expect((await call(u, "POST", "", { name: "empty" })).json().data.rowLimit).toBe(0);
    });

    it("uses a raised limit for a larger customer", async () => {
      const u = await user();
      const wb = await create(u);
      await fill(wb.id, 3);
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 2);
      expect((await call(u, "POST", `/${wb.id}/duplicate`, { includeRows: true })).statusCode).toBe(422);
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 500_000);
      const res = await call(u, "POST", `/${wb.id}/duplicate`, { includeRows: true });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.rowLimit).toBe(500_000);
    });

    it("is set per workspace by a Skout platform admin, and applies at once to that workspace only", async () => {
      const customer = await user();
      const other = await user();
      await app.inject({ method: "GET", url: "/api/v1/me", headers: { "x-stub-user-email": ADMIN }, remoteAddress: "10.201.0.1" });
      const set = await app.inject({
        method: "PUT",
        url: `/api/v1/admin/workspaces/${customer.workspaceId}/entitlements/workbooks.row_limit`,
        remoteAddress: "10.201.0.1",
        headers: { "x-stub-user-email": ADMIN, "content-type": "application/json" },
        payload: { value: 7 },
      });
      expect(set.statusCode, set.body).toBe(200);
      expect((await call(customer, "POST", "", { name: "limited" })).json().data.rowLimit).toBe(7);
      expect((await call(other, "POST", "", { name: "default" })).json().data.rowLimit).toBe(100_000);
    });

    it("cannot be raised by the workspace itself: the entitlement is managed by Skout", async () => {
      const u = await user();
      const res = await app.inject({ method: "PUT", url: "/api/v1/entitlements/workbooks.row_limit", remoteAddress: u.ip, headers: { ...u.headers, "content-type": "application/json" }, payload: { value: 10_000_000 } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "platform_managed_entitlement" });
      const removed = await app.inject({ method: "DELETE", url: "/api/v1/entitlements/workbooks.row_limit", remoteAddress: u.ip, headers: u.headers });
      expect(removed.statusCode).toBe(403);
      expect(await db.select().from(entitlements).where(and(eq(entitlements.workspaceId, u.workspaceId), eq(entitlements.key, "workbooks.row_limit")))).toHaveLength(0);
    });
  });

  // ── Delete and restore ──────────────────────────────────────────────────────

  describe("DELETE /workbooks-v2/:id (soft delete)", () => {
    it("marks the workbook deleted, keeps all its data, and records who did it", async () => {
      const u = await user();
      const wb = await create(u);
      await fill(wb.id, 2);
      const updatedAt = (await stored(wb.id))!.updatedAt;
      const res = await call(u, "DELETE", `/${wb.id}`);
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.id).toBe(wb.id);
      expect(new Date(data.restorableUntil).getTime() - new Date(data.deletedAt).getTime()).toBe(30 * DAY);
      const row = await stored(wb.id);
      expect(row!.deletedAt).not.toBeNull();
      expect(row!.updatedAt).toEqual(updatedAt);
      expect(await childCount("workbook_rows", wb.id)).toBe(2);
      expect(await childCount("workbook_cells", wb.id)).toBe(4);
      const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.workspaceId, u.workspaceId), eq(auditLogs.entityId, wb.id)));
      expect(audit.map((a) => [a.action, a.actorId])).toEqual([["workbook.delete", u.userId]]);
    });

    it("a deleted workbook is gone from list, get, rename, duplicate and a second delete", async () => {
      const u = await user();
      const wb = await create(u);
      await call(u, "DELETE", `/${wb.id}`);
      const deletedAt = (await stored(wb.id))!.deletedAt;
      expect((await call(u, "GET", "")).json().data).toEqual([]);
      const attempts = [
        await call(u, "GET", `/${wb.id}`),
        await call(u, "PATCH", `/${wb.id}`, { name: "back" }),
        await call(u, "POST", `/${wb.id}/duplicate`, { includeRows: false }),
        await call(u, "DELETE", `/${wb.id}`),
      ];
      for (const res of attempts) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ code: "NOT_FOUND", message: "Workbook not found" });
      }
      // The second delete did not restart the 30-day clock.
      expect((await stored(wb.id))!.deletedAt).toEqual(deletedAt);
    });

    it("answers 422 for a malformed id and 404 for a missing one", async () => {
      const u = await user();
      expect((await call(u, "DELETE", "/x")).statusCode).toBe(422);
      expect((await call(u, "DELETE", `/${MISSING}`)).statusCode).toBe(404);
    });
  });

  describe("POST /workbooks-v2/:id/restore", () => {
    it("restores within 30 days, with its data and its last-edited time", async () => {
      const u = await user();
      const wb = await create(u);
      await fill(wb.id, 2);
      const updatedAt = (await stored(wb.id))!.updatedAt;
      await call(u, "DELETE", `/${wb.id}`);
      await deletedAgo(wb.id, 29 * DAY);
      const res = await call(u, "POST", `/${wb.id}/restore`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toMatchObject({ id: wb.id, rowCount: 2, columnCount: 2, updatedAt: updatedAt.toISOString() });
      expect((await stored(wb.id))!.deletedAt).toBeNull();
      expect((await call(u, "GET", "")).json().data.map((w: { id: string }) => w.id)).toEqual([wb.id]);
      const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.workspaceId, u.workspaceId), eq(auditLogs.entityId, wb.id)));
      expect(audit.map((a) => a.action).sort()).toEqual(["workbook.delete", "workbook.restore"]);
    });

    it("the window is exactly 30 days: a minute inside restores, a minute past is refused", async () => {
      const u = await user();
      const inside = await create(u, "inside");
      const outside = await create(u, "outside");
      await deletedAgo(inside.id, 30 * DAY - 60_000);
      await deletedAgo(outside.id, 30 * DAY + 60_000);
      expect((await call(u, "POST", `/${inside.id}/restore`)).statusCode).toBe(200);
      expect((await call(u, "POST", `/${outside.id}/restore`)).statusCode).toBe(410);
    });

    it("refuses after 30 days with 410, and the workbook stays deleted and hidden", async () => {
      const u = await user();
      const wb = await create(u);
      await deletedAgo(wb.id, 31 * DAY);
      const res = await call(u, "POST", `/${wb.id}/restore`);
      expect(res.statusCode).toBe(410);
      expect(res.json()).toMatchObject({ code: "RESTORE_WINDOW_EXPIRED", ok: false });
      expect(res.json().details.restorableUntil).toBeTruthy();
      expect((await stored(wb.id))!.deletedAt).not.toBeNull();
      expect((await call(u, "GET", `/${wb.id}`)).statusCode).toBe(404);
      expect((await call(u, "GET", "")).json().data).toEqual([]);
    });

    it("refuses a workbook that is not deleted, a second restore, a missing id and a malformed id", async () => {
      const u = await user();
      const wb = await create(u);
      const live = await call(u, "POST", `/${wb.id}/restore`);
      expect(live.statusCode).toBe(409);
      expect(live.json()).toMatchObject({ code: "WORKBOOK_NOT_DELETED" });
      await call(u, "DELETE", `/${wb.id}`);
      expect((await call(u, "POST", `/${wb.id}/restore`)).statusCode).toBe(200);
      expect((await call(u, "POST", `/${wb.id}/restore`)).statusCode).toBe(409);
      expect((await call(u, "POST", `/${MISSING}/restore`)).statusCode).toBe(404);
      expect((await call(u, "POST", "/abc/restore")).statusCode).toBe(422);
    });
  });

  // ── Isolation, permissions and the feature flag ─────────────────────────────

  describe("workspace isolation", () => {
    it("every route answers 404 for another workspace's workbook and changes nothing", async () => {
      const owner = await user();
      const intruder = await user();
      const live = await create(owner, "private");
      await fill(live.id, 2);
      const deleted = await create(owner, "binned");
      await call(owner, "DELETE", `/${deleted.id}`);
      const before = await stored(live.id);
      const beforeDeleted = await stored(deleted.id);

      const attempts: Array<[Method, string, unknown?]> = [
        ["GET", `/${live.id}`],
        ["PATCH", `/${live.id}`, { name: "stolen" }],
        ["POST", `/${live.id}/duplicate`, { includeRows: true }],
        ["POST", `/${live.id}/duplicate`, { includeRows: false }],
        ["DELETE", `/${live.id}`],
        ["POST", `/${live.id}/restore`],
        ["POST", `/${deleted.id}/restore`],
        ["GET", `/${deleted.id}`],
      ];
      for (const [method, path, body] of attempts) {
        const res = await call(intruder, method, path, body);
        expect(res.statusCode, `${method} ${path}`).toBe(404);
        expect(res.body).not.toContain("private");
      }
      expect((await call(intruder, "GET", "")).json().data).toEqual([]);
      expect(await stored(live.id)).toEqual(before);
      expect(await stored(deleted.id)).toEqual(beforeDeleted);
      expect(await total(intruder)).toBe(0);
      expect(await total(owner)).toBe(2);
    });

    it("naming another workspace in the header is refused unless the caller belongs to it", async () => {
      const owner = await user();
      const intruder = await user();
      const wb = await create(owner);
      const header = { "x-workspace-id": owner.workspaceId };
      for (const [method, path, body] of [["GET", ""], ["GET", `/${wb.id}`], ["DELETE", `/${wb.id}`], ["POST", "", { name: "x" }]] as Array<[Method, string, unknown?]>) {
        expect((await call(intruder, method, path, body, header)).statusCode, `${method} ${path}`).toBe(403);
      }
      expect((await stored(wb.id))!.deletedAt).toBeNull();
      expect(await total(owner)).toBe(1);
    });
  });

  describe("permissions", () => {
    it("a member can view, create, rename, duplicate, delete and restore", async () => {
      const owner = await user();
      const member = await colleague(owner, { system: "member" });
      const wb = await create(member, "by member");
      expect((await stored(wb.id))!).toMatchObject({ workspaceId: owner.workspaceId, createdBy: member.userId });
      expect((await call(member, "PATCH", `/${wb.id}`, { name: "renamed" })).statusCode).toBe(200);
      expect((await call(member, "POST", `/${wb.id}/duplicate`, { includeRows: false })).statusCode).toBe(201);
      expect((await call(member, "DELETE", `/${wb.id}`)).statusCode).toBe(200);
      expect((await call(member, "POST", `/${wb.id}/restore`)).statusCode).toBe(200);
      expect((await call(owner, "GET", `/${wb.id}`)).statusCode).toBe(200);
    });

    it("a read-only role can list and get but not change anything", async () => {
      const owner = await user();
      const wb = await create(owner, "read only");
      const reader = await colleague(owner, { permissions: ["enrichment:read"] });
      expect((await call(reader, "GET", "")).statusCode).toBe(200);
      expect((await call(reader, "GET", `/${wb.id}`)).statusCode).toBe(200);
      const writes: Array<[Method, string, unknown?]> = [["POST", "", { name: "x" }], ["PATCH", `/${wb.id}`, { name: "x" }], ["POST", `/${wb.id}/duplicate`, { includeRows: false }], ["DELETE", `/${wb.id}`], ["POST", `/${wb.id}/restore`]];
      for (const [method, path, body] of writes) expect((await call(reader, method, path, body)).statusCode, `${method} ${path}`).toBe(403);
      expect(await total(owner)).toBe(1);
      expect((await stored(wb.id))!).toMatchObject({ name: "read only", deletedAt: null });
    });

    it("someone without enrichment permissions gets nothing, not even an idempotent replay", async () => {
      const owner = await user();
      const key = { "idempotency-key": `perm-${randomUUID()}` };
      expect((await call(owner, "POST", "", { name: "secret plan" }, key)).statusCode).toBe(201);
      const outsider = await colleague(owner, { permissions: [] });
      expect((await call(outsider, "GET", "")).statusCode).toBe(403);
      const replay = await call(outsider, "POST", "", { name: "secret plan" }, key);
      expect(replay.statusCode).toBe(403);
      expect(replay.body).not.toContain("secret plan");
    });

    it("requires a signed-in user", async () => {
      const res = await app.inject({ method: "GET", url: URL_BASE, headers: { authorization: "Bearer nonsense" }, remoteAddress: "10.200.0.1" });
      expect([401, 403]).toContain(res.statusCode);
    });
  });

  describe("WORKBOOKS_V2 feature flag", () => {
    it("every route is refused for a workspace that does not have it, and nothing happens", async () => {
      const on = await user();
      const wb = await create(on);
      const off = await user({ flag: false });
      const routes: Array<[Method, string, unknown?]> = [["GET", ""], ["POST", "", { name: "x" }], ["GET", `/${wb.id}`], ["PATCH", `/${wb.id}`, { name: "x" }], ["POST", `/${wb.id}/duplicate`, { includeRows: false }], ["DELETE", `/${wb.id}`], ["POST", `/${wb.id}/restore`]];
      for (const [method, path, body] of routes) {
        const res = await call(off, method, path, body);
        expect(res.statusCode, `${method} ${path}`).toBe(403);
        expect(res.json()).toMatchObject({ code: "feature_disabled", feature: "workbooks_v2" });
      }
      expect(await total(off)).toBe(0);
    });
  });

  it("does not touch the legacy workbook API", async () => {
    const u = await user();
    await create(u, "v2 only");
    const res = await app.inject({ method: "GET", url: "/api/v1/workbooks", headers: u.headers, remoteAddress: u.ip });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });
});
