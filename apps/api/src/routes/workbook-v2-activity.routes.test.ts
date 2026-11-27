import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { createDb, postCreditTransaction, schema } from "@skout/db";
import { invalidateWorkspaceAccess, recordPrivilegedAction } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { withFailingCellInserts } from "../test/failing-cell-inserts.js";
import {
  recordCrmPush,
  recordExport,
  recordRunFinished,
  recordRunStarted,
  workbookRunLedgerReference,
  type CrmPushResult,
  type ExportReport,
} from "../services/workbook-activity.service.js";

/** WB2-016: what a workbook's activity log records, and who may read it. */
const base = loadEnv();
const hasDatabase = Boolean(base.DATABASE_URL);
const URL_BASE = "/api/v1/workbooks-v2";
const MISSING = "00000000-0000-4000-8000-0000000000ff";
const { entitlements, auditLogs, workbooks, workbookColumns, workbookRows, workbookRuns, crmConnections } = schema;

interface Event {
  id: string;
  type: string;
  occurredAt: string;
  actor: { id: string; name: string | null; email: string } | null;
  details: Record<string, any>;
}

describe.skipIf(!hasDatabase)("Workbooks V2 activity log", () => {
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
    const email = `wb2-act-${suffix}-${n}@test.com`;
    const ip = `14.${Math.floor(n / 250)}.${n % 250}.7`;
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

  async function colleague(owner: User, permissions: string[]): Promise<User> {
    const other = await user();
    const { workspaceMembers, workspaceMemberRoles, roles, rolePermissions } = schema;
    await db.insert(workspaceMembers).values({ workspaceId: owner.workspaceId, userId: other.userId, role: "member" });
    await db.delete(workspaceMemberRoles).where(and(eq(workspaceMemberRoles.workspaceId, owner.workspaceId), eq(workspaceMemberRoles.userId, other.userId)));
    const key = `act-${suffix}-${++n}`;
    const [role] = await db.insert(roles).values({ workspaceId: owner.workspaceId, key, name: key, description: "test", isSystem: false }).returning();
    if (permissions.length) await db.insert(rolePermissions).values(permissions.map((permissionKey) => ({ roleId: role!.id, permissionKey })));
    await db.insert(workspaceMemberRoles).values({ workspaceId: owner.workspaceId, userId: other.userId, roleId: role!.id });
    return { ...other, workspaceId: owner.workspaceId, headers: { ...other.headers, "x-workspace-id": owner.workspaceId } };
  }

  type Method = "GET" | "POST" | "PATCH" | "DELETE";
  const call = (u: User, method: Method, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url: `${URL_BASE}${path}`,
      remoteAddress: u.ip,
      headers: { ...u.headers, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });

  /** A call that must succeed. */
  async function ok(u: User, method: Method, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await call(u, method, path, body, headers);
    expect(res.statusCode, `${method} ${path} ${res.body}`).toBeLessThan(300);
    return res.json();
  }

  const book = async (u: User, name = "Activity") => (await ok(u, "POST", "", { name })).data.id as string;
  const column = async (u: User, wb: string, body: Record<string, unknown>) => (await ok(u, "POST", `/${wb}/columns`, body)).data.id as string;
  const input = (u: User, wb: string, name = "Company") => column(u, wb, { name, type: "input" });

  /** The whole feed, newest first, read page by page. */
  async function feed(u: User, wb: string): Promise<Event[]> {
    const all: Event[] = [];
    let cursor: string | null = null;
    do {
      const page = await ok(u, "GET", `/${wb}/activity?limit=100${cursor ? `&cursor=${cursor}` : ""}`);
      all.push(...(page.data as Event[]));
      cursor = page.nextCursor;
    } while (cursor);
    return all;
  }
  /** Events after the first `since` ones, oldest first, without ids and times. */
  async function newEvents(u: User, wb: string, since: number) {
    const all = await feed(u, wb);
    return all
      .slice(0, all.length - since)
      .reverse()
      .map(({ type, details }) => ({ type, details }));
  }
  const records = (wb: string) => db.select().from(auditLogs).where(eq(auditLogs.entityId, wb)).orderBy(asc(auditLogs.createdAt), asc(auditLogs.id));

  beforeAll(async () => {
    app = await buildApp({ ...base, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, EARLY_ACCESS_GATE_ENABLED: "true", RATE_LIMIT_MAX: 10_000, PLATFORM_ADMIN_EMAILS: [] });
  });
  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  // ── Rows ────────────────────────────────────────────────────────────────────

  describe("rows added", () => {
    it("records a single added row with the person, the source, the count and the time", async () => {
      const u = await user();
      const wb = await book(u);
      const col = await input(u, wb);
      const before = Date.now();
      await ok(u, "POST", `/${wb}/rows`, { cells: { [col]: "Acme" } });
      const [event] = await feed(u, wb);
      expect(event).toMatchObject({ type: "rows.added", actor: { id: u.userId, email: u.email }, details: { source: "manual", rows: 1, rowCount: 1 } });
      expect(Date.parse(event!.occurredAt)).toBeGreaterThanOrEqual(before - 5);
      expect(Date.parse(event!.occurredAt)).toBeLessThanOrEqual(Date.now() + 5);
      const [stored] = (await records(wb)).filter((r) => r.action === "workbook.rows.added");
      expect(stored).toMatchObject({ workspaceId: u.workspaceId, actorId: u.userId, actorType: "user", entityType: "workbook", entityId: wb, sourceChannel: "api" });
    });

    it("records one event for each source in a request, with its count", async () => {
      const u = await user();
      const wb = await book(u);
      const sources = ["csv", "csv", "csv", "list", "list", "hubspot", "webhook", "paste"];
      await ok(u, "POST", `/${wb}/rows/bulk`, { rows: [...sources.map((type) => ({ source: { type } })), {}] });
      const events = await feed(u, wb);
      expect(events.map((e) => [e.details.source, e.details.rows]).sort()).toEqual(
        [["csv", 3], ["hubspot", 1], ["list", 2], ["manual", 1], ["paste", 1], ["webhook", 1]].sort()
      );
      expect(events.every((e) => e.type === "rows.added" && e.details.rowCount === 9 && e.actor!.id === u.userId)).toBe(true);
    });

    it("counts the smallest sources together when a request names very many", async () => {
      const u = await user();
      const wb = await book(u);
      const rows = Array.from({ length: 60 }, (_, i) => ({ source: { type: i < 10 ? "csv" : `kind_${i}` } }));
      await ok(u, "POST", `/${wb}/rows/bulk`, { rows });
      const events = await feed(u, wb);
      expect(events).toHaveLength(20);
      expect(events.reduce((sum, e) => sum + e.details.rows, 0)).toBe(60);
      expect(events.find((e) => e.details.source === "csv")!.details.rows).toBe(10);
      expect(events.find((e) => e.details.source === "other")!.details.rows).toBe(32);
    });

    it("records only the source's type, never the rest of what was sent with the row", async () => {
      const u = await user();
      const wb = await book(u);
      const col = await input(u, wb);
      await ok(u, "POST", `/${wb}/rows`, { cells: { [col]: "cell-secret" }, source: { type: "webhook", token: "tok-secret", url: "https://x.example.com/?k=url-secret" }, crmRef: { provider: "hubspot", id: "crm-secret" } });
      expect(JSON.stringify(await records(wb))).not.toMatch(/-secret/);
      expect((await call(u, "GET", `/${wb}/activity`)).body).not.toMatch(/-secret/);
    });

    it("takes the person from the session, and refuses a request that names one", async () => {
      const owner = await user();
      const editor = await colleague(owner, ["enrichment:read", "enrichment:capture"]);
      const wb = await book(owner);
      expect((await call(editor, "POST", `/${wb}/rows/bulk`, { rows: [{}], actorId: owner.userId })).statusCode).toBe(422);
      await ok(editor, "POST", `/${wb}/rows`, {});
      expect((await feed(owner, wb)).map((e) => e.actor!.id)).toEqual([editor.userId]);
    });

    it("records nothing when rows are refused or the write fails", async () => {
      const u = await user();
      await setEntitlement(u.workspaceId, "workbooks.row_limit", 3);
      const wb = await book(u);
      const col = await input(u, wb);
      const before = await records(wb);
      expect((await call(u, "POST", `/${wb}/rows`, { cells: { [MISSING]: "x" } })).statusCode).toBe(422);
      expect((await call(u, "POST", `/${wb}/rows/bulk`, { rows: [{}, {}, {}, {}] })).statusCode).toBe(422);
      await withFailingCellInserts(sql, `wb2_act_cells_${suffix}`, `new.workbook_id = '${wb}'`, async () => {
        expect((await call(u, "POST", `/${wb}/rows`, { cells: { [col]: "x" } })).statusCode).toBe(500);
      });
      expect(await records(wb)).toEqual(before);
    });

    it("records a retried request once", async () => {
      const u = await user();
      const wb = await book(u);
      for (const [path, body] of [[`/${wb}/rows`, {}], [`/${wb}/rows/bulk`, { rows: [{}, {}] }]] as const) {
        const key = { "idempotency-key": `act-${randomUUID()}` };
        const first = await ok(u, "POST", path, body, key);
        expect(await ok(u, "POST", path, body, key)).toEqual(first);
      }
      expect((await feed(u, wb)).map((e) => e.details.rows).sort()).toEqual([1, 2]);
    });

    it("records deleted rows, and nothing for a delete that was refused", async () => {
      const u = await user();
      const wb = await book(u);
      const added = (await ok(u, "POST", `/${wb}/rows/bulk`, { rows: [{}, {}, {}] })).data.rows as Array<{ id: number }>;
      expect((await call(u, "POST", `/${wb}/rows/delete`, { rowIds: [added[0]!.id, 999999999] })).statusCode).toBe(404);
      await ok(u, "POST", `/${wb}/rows/delete`, { rowIds: [added[0]!.id, added[1]!.id] });
      expect((await call(u, "DELETE", `/${wb}/rows/${added[0]!.id}`)).statusCode).toBe(404); // a retry
      expect(await newEvents(u, wb, 1)).toEqual([{ type: "rows.deleted", details: { rows: 2, rowCount: 1 } }]);
    });
  });

  // ── Columns ─────────────────────────────────────────────────────────────────

  describe("columns added and changed", () => {
    it("records each action on a column, naming it", async () => {
      const u = await user();
      const wb = await book(u);
      const first = await input(u, wb, "First");
      const second = await input(u, wb, "Second");
      const edit = (id: string, body: unknown) => ok(u, "PATCH", `/${wb}/columns/${id}`, body);
      await edit(second, { name: "Domain" });
      await edit(second, { config: { dataType: "domain" } });
      await edit(second, { hidden: true });
      await edit(second, { hidden: false });
      await edit(second, { frozen: true });
      await edit(second, { frozen: false });
      await edit(second, { width: 320 });
      await ok(u, "POST", `/${wb}/columns/reorder`, { columnIds: [first, second] });
      await ok(u, "DELETE", `/${wb}/columns/${second}`);

      const on = { columnId: second, columnName: "Domain" };
      expect(await newEvents(u, wb, 0)).toEqual([
        { type: "column.added", details: { columnId: first, columnName: "First", columnType: "input", operation: null } },
        { type: "column.added", details: { columnId: second, columnName: "Second", columnType: "input", operation: null } },
        { type: "column.updated", details: { ...on, renamedFrom: "Second" } },
        { type: "column.updated", details: { ...on, settingsChanged: ["dataType"], dataType: { from: "text", to: "domain" } } },
        { type: "column.hidden", details: on },
        { type: "column.shown", details: on },
        { type: "column.frozen", details: on },
        { type: "column.unfrozen", details: on },
        { type: "column.resized", details: { ...on, width: { from: 160, to: 320 } } },
        // Unfreezing left it first, so putting it back second moved both.
        { type: "columns.reordered", details: { columns: [{ columnId: first, columnName: "First", from: 1, to: 0 }, { columnId: second, columnName: "Domain", from: 0, to: 1 }] } },
        { type: "column.deleted", details: { columnId: second, columnName: "Domain", columnType: "input", operation: null } },
      ]);
      expect((await feed(u, wb)).every((e) => e.actor!.id === u.userId)).toBe(true);
    });

    it("records every change made by one request", async () => {
      const u = await user();
      const wb = await book(u);
      const id = await input(u, wb);
      await ok(u, "PATCH", `/${wb}/columns/${id}`, { name: "All at once", hidden: true, frozen: true, width: 200 });
      expect((await newEvents(u, wb, 1)).map((e) => e.type).sort()).toEqual(["column.frozen", "column.hidden", "column.resized", "column.updated"]);
    });

    it("records nothing when nothing changes, so a repeated request is recorded once", async () => {
      const u = await user();
      const wb = await book(u);
      const source = await input(u, wb);
      const formula = await column(u, wb, { name: "Upper", type: "formula", config: { fn: "change_case", source: { columnId: source }, case: "upper" } });
      const change = { name: "Upper", hidden: true, width: 200, config: { case: "upper", source: { columnId: source }, fn: "change_case" } };
      await ok(u, "PATCH", `/${wb}/columns/${formula}`, change);
      // A condition's keys come back from the database in another order than the one they were saved in.
      const conditional = { inputs: { companyName: { columnId: source } }, condition: { rules: [{ columnId: source, op: "equals", value: "Acme" }] } };
      const lookup = await column(u, wb, { name: "Domain", type: "enrichment", operation: "company_domain", config: conditional });
      const after = await records(wb);
      await ok(u, "PATCH", `/${wb}/columns/${formula}`, change);
      await ok(u, "PATCH", `/${wb}/columns/${formula}`, { frozen: false, name: "Upper" });
      await ok(u, "PATCH", `/${wb}/columns/${lookup}`, { config: conditional });
      await ok(u, "POST", `/${wb}/columns/reorder`, { columnIds: [source, formula, lookup] });
      expect(await records(wb)).toEqual(after);
      // The two entries of one request can carry the same time, so their order between themselves is not fixed.
      expect(after.map((r) => r.action).sort()).toEqual(["workbook.column.added", "workbook.column.added", "workbook.column.added", "workbook.column.hidden", "workbook.column.resized"]);
    });

    it("names the settings that changed and never their values", async () => {
      const u = await user();
      const wb = await book(u);
      const source = await input(u, wb);
      const config = (secret: string) => ({ url: `https://hooks.example.com/services/${secret}`, columns: [{ columnId: source }] });
      const hook = await column(u, wb, { name: "Hook", type: "action", operation: "send_to_webhook", config: config("first-secret") });
      await ok(u, "PATCH", `/${wb}/columns/${hook}`, { config: config("second-secret") });
      const ai = await column(u, wb, { name: "AI", type: "ai", config: { prompt: "prompt-secret", output: { type: "text" } } });
      await ok(u, "PATCH", `/${wb}/columns/${ai}`, { config: { prompt: "prompt-secret two", output: { type: "number" } } });
      await ok(u, "DELETE", `/${wb}/columns/${hook}`);
      const events = await feed(u, wb);
      expect(events.filter((e) => e.type === "column.updated").map((e) => e.details.settingsChanged)).toEqual([["output", "prompt"], ["url"]]);
      expect(JSON.stringify(await records(wb))).not.toMatch(/-secret|hooks\.example/);
    });

    it("records nothing for a change that was refused", async () => {
      const u = await user();
      const wb = await book(u);
      const source = await input(u, wb);
      await column(u, wb, { name: "Uses it", type: "formula", config: { fn: "trim_clean", source: { columnId: source } } });
      const before = await records(wb);
      expect((await call(u, "DELETE", `/${wb}/columns/${source}`)).statusCode).toBe(409);
      expect((await call(u, "PATCH", `/${wb}/columns/${source}`, { name: "x", config: { dataType: "money" } })).statusCode).toBe(422);
      expect((await call(u, "POST", `/${wb}/columns`, { name: "x", type: "formula", config: { fn: "nope" } })).statusCode).toBe(422);
      expect((await call(u, "POST", `/${wb}/columns/reorder`, { columnIds: [source] })).statusCode).toBe(409);
      expect(await records(wb)).toEqual(before);
    });

    it("records a retried column add once", async () => {
      const u = await user();
      const wb = await book(u);
      const key = { "idempotency-key": `act-${randomUUID()}` };
      await ok(u, "POST", `/${wb}/columns`, { name: "once", type: "input" }, key);
      await ok(u, "POST", `/${wb}/columns`, { name: "once", type: "input" }, key);
      expect(await feed(u, wb)).toHaveLength(1);
    });
  });

  // ── Whole workbook ──────────────────────────────────────────────────────────

  describe("copies, deletion and restoring", () => {
    it("starts a copy's log with the columns and rows it was given, and leaves the source's alone", async () => {
      const u = await user();
      const source = await book(u);
      const col = await input(u, source);
      await ok(u, "POST", `/${source}/rows/bulk`, { rows: [{ cells: { [col]: "a" } }, {}] });
      const sourceLog = await records(source);
      const key = { "idempotency-key": `act-${randomUUID()}` };
      const copy = (await ok(u, "POST", `/${source}/duplicate`, { includeRows: true }, key)).data;
      await ok(u, "POST", `/${source}/duplicate`, { includeRows: true }, key);
      expect(await newEvents(u, copy.id, 0)).toEqual(
        expect.arrayContaining([
          { type: "column.added", details: { columnId: copy.columns[0].id, columnName: "Company", columnType: "input", operation: null, copiedFromWorkbookId: source } },
          { type: "rows.added", details: { source: "duplicate", rows: 2, rowCount: 2, copiedFromWorkbookId: source } },
        ])
      );
      expect(await feed(u, copy.id)).toHaveLength(2);
      expect(await records(source)).toEqual(sourceLog);
      const empty = (await ok(u, "POST", `/${source}/duplicate`, { includeRows: false })).data;
      expect((await feed(u, empty.id)).map((e) => e.type)).toEqual(["column.added"]);
    });

    it("shows that a workbook was deleted and restored", async () => {
      const u = await user();
      const wb = await book(u, "Keep me");
      await ok(u, "DELETE", `/${wb}`);
      expect((await call(u, "GET", `/${wb}/activity`)).statusCode).toBe(404);
      await ok(u, "POST", `/${wb}/restore`);
      expect(await newEvents(u, wb, 0)).toEqual([
        { type: "workbook.deleted", details: { name: "Keep me" } },
        { type: "workbook.restored", details: {} },
      ]);
    });

    it("saves no change it cannot record", async () => {
      const u = await user();
      const wb = await book(u);
      const col = await input(u, wb);
      const name = `wb2_act_audit_${suffix}`;
      await sql.unsafe(`create function ${name}() returns trigger language plpgsql as $$ begin if new.entity_id = '${wb}' then raise exception 'audit unavailable'; end if; return new; end $$`);
      await sql.unsafe(`create trigger ${name} before insert on audit_logs for each row execute function ${name}()`);
      try {
        const state = async () => ({
          columns: await db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, wb)),
          rows: await db.select().from(workbookRows).where(eq(workbookRows.workbookId, wb)),
          workbook: await db.select().from(workbooks).where(eq(workbooks.id, wb)),
        });
        const before = await state();
        for (const [method, path, body] of [
          ["POST", `/${wb}/rows`, {}],
          ["POST", `/${wb}/columns`, { name: "x", type: "input" }],
          ["PATCH", `/${wb}/columns/${col}`, { hidden: true }],
          ["DELETE", `/${wb}/columns/${col}`],
          ["DELETE", `/${wb}`],
        ] as Array<[Method, string, unknown?]>) {
          const res = await call(u, method, path, body);
          expect(res.statusCode, `${method} ${path}`).toBe(500);
          expect(res.body).not.toContain("audit unavailable");
        }
        expect(await state()).toEqual(before);
      } finally {
        await sql.unsafe(`drop trigger if exists ${name} on audit_logs`);
        await sql.unsafe(`drop function if exists ${name}()`);
      }
    });
  });

  // ── Runs ────────────────────────────────────────────────────────────────────

  /** A workbook with a column and a run of it that `u` started, in a workspace with credits to spend. */
  async function runOf(u: User, opts: { wb?: string; maxCredits?: number; startedBy?: string | null; operation?: "push_to_crm"; provider?: string } = {}) {
    const wb = opts.wb ?? (await book(u));
    const source = await input(u, wb, "Name");
    let columnId = source;
    if (opts.operation === "push_to_crm") {
      await db.insert(crmConnections).values({ workspaceId: u.workspaceId, provider: opts.provider ?? "salesforce" }).onConflictDoNothing();
      columnId = await column(u, wb, { name: "Push", type: "action", operation: "push_to_crm", config: { provider: opts.provider ?? "salesforce", object: "contact", mapping: [{ crmField: "email", columnId: source }] } });
    }
    const [run] = await db
      .insert(workbookRuns)
      .values({ workbookId: wb, columnId, scope: "all", status: "running", maxCredits: opts.maxCredits ?? 50, startedBy: opts.startedBy === undefined ? u.userId : opts.startedBy })
      .returning();
    const baseline = (await feed(u, wb)).length;
    return { wb, runId: run!.id, columnId, baseline };
  }

  const spend = async (workspaceId: string, credits: number, referenceId: string) =>
    (await postCreditTransaction(db, { workspaceId, amount: -credits, kind: "consume", action: "workbook.find_email", referenceId })).transaction;
  const refund = (workspaceId: string, credits: number, extra: { compensatesId?: string; referenceId?: string }) =>
    postCreditTransaction(db, { workspaceId, amount: credits, kind: "refund", action: "workbook.find_email", ...extra });
  const runEvents = async (u: User, wb: string) => (await feed(u, wb)).filter((e) => e.type.startsWith("run.")).reverse();

  describe("runs", () => {
    it("records who started a run, the column, the rows and the most it can cost, with no actual cost yet", async () => {
      const u = await user();
      const other = await colleague(u, ["enrichment:read"]);
      const { wb, runId, columnId } = await runOf(u, { maxCredits: 120 });
      expect(await recordRunStarted(db, u.workspaceId, runId, { rows: 40 })).toEqual({ recorded: true });
      const [event] = await runEvents(other, wb);
      expect(event).toMatchObject({
        type: "run.started",
        actor: { id: u.userId },
        details: { runId, columnId, columnName: "Name", scope: "all", rows: 40, maxCredits: 120, actualCredits: null },
      });
    });

    it("records a start once however often it is reported, even at the same moment", async () => {
      const u = await user();
      const { wb, runId } = await runOf(u);
      const results = await Promise.all(Array.from({ length: 8 }, () => recordRunStarted(db, u.workspaceId, runId, { rows: 5 })));
      expect(results.filter((r) => r.recorded)).toHaveLength(1);
      expect(await recordRunStarted(db, u.workspaceId, runId, { rows: 999 })).toEqual({ recorded: false });
      expect((await runEvents(u, wb)).map((e) => e.details.rows)).toEqual([5]);
    });

    it("reports what a completed run was actually charged, from the ledger", async () => {
      const u = await user();
      const { wb, runId } = await runOf(u, { maxCredits: 50 });
      await recordRunStarted(db, u.workspaceId, runId, { rows: 10 });
      await spend(u.workspaceId, 3, workbookRunLedgerReference(wb, runId, 1));
      await spend(u.workspaceId, 2, workbookRunLedgerReference(wb, runId, 2));
      await spend(u.workspaceId, 1, workbookRunLedgerReference(wb.toUpperCase(), runId.toUpperCase()));
      await recordRunFinished(db, u.workspaceId, runId, { status: "completed" });
      const [, finished] = await runEvents(u, wb);
      expect(finished).toMatchObject({ type: "run.finished", actor: { id: u.userId }, details: { status: "completed", columnName: "Name", rows: 10, maxCredits: 50, actualCredits: 6 } });
    });

    it("counts only this run's own charges", async () => {
      const u = await user();
      const stranger = await user();
      const mine = await runOf(u);
      const sibling = await runOf(u, { wb: mine.wb });
      await spend(u.workspaceId, 4, workbookRunLedgerReference(mine.wb, mine.runId, 1));
      await spend(u.workspaceId, 7, workbookRunLedgerReference(mine.wb, sibling.runId, 1));
      await spend(u.workspaceId, 9, workbookRunLedgerReference(MISSING, mine.runId, 1)); // another workbook
      await spend(u.workspaceId, 11, `${workbookRunLedgerReference(mine.wb, mine.runId)}-copy`); // not this run's id
      await spend(u.workspaceId, 13, "search:unrelated");
      await spend(stranger.workspaceId, 17, workbookRunLedgerReference(mine.wb, mine.runId, 1)); // another workspace's wallet
      await recordRunFinished(db, u.workspaceId, mine.runId, { status: "completed" });
      await recordRunFinished(db, u.workspaceId, sibling.runId, { status: "completed" });
      const costs = Object.fromEntries((await runEvents(u, mine.wb)).map((e) => [e.details.runId, e.details.actualCredits]));
      expect(costs).toEqual({ [mine.runId]: 4, [sibling.runId]: 7 });
    });

    it("follows refunds and corrections, including ones made after the run finished", async () => {
      const u = await user();
      const { wb, runId } = await runOf(u);
      const first = await spend(u.workspaceId, 10, workbookRunLedgerReference(wb, runId, 1));
      const second = await spend(u.workspaceId, 5, workbookRunLedgerReference(wb, runId, 2));
      await refund(u.workspaceId, 5, { compensatesId: second.id }); // corrects an entry, carries no reference
      await recordRunFinished(db, u.workspaceId, runId, { status: "completed" });
      const actual = async () => (await runEvents(u, wb))[0]!.details.actualCredits;
      expect(await actual()).toBe(10);
      // Both a reference and a correction: counted once. Then a correction of that correction.
      const back = await refund(u.workspaceId, 4, { compensatesId: first.id, referenceId: workbookRunLedgerReference(wb, runId, 1) });
      expect(await actual()).toBe(6);
      await postCreditTransaction(db, { workspaceId: u.workspaceId, amount: -1, kind: "adjustment", action: "correction", reason: "over-refunded", compensatesId: back.transaction.id });
      expect(await actual()).toBe(7);
      // The record of the moment is unchanged.
      const [stored] = (await records(wb)).filter((r) => r.action === "workbook.run.finished");
      expect(stored!.afterState).toMatchObject({ creditsAtFinish: 10 });
    });

    it("never reports the estimate as the cost of a run that failed or was cancelled", async () => {
      const u = await user();
      for (const status of ["failed", "cancelled"] as const) {
        const nothing = await runOf(u, { maxCredits: 80 });
        await recordRunStarted(db, u.workspaceId, nothing.runId, { rows: 20 });
        await recordRunFinished(db, u.workspaceId, nothing.runId, { status });
        expect((await runEvents(u, nothing.wb))[1]!.details).toMatchObject({ status, maxCredits: 80, actualCredits: 0 });
        const partly = await runOf(u, { maxCredits: 80 });
        await spend(u.workspaceId, 6, workbookRunLedgerReference(partly.wb, partly.runId, 1));
        await recordRunFinished(db, u.workspaceId, partly.runId, { status });
        expect((await runEvents(u, partly.wb))[0]!.details).toMatchObject({ status, maxCredits: 80, actualCredits: 6, rows: null });
      }
    });

    it("keeps the first final status: a later report adds nothing and cannot turn a failure into a success", async () => {
      const u = await user();
      for (const [first, later] of [["failed", "completed"], ["cancelled", "completed"], ["completed", "failed"]] as const) {
        const { wb, runId } = await runOf(u);
        expect(await recordRunFinished(db, u.workspaceId, runId, { status: first })).toEqual({ recorded: true });
        for (const status of [later, first, "interrupted"] as const) expect(await recordRunFinished(db, u.workspaceId, runId, { status, attempt: 9 })).toEqual({ recorded: false });
        expect(await recordRunStarted(db, u.workspaceId, runId, { rows: 1 })).toEqual({ recorded: false });
        expect((await runEvents(u, wb)).map((e) => [e.type, e.details.status])).toEqual([["run.finished", first]]);
      }
    });

    it("records each interruption once and one success after the run resumes", async () => {
      const u = await user();
      const { wb, runId } = await runOf(u);
      await recordRunStarted(db, u.workspaceId, runId, { rows: 8 });
      await spend(u.workspaceId, 2, workbookRunLedgerReference(wb, runId, 1));
      await recordRunFinished(db, u.workspaceId, runId, { status: "interrupted", attempt: 1 });
      expect(await recordRunFinished(db, u.workspaceId, runId, { status: "interrupted", attempt: 1 })).toEqual({ recorded: false });
      expect(await recordRunStarted(db, u.workspaceId, runId, { rows: 8 })).toEqual({ recorded: false }); // resumed
      await recordRunFinished(db, u.workspaceId, runId, { status: "interrupted", attempt: 2 });
      await spend(u.workspaceId, 3, workbookRunLedgerReference(wb, runId, 2));
      const done = await Promise.all(Array.from({ length: 6 }, () => recordRunFinished(db, u.workspaceId, runId, { status: "completed", attempt: 3 })));
      expect(done.filter((r) => r.recorded)).toHaveLength(1);
      expect((await runEvents(u, wb)).map((e) => [e.type, e.details.status ?? null, e.details.rows])).toEqual([
        ["run.started", null, 8],
        ["run.finished", "interrupted", 8],
        ["run.finished", "interrupted", 8],
        ["run.finished", "completed", 8],
      ]);
      // The feed shows what the ledger says now, for every end of this run.
      expect((await runEvents(u, wb)).slice(1).map((e) => e.details.actualCredits)).toEqual([5, 5, 5]);
    });

    it("shows no person when the run records none", async () => {
      const u = await user();
      const { wb, runId } = await runOf(u, { startedBy: null });
      await recordRunStarted(db, u.workspaceId, runId, { rows: 1 });
      expect((await runEvents(u, wb))[0]!.actor).toBeNull();
    });

    it("refuses a run of another workspace and invalid reports, recording nothing", async () => {
      const u = await user();
      const stranger = await user();
      const { wb, runId } = await runOf(u);
      const before = await records(wb);
      for (const attempt of [
        () => recordRunStarted(db, stranger.workspaceId, runId, { rows: 1 }),
        () => recordRunFinished(db, stranger.workspaceId, runId, { status: "completed" }),
        () => recordRunStarted(db, u.workspaceId, MISSING, { rows: 1 }),
      ]) {
        await expect(attempt()).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
      for (const attempt of [
        () => recordRunStarted(db, u.workspaceId, runId, { rows: -1 }),
        () => recordRunStarted(db, u.workspaceId, runId, { rows: 1.5 }),
        () => recordRunFinished(db, u.workspaceId, runId, { status: "success" as never }),
        () => recordRunFinished(db, u.workspaceId, runId, { status: "interrupted", attempt: -1 }),
      ]) {
        await expect(attempt()).rejects.toMatchObject({ code: "INVALID_ACTIVITY" });
      }
      expect(await records(wb)).toEqual(before);
    });

    it("is recorded together with the engine's own change, or not at all", async () => {
      const u = await user();
      const { wb, runId } = await runOf(u);
      const before = await records(wb);
      await expect(
        db.transaction(async (tx) => {
          await recordRunStarted(tx as never, u.workspaceId, runId, { rows: 1 });
          throw new Error("accepting the run failed");
        })
      ).rejects.toThrow("accepting the run failed");
      expect(await records(wb)).toEqual(before);
    });
  });

  // ── CRM pushes ──────────────────────────────────────────────────────────────

  describe("CRM pushes", () => {
    const result = (over: Partial<CrmPushResult> = {}): CrmPushResult => ({ status: "completed", attempted: 10, succeeded: 8, failed: 2, skipped: 3, ...over });

    it("records the CRM, the counts and the person, once", async () => {
      const u = await user();
      const { wb, runId, columnId } = await runOf(u, { operation: "push_to_crm", provider: "pipedrive" });
      expect(await recordCrmPush(db, u.workspaceId, runId, result())).toEqual({ recorded: true });
      expect(await recordCrmPush(db, u.workspaceId, runId, result({ succeeded: 10, failed: 0 }))).toEqual({ recorded: false });
      const events = (await feed(u, wb)).filter((e) => e.type === "crm_push");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor: { id: u.userId },
        details: { runId, columnId, columnName: "Push", provider: "pipedrive", status: "completed", attempted: 10, succeeded: 8, failed: 2, skipped: 3 },
      });
    });

    it("shows a push that failed or was interrupted as exactly that", async () => {
      const u = await user();
      const { wb, runId } = await runOf(u, { operation: "push_to_crm", provider: "hubspot" });
      await recordCrmPush(db, u.workspaceId, runId, result({ status: "interrupted", attempt: 1, succeeded: 3, failed: 0 }));
      expect(await recordCrmPush(db, u.workspaceId, runId, result({ status: "interrupted", attempt: 1, succeeded: 3, failed: 0 }))).toEqual({ recorded: false });
      await recordCrmPush(db, u.workspaceId, runId, result({ status: "failed", succeeded: 0, failed: 4 }));
      expect(await recordCrmPush(db, u.workspaceId, runId, result())).toEqual({ recorded: false });
      expect((await feed(u, wb)).filter((e) => e.type === "crm_push").reverse().map((e) => [e.details.status, e.details.succeeded, e.details.failed])).toEqual([
        ["interrupted", 3, 0],
        ["failed", 0, 4],
      ]);
    });

    it("refuses counts that do not add up, other kinds of run and other workspaces", async () => {
      const u = await user();
      const push = await runOf(u, { operation: "push_to_crm" });
      const plain = await runOf(u);
      const stranger = await user();
      const before = [await records(push.wb), await records(plain.wb)];
      for (const bad of [
        result({ succeeded: 9, failed: 2 }),
        result({ succeeded: 5, failed: 0 }), // "completed" with records unaccounted for
        result({ failed: -1 }),
        result({ skipped: 0.5 }),
        result({ status: "done" as never }),
      ]) {
        await expect(recordCrmPush(db, u.workspaceId, push.runId, bad)).rejects.toMatchObject({ code: "INVALID_ACTIVITY" });
      }
      await expect(recordCrmPush(db, u.workspaceId, plain.runId, result())).rejects.toMatchObject({ code: "INVALID_ACTIVITY" });
      await expect(recordCrmPush(db, stranger.workspaceId, push.runId, result())).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect([await records(push.wb), await records(plain.wb)]).toEqual(before);
    });
  });

  // ── Exports ─────────────────────────────────────────────────────────────────

  describe("exports", () => {
    const actor = (u: User) => ({ workspaceId: u.workspaceId, userId: u.userId, requestId: randomUUID() });
    const report = (over: Partial<ExportReport> = {}): ExportReport => ({ exportId: randomUUID(), format: "csv", destination: "download", status: "completed", rows: 120, ...over });
    const exportsOf = async (u: User, wb: string) => (await feed(u, wb)).filter((e) => e.type === "export").reverse();

    it("records the format, destination, rows and person of an export, once", async () => {
      const u = await user();
      const wb = await book(u);
      const done = report();
      expect(await recordExport(db, actor(u), wb, done)).toEqual({ recorded: true });
      expect(await recordExport(db, actor(u), wb, done)).toEqual({ recorded: false });
      expect(await recordExport(db, actor(u), wb, { ...done, exportId: done.exportId.toUpperCase() })).toEqual({ recorded: false });
      const events = await exportsOf(u, wb);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actor: { id: u.userId }, details: { exportId: done.exportId, format: "csv", destination: "download", status: "completed", rows: 120 } });
    });

    it("follows a background export from start to finish, each step once", async () => {
      const u = await user();
      const wb = await book(u);
      const exportId = randomUUID();
      const started = report({ exportId, destination: "email", status: "started", rows: 50_000 });
      await recordExport(db, actor(u), wb, started);
      expect(await recordExport(db, actor(u), wb, started)).toEqual({ recorded: false });
      const finishes = await Promise.all(Array.from({ length: 6 }, () => recordExport(db, { workspaceId: u.workspaceId, userId: u.userId }, wb, report({ exportId, destination: "email", rows: 49_990 }))));
      expect(finishes.filter((r) => r.recorded)).toHaveLength(1);
      expect(await recordExport(db, actor(u), wb, started)).toEqual({ recorded: false });
      expect((await exportsOf(u, wb)).map((e) => [e.details.status, e.details.rows])).toEqual([["started", 50_000], ["completed", 49_990]]);
      expect((await records(wb)).filter((r) => r.action === "workbook.export").map((r) => r.sourceChannel)).toEqual(["api", "worker"]);
    });

    it("says no rows were exported by an export that failed or was cancelled, and keeps it that way", async () => {
      const u = await user();
      const wb = await book(u);
      for (const status of ["failed", "cancelled"] as const) {
        const exportId = randomUUID();
        await recordExport(db, actor(u), wb, report({ exportId, status, rows: 500 }));
        expect(await recordExport(db, actor(u), wb, report({ exportId }))).toEqual({ recorded: false });
      }
      expect((await exportsOf(u, wb)).map((e) => [e.details.status, e.details.rows])).toEqual([["failed", null], ["cancelled", null]]);
    });

    it("refuses invalid reports and other workspaces, and still records an export of a deleted workbook", async () => {
      const u = await user();
      const stranger = await user();
      const wb = await book(u);
      const before = await records(wb);
      for (const bad of [
        report({ exportId: "x" }),
        report({ format: "xlsx" as never }),
        report({ destination: "ftp://secret" as never }),
        report({ status: "ok" as never }),
        report({ rows: undefined }),
        report({ rows: -1 }),
      ]) {
        await expect(recordExport(db, actor(u), wb, bad)).rejects.toMatchObject({ code: "INVALID_ACTIVITY" });
      }
      await expect(recordExport(db, actor(stranger), wb, report())).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await records(wb)).toEqual(before);
      await ok(u, "DELETE", `/${wb}`);
      expect(await recordExport(db, actor(u), wb, report())).toEqual({ recorded: true });
    });
  });

  // ── Reading ─────────────────────────────────────────────────────────────────

  describe("GET /workbooks-v2/:id/activity", () => {
    it("is empty for a new workbook", async () => {
      const u = await user();
      const wb = await book(u);
      expect((await call(u, "GET", `/${wb}/activity`)).json()).toEqual({ data: [], nextCursor: null });
    });

    it("pages newest first without skipping or repeating events, even ones a microsecond apart or simultaneous", async () => {
      const u = await user();
      const wb = await book(u);
      const second = "2026-01-01T00:00:00";
      const at = [`${second}.000001`, `${second}.000002`, `${second}.000002`, `${second}.000002`, `${second}.000003`, `${second}.001`, "2026-01-02T00:00:00"];
      for (const [i, time] of at.entries()) {
        await sql`insert into audit_logs (workspace_id, entity_type, entity_id, action, after_state, created_at)
          values (${u.workspaceId}, 'workbook', ${wb}, 'workbook.rows.added', ${JSON.stringify({ source: "csv", rows: i })}::text::jsonb, ${`${time}Z`}::timestamptz)`;
      }
      for (const limit of [1, 2, 3, 7, 100]) {
        const seen: Event[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const page: { data: Event[]; nextCursor: string | null } = await ok(u, "GET", `/${wb}/activity?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
          expect(page.data.length).toBeLessThanOrEqual(limit);
          seen.push(...page.data);
          cursor = page.nextCursor;
          pages += 1;
        } while (cursor);
        expect(pages).toBe(Math.ceil(at.length / limit));
        const order = seen.map((e) => e.details.rows as number);
        expect([order[0], order[1], order[2], order[6]], `limit ${limit}`).toEqual([6, 5, 4, 0]);
        expect(order.slice(3, 6).sort()).toEqual([1, 2, 3]);
        expect(new Set(seen.map((e) => e.id)).size).toBe(at.length);
      }
    });

    it("returns 25 events by default", async () => {
      const u = await user();
      const wb = await book(u);
      await db.insert(auditLogs).values(Array.from({ length: 30 }, () => ({ workspaceId: u.workspaceId, entityType: "workbook", entityId: wb, action: "workbook.restore" })));
      const page = await ok(u, "GET", `/${wb}/activity`);
      expect(page.data).toHaveLength(25);
      expect(page.nextCursor).toEqual(expect.any(String));
    });

    it("returns this workbook's activity only, in one shape, with only the fields meant to be shown", async () => {
      const u = await user();
      const wb = await book(u);
      const sibling = await book(u, "sibling");
      await ok(u, "POST", `/${wb}/rows`, {});
      await ok(u, "POST", `/${sibling}/rows/bulk`, { rows: [{}, {}] });
      const record = (extra: Record<string, unknown>) =>
        recordPrivilegedAction(db, { workspaceId: u.workspaceId, actorId: u.userId, action: "workbook.rows.added", entityType: "workbook", entityId: wb, ...(extra as object) });
      const stranger = await user();
      await record({ workspaceId: stranger.workspaceId, actorId: stranger.userId }); // another workspace's entry naming this id
      await record({ action: "workbook.something_else" });
      await record({ entityType: "enrichment_workbook" });
      await record({ afterState: { source: "csv", rows: 1, rowCount: 2, apiKey: "leak-secret", internalProvenance: { provider: "leak-secret" } }, beforeState: { token: "leak-secret" } });
      const res = await call(u, "GET", `/${wb}/activity`);
      expect(res.body).not.toContain("leak-secret");
      const events = res.json().data as Event[];
      expect(events.map((e) => e.details)).toEqual([{ source: "csv", rows: 1, rowCount: 2 }, { source: "manual", rows: 1, rowCount: 1 }]);
      for (const event of events) expect(Object.keys(event).sort()).toEqual(["actor", "details", "id", "occurredAt", "type"]);
    });

    it("refuses bad paging and parameters it does not have", async () => {
      const u = await user();
      const wb = await book(u);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const id = randomUUID();
      for (const query of [
        "limit=0",
        "limit=101",
        "limit=abc",
        "limit=1.5",
        "limit=-1",
        "cursor=nonsense",
        `cursor=${encode({ at: "2026-02-30T00:00:00.000000Z", id })}`,
        `cursor=${encode({ at: "2026-13-01T00:00:00.000000Z", id })}`,
        `cursor=${encode({ at: "2026-01-01T00:00:00Z'; drop table audit_logs; --", id })}`,
        `cursor=${encode({ at: "2026-01-01T00:00:00.000000Z", id: "x" })}`,
        `cursor=${"a".repeat(201)}`,
        "type=rows.added",
        "actorId=x",
        `workspaceId=${u.workspaceId}`,
      ]) {
        const res = await call(u, "GET", `/${wb}/activity?${query}`);
        expect(res.statusCode, query).toBe(422);
        expect(res.json().code).toBe("VALIDATION_FAILED");
      }
      expect((await call(u, "GET", "/not-a-uuid/activity")).statusCode).toBe(422);
    });

    it("hides another workspace's log, and an unknown or deleted workbook's", async () => {
      const owner = await user();
      const wb = await book(owner);
      await input(owner, wb, "their-column-name");
      const intruder = await user();
      for (const res of [await call(intruder, "GET", `/${wb}/activity`), await call(intruder, "GET", `/${MISSING}/activity`)]) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
        expect(res.body).not.toContain("their-column-name");
      }
      expect((await call(intruder, "GET", `/${wb}/activity`, undefined, { "x-workspace-id": owner.workspaceId })).statusCode).toBe(403);
      // Their cursor on my own workbook only says where to start in my own log.
      const cursor = Buffer.from(JSON.stringify({ at: "2999-01-01T00:00:00.000000Z", id: MISSING })).toString("base64url");
      const mine = await book(intruder);
      expect((await call(intruder, "GET", `/${mine}/activity?cursor=${cursor}`)).json().data).toEqual([]);
      await ok(owner, "DELETE", `/${wb}`);
      expect((await call(owner, "GET", `/${wb}/activity`)).statusCode).toBe(404);
    });

    it("needs the view permission, the Workbooks V2 switch and a session", async () => {
      const owner = await user();
      const wb = await book(owner);
      expect((await call(await colleague(owner, ["enrichment:read"]), "GET", `/${wb}/activity`)).statusCode).toBe(200);
      expect((await call(await colleague(owner, ["enrichment:capture"]), "GET", `/${wb}/activity`)).statusCode).toBe(403);
      expect((await call(await colleague(owner, []), "GET", `/${wb}/activity`)).statusCode).toBe(403);
      await setEntitlement(owner.workspaceId, "feature.workbooks_v2", false);
      expect((await call(owner, "GET", `/${wb}/activity`)).statusCode).toBe(403);
      const anonymous = await buildApp({ ...base, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, CLERK_SECRET_KEY: "sk_test_unused", CLERK_JWT_ISSUER: "https://clerk.example.test" });
      try {
        expect((await anonymous.inject({ method: "GET", url: `${URL_BASE}/${wb}/activity` })).statusCode).toBe(401);
      } finally {
        await anonymous.close();
      }
    });

    it("stays part of the existing audit log, which still reads it", async () => {
      const u = await user();
      const wb = await book(u);
      await ok(u, "POST", `/${wb}/rows`, {}, { "x-request-id": "trace-123" });
      await ok(u, "POST", `/${wb}/rows`, {}, { "x-request-id": "" }); // an empty id must not stop the write
      const res = await app.inject({ method: "GET", url: `/api/v1/cops/audit?entity_id=${wb}`, headers: u.headers, remoteAddress: u.ip });
      expect(res.statusCode, res.body).toBe(200);
      const entries = res.json().data as Array<{ action: string; correlationId: string; sourceChannel: string; actorEmail: string }>;
      expect(entries.map((e) => [e.action, e.sourceChannel, e.actorEmail])).toEqual([
        ["workbook.rows.added", "api", u.email],
        ["workbook.rows.added", "api", u.email],
      ]);
      expect(entries.map((e) => e.correlationId)).toContain("trace-123");
      expect(entries.every((e) => e.correlationId.length > 0)).toBe(true);
    });
  });
});
