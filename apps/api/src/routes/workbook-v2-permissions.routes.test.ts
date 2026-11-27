import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { invalidateWorkspaceAccess } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

/** WB2-014: `enrichment.run` decides who may run columns and push to a CRM. Editing does not need it. */
const base = loadEnv();
const hasDatabase = Boolean(base.DATABASE_URL);
const URL_BASE = "/api/v1/workbooks-v2";
const MISSING = "00000000-0000-4000-8000-0000000000ff";
const RUN = "enrichment.run";
const { entitlements, workbooks, workbookColumns, workbookCells, workbookRuns, permissions, roles, rolePermissions, workspaceMemberRoles, workspaceMembers, creditBalances, creditTransactions } = schema;

type Method = "GET" | "POST" | "PATCH" | "DELETE";
type Access = "view" | "edit" | "run";

/**
 * Every Workbooks V2 route and what it takes to call it. A new route fails the first test until it is listed here,
 * so nobody adds one without deciding whether it spends credits.
 */
const ROUTES: Record<string, Access> = {
  "GET /workbooks-v2/status": "view",
  "GET /workbooks-v2": "view",
  "GET /workbooks-v2/:id": "view",
  "GET /workbooks-v2/:id/rows": "view",
  "POST /workbooks-v2/:id/rows/query": "view",
  "GET /workbooks-v2/:id/activity": "view",
  "GET /workbooks-v2/:id/imports": "view",
  "GET /workbooks-v2/:id/imports/:importId": "view",
  "GET /workbooks-v2/:id/imports/:importId/report": "view",
  "POST /workbooks-v2/:id/imports": "edit",
  "GET /workbooks-v2/:id/sources/lists/:sourceId/prospects": "view",
  "GET /workbooks-v2/:id/sources/smart-lists/:sourceId/prospects": "view",
  "POST /workbooks-v2/:id/prospect-imports": "edit",
  "POST /workbooks-v2/:id/imports/:importId/confirm": "edit",
  "DELETE /workbooks-v2/:id/imports/:importId": "edit",
  "POST /workbooks-v2": "edit",
  "PATCH /workbooks-v2/:id": "edit",
  "POST /workbooks-v2/:id/duplicate": "edit",
  "DELETE /workbooks-v2/:id": "edit",
  "POST /workbooks-v2/:id/restore": "edit",
  "POST /workbooks-v2/:id/rows": "edit",
  "POST /workbooks-v2/:id/rows/bulk": "edit",
  "POST /workbooks-v2/:id/paste": "edit",
  // Reading the CRM is part of importing from it.
  "GET /workbooks-v2/:id/crm-sources": "edit",
  "GET /workbooks-v2/:id/crm-sources/:provider/:object": "edit",
  "POST /workbooks-v2/:id/crm-imports": "edit",
  // So is reading Apollo.
  "GET /workbooks-v2/:id/apollo-source": "edit",
  "POST /workbooks-v2/:id/apollo-imports": "edit",
  // Which sheets a workbook pulls from is part of viewing it; reading Google is not.
  "GET /workbooks-v2/:id/sheet-sources": "view",
  "POST /workbooks-v2/:id/sheets/inspect": "edit",
  "POST /workbooks-v2/:id/sheets-imports": "edit",
  "POST /workbooks-v2/:id/sheet-sources/:sourceId/pull": "edit",
  "DELETE /workbooks-v2/:id/sheet-sources/:sourceId": "edit",
  "PATCH /workbooks-v2/:id/rows/:rowId": "edit",
  "DELETE /workbooks-v2/:id/rows/:rowId": "edit",
  "POST /workbooks-v2/:id/rows/delete": "edit",
  "POST /workbooks-v2/:id/columns": "edit",
  "POST /workbooks-v2/:id/columns/reorder": "edit",
  "PATCH /workbooks-v2/:id/columns/:columnId": "edit",
  "DELETE /workbooks-v2/:id/columns/:columnId": "edit",
  "POST /workbooks-v2/:id/runs": "run",
  "POST /workbooks-v2/:id/crm-push": "run",
};

describe("Workbooks V2 route inventory", () => {
  it("lists every /workbooks-v2 route in the source", () => {
    const found = readdirSync(new URL(".", import.meta.url))
      .filter((file) => file.endsWith(".routes.ts"))
      .flatMap((file) => [...readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/\.(get|post|put|patch|delete)\(\s*"(\/workbooks-v2[^"]*)"/g)])
      .map((m) => `${m[1]!.toUpperCase()} ${m[2]}`);
    expect(found.sort()).toEqual(Object.keys(ROUTES).sort());
  });
});

describe.skipIf(!hasDatabase)("Workbooks V2 permissions", () => {
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

  /** Someone who owns their own workspace, with Workbooks V2 on unless `flag` is false. */
  async function user(opts: { flag?: boolean } = {}): Promise<User> {
    n += 1;
    const email = `wb2-perm-${suffix}-${n}@test.com`;
    const ip = `13.${Math.floor(n / 250)}.${n % 250}.7`;
    await app.inject({ method: "GET", url: "/api/v1/me", headers: { "x-stub-user-email": email }, remoteAddress: ip });
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    const [m] = await db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, u!.id));
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

  const systemRole = async (key: string) => (await db.select().from(roles).where(and(eq(roles.key, key), isNull(roles.workspaceId))))[0]!;

  async function customRole(workspaceId: string, keys: string[]) {
    const key = `perm-${suffix}-${++n}`;
    const [role] = await db.insert(roles).values({ workspaceId, key, name: key, description: "test", isSystem: false }).returning();
    if (keys.length) await db.insert(rolePermissions).values(keys.map((permissionKey) => ({ roleId: role!.id, permissionKey })));
    return role!.id;
  }

  const grant = (u: User, workspaceId: string, roleId: string) => db.insert(workspaceMemberRoles).values({ workspaceId, userId: u.userId, roleId });

  /** Another person in `owner`'s workspace with exactly these roles: built-in role names, or permission lists. */
  async function colleague(owner: User, ...held: Array<"owner" | "admin" | "member" | string[]>): Promise<User> {
    const other = await user();
    const coarse = held.find((h): h is "owner" | "admin" | "member" => typeof h === "string") ?? "member";
    await db.insert(workspaceMembers).values({ workspaceId: owner.workspaceId, userId: other.userId, role: coarse });
    await db.delete(workspaceMemberRoles).where(and(eq(workspaceMemberRoles.workspaceId, owner.workspaceId), eq(workspaceMemberRoles.userId, other.userId)));
    for (const h of held) await grant(other, owner.workspaceId, typeof h === "string" ? (await systemRole(h)).id : await customRole(owner.workspaceId, h));
    return { ...other, workspaceId: owner.workspaceId, headers: { ...other.headers, "x-workspace-id": owner.workspaceId } };
  }

  const call = (u: User, method: Method, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url: `${URL_BASE}${path}`,
      remoteAddress: u.ip,
      headers: { ...u.headers, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });

  const uploadCsv = (u: User, workbookId: string, content: string) =>
    app.inject({ method: "POST", url: `${URL_BASE}/${workbookId}/imports`, remoteAddress: u.ip, headers: { ...u.headers, "content-type": "text/csv", "x-file-name": "perm.csv" }, payload: content });

  /** A finished import with a report, one to confirm and one to cancel. Adds no rows. */
  async function importsFor(owner: User, b: Book) {
    const make = async (content: string) => {
      const res = await uploadCsv(owner, b.id, content);
      expect(res.statusCode, res.body).toBe(201);
      return res.json().data.id as string;
    };
    const done = await make("a,b\n,\n");
    const confirmed = await call(owner, "POST", `/${b.id}/imports/${done}/confirm`, { columns: [{ header: 0, columnId: b.input }], dedupe: { key: "none" } });
    expect(confirmed.json().data.report.available, confirmed.body).toBe(true);
    const prospectId = `perm-${randomUUID()}`;
    await db.insert(schema.prospectActivations).values({ workspaceId: owner.workspaceId, prospectId, companyId: prospectId, snapshot: { fullName: "Perm Person" } });
    const [list] = await db.insert(schema.lists).values({ workspaceId: owner.workspaceId, name: "perm" }).returning();
    await db.insert(schema.listMembers).values({ listId: list!.id, prospectId });
    const [smart] = await db.insert(schema.smartLists).values({ workspaceId: owner.workspaceId, name: "perm", filters: { companyDomain: "example1.com" } }).returning();
    const sheet = async () => {
      const [source] = await db
        .insert(schema.workbookSheetSources)
        .values({
          workbookId: b.id, spreadsheetId: `perm-${randomUUID()}`, sheetId: 0, spreadsheetName: "perm", tabName: "perm",
          mapping: { columns: [{ header: "a", columnId: b.input, dataType: "text" }], dedupe: { key: "none", header: null }, idHeader: null, identity: [b.input] },
        })
        .returning();
      return source!.id;
    };
    return { done, waiting: await make("a\n1\n"), unwanted: await make("a\n1\n"), list: list!.id, smartList: smart!.id, pulled: await sheet(), forgotten: await sheet() };
  }
  type Imports = Awaited<ReturnType<typeof importsFor>>;

  interface Book {
    id: string;
    input: string;
    spare: string;
    formula: string;
    enrichment: string;
    ai: string;
    action: string;
    crm: string;
    rows: number[];
  }

  /** A workbook with a column of every type and two rows, in a workspace with credits in the wallet. */
  async function book(owner: User): Promise<Book> {
    const res = await call(owner, "POST", "", { name: "Permissions" });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().data.id as string;
    const ids = { input: randomUUID(), spare: randomUUID(), formula: randomUUID(), enrichment: randomUUID(), ai: randomUUID(), action: randomUUID(), crm: randomUUID() };
    const column = (key: keyof typeof ids, type: "input" | "formula" | "enrichment" | "ai" | "action", position: number, operation: string | null, config: Record<string, unknown>) => ({ id: ids[key], workbookId: id, name: key, type, position, operation, config });
    await db.insert(workbookColumns).values([
      column("input", "input", 0, null, { dataType: "text" }),
      column("spare", "input", 1, null, { dataType: "text" }),
      column("formula", "formula", 2, null, { fn: "trim_clean", source: { columnId: ids.input } }),
      column("enrichment", "enrichment", 3, "company_domain", { inputs: { companyName: { columnId: ids.input } } }),
      column("ai", "ai", 4, null, { prompt: "x", output: { type: "text" } }),
      column("action", "action", 5, "add_to_list", { listId: MISSING }),
      column("crm", "action", 6, "push_to_crm", { provider: "hubspot" }),
    ]);
    const added = await call(owner, "POST", `/${id}/rows/bulk`, { rows: [{ cells: { [ids.input]: "Acme" } }, { cells: { [ids.input]: "Beta" } }] });
    expect(added.statusCode, added.body).toBe(201);
    const [balance] = await db.select().from(creditBalances).where(eq(creditBalances.workspaceId, owner.workspaceId));
    if (!balance) await db.insert(creditBalances).values({ workspaceId: owner.workspaceId, balance: 500 });
    return { id, ...ids, rows: (added.json().data.rows as Array<{ id: number }>).map((r) => r.id) };
  }

  /** Everything a run or a push could change: credits, runs, queued jobs and the workbook itself. */
  async function footprint(workspaceId: string, workbookId: string) {
    const [jobs] = await sql`select (select count(*)::int from async_jobs where workspace_id = ${workspaceId}) as async_jobs, (select count(*)::int from enrichment_jobs where workspace_id = ${workspaceId}) as enrichment_jobs`;
    return {
      balance: await db.select().from(creditBalances).where(eq(creditBalances.workspaceId, workspaceId)),
      transactions: await db.select().from(creditTransactions).where(eq(creditTransactions.workspaceId, workspaceId)),
      jobs: { ...jobs },
      runs: await db.select().from(workbookRuns).where(eq(workbookRuns.workbookId, workbookId)),
      workbook: await db.select().from(workbooks).where(eq(workbooks.id, workbookId)),
      cells: (await db.select().from(workbookCells).where(eq(workbookCells.workbookId, workbookId))).sort((a, z) => a.rowId - z.rowId || a.columnId.localeCompare(z.columnId)),
    };
  }

  /** Every run and push a caller could try. */
  const runAttempts = (b: Book): Array<[string, Record<string, unknown>]> => [
    [`/${b.id}/runs`, { columnId: b.enrichment }],
    [`/${b.id}/runs`, { columnId: b.ai, scope: "first10" }],
    [`/${b.id}/runs`, { columnId: b.enrichment, scope: "selected", rowIds: b.rows }],
    [`/${b.id}/runs`, { columnId: b.action, scope: "empty" }],
    [`/${b.id}/runs`, { columnId: b.crm, scope: "failed" }],
    [`/${b.id}/crm-push`, { columnId: b.crm }],
  ];

  async function expectRefused(u: User, b: Book, who: string) {
    for (const [path, body] of runAttempts(b)) {
      const res = await call(u, "POST", path, body);
      expect(res.statusCode, `${who} ${path} ${res.body}`).toBe(403);
      expect(res.json()).toMatchObject({ ok: false, code: "FORBIDDEN", statusCode: 403, details: { requiredPermission: RUN }, retryable: false });
    }
  }

  /** Permitted and well formed: past every check, and refused only because there is no engine yet. */
  async function expectAllowed(u: User, b: Book, who: string) {
    for (const [path, body] of runAttempts(b)) {
      const res = await call(u, "POST", path, body);
      expect(res.statusCode, `${who} ${path} ${res.body}`).toBe(501);
      expect(res.json()).toMatchObject({ code: "NOT_IMPLEMENTED", retryable: false });
    }
  }

  const previousImportDir = process.env.WORKBOOK_IMPORTS_LOCAL_DIR;
  let importDir: string;
  beforeAll(async () => {
    importDir = await mkdtemp(path.join(os.tmpdir(), "wb2-perm-imports-"));
    process.env.WORKBOOK_IMPORTS_LOCAL_DIR = importDir;
    app = await buildApp({ ...base, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, EARLY_ACCESS_GATE_ENABLED: "true", RATE_LIMIT_MAX: 10_000, PLATFORM_ADMIN_EMAILS: [], EXPORTS_BUCKET: undefined });
  });
  afterAll(async () => {
    await app.close();
    await sql.end();
    if (previousImportDir === undefined) delete process.env.WORKBOOK_IMPORTS_LOCAL_DIR;
    else process.env.WORKBOOK_IMPORTS_LOCAL_DIR = previousImportDir;
    await rm(importDir, { recursive: true, force: true });
  });

  // ── The permission itself ───────────────────────────────────────────────────

  describe("the permission", () => {
    const holders = async () =>
      (
        await db
          .select({ key: roles.key })
          .from(rolePermissions)
          .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
          .where(and(eq(rolePermissions.permissionKey, RUN), isNull(roles.workspaceId)))
      )
        .map((r) => r.key)
        .sort();

    it("is in the catalog and held by the built-in owner and admin roles only", async () => {
      expect(await db.select().from(permissions).where(eq(permissions.key, RUN))).toMatchObject([{ key: RUN, category: "enrichment" }]);
      expect(await holders()).toEqual(["admin", "owner"]);
    });

    it("is added by the migration to a database that already has the roles, and running it again changes nothing", async () => {
      const migration = readFileSync(new URL("../../../../packages/db/drizzle/0178_workbook_run_permission.sql", import.meta.url), "utf8").split("--> statement-breakpoint");
      const rollback = new Error("rollback");
      const seen: unknown[] = [];
      await sql
        .begin(async (tx) => {
          await tx`delete from role_permissions where permission_key = ${RUN}`;
          await tx`delete from permissions where key = ${RUN}`;
          for (let pass = 0; pass < 2; pass++) {
            for (const statement of migration) await tx.unsafe(statement);
            const rows = await tx`select r.key from role_permissions p join roles r on r.id = p.role_id where p.permission_key = ${RUN} order by r.key`;
            seen.push(rows.map((r) => r.key));
          }
          throw rollback;
        })
        .catch((error) => {
          if (error !== rollback) throw error;
        });
      expect(seen).toEqual([["admin", "owner"], ["admin", "owner"]]);
    });

    it("is reported to the browser for owners and admins, not for members", async () => {
      const owner = await user();
      const admin = await colleague(owner, "admin");
      const member = await colleague(owner, "member");
      const mine = async (u: User) => (await app.inject({ method: "GET", url: "/api/v1/me", headers: u.headers, remoteAddress: u.ip })).json().permissions as string[];
      expect(await mine(owner)).toContain(RUN);
      expect(await mine(admin)).toContain(RUN);
      expect(await mine(member)).not.toContain(RUN);
      expect(await mine(member)).toContain("enrichment:capture");
    });
  });

  // ── Running and pushing ─────────────────────────────────────────────────────

  describe("run and CRM push routes", () => {
    it("let owners and admins through, up to the missing engine, without writing or charging anything", async () => {
      const owner = await user();
      const b = await book(owner);
      const before = await footprint(owner.workspaceId, b.id);
      await expectAllowed(owner, b, "owner");
      await expectAllowed(await colleague(owner, "admin"), b, "admin");
      expect(await footprint(owner.workspaceId, b.id)).toEqual(before);
    });

    it("refuse a member with 403, without writing or charging anything", async () => {
      const owner = await user();
      const b = await book(owner);
      const member = await colleague(owner, "member");
      const before = await footprint(owner.workspaceId, b.id);
      expect(before.balance[0]!.balance).toBeGreaterThan(0); // there are credits that could be spent
      await expectRefused(member, b, "member");
      expect(await footprint(owner.workspaceId, b.id)).toEqual(before);
    });

    it("refuse viewers, members with no role and every other enrichment permission", async () => {
      const owner = await user();
      const b = await book(owner);
      const before = await footprint(owner.workspaceId, b.id);
      for (const [who, keys] of [
        ["viewer", ["enrichment:read"]],
        ["nothing", []],
        // None of these stands in for enrichment.run, including the older "run enrichment jobs" permission.
        ["other keys", ["enrichment:read", "enrichment:capture", "enrichment:enrich", "enrichment:export", "enrichment:admin", "sequences:send", "crm:manage"]],
      ] as Array<[string, string[]]>) {
        await expectRefused(await colleague(owner, keys), b, who);
      }
      expect(await footprint(owner.workspaceId, b.id)).toEqual(before);
    });

    it("check permission before anything else, so a refused caller learns nothing", async () => {
      const owner = await user();
      const b = await book(owner);
      const member = await colleague(owner, "member");
      for (const [path, body] of [
        [`/${MISSING}/runs`, { columnId: b.enrichment }],
        [`/${b.id}/runs`, { columnId: MISSING }],
        [`/${b.id}/runs`, { columnId: b.input }],
        [`/${b.id}/runs`, {}],
        [`/not-a-uuid/crm-push`, { columnId: "x" }],
      ] as Array<[string, unknown]>) {
        const res = await call(member, "POST", path, body);
        expect(res.statusCode, `${path} ${JSON.stringify(body)}`).toBe(403);
        expect(res.json().details).toEqual({ requiredPermission: RUN });
      }
    });

    it("give and take away access as soon as a role changes", async () => {
      const owner = await user();
      const b = await book(owner);
      const member = await colleague(owner, "member");
      await expectRefused(member, b, "before");
      const extra = await customRole(owner.workspaceId, [RUN]);
      await grant(member, owner.workspaceId, extra);
      await expectAllowed(member, b, "with an added role");
      await db.delete(workspaceMemberRoles).where(and(eq(workspaceMemberRoles.userId, member.userId), eq(workspaceMemberRoles.roleId, extra)));
      await expectRefused(member, b, "after");
    });

    it("follow a team role change both ways", async () => {
      const owner = await user();
      const b = await book(owner);
      const person = await colleague(owner, "member");
      const change = (role: "admin" | "member") =>
        app.inject({ method: "PATCH", url: `/api/v1/team/members/${person.userId}/role`, headers: { ...owner.headers, "content-type": "application/json" }, remoteAddress: owner.ip, payload: { role } });
      const promoted = await change("admin");
      expect(promoted.statusCode, promoted.body).toBeLessThan(300);
      await expectAllowed(person, b, "promoted");
      expect((await change("member")).statusCode).toBeLessThan(300);
      await expectRefused(person, b, "demoted");
    });

    it("stay inside the workspace the caller is acting in", async () => {
      const victim = await user();
      const b = await book(victim);
      const intruder = await user(); // owns another workspace, so holds enrichment.run there
      const before = await footprint(victim.workspaceId, b.id);
      for (const [path, body] of runAttempts(b)) {
        expect((await call(intruder, "POST", path, body)).statusCode, path).toBe(404);
        const spoofed = await call(intruder, "POST", path, body, { "x-workspace-id": victim.workspaceId });
        expect([403, 404], `${path} ${spoofed.body}`).toContain(spoofed.statusCode);
      }
      // The same person: allowed to run at home, only a member (so refused) in the victim's workspace.
      await db.insert(workspaceMembers).values({ workspaceId: victim.workspaceId, userId: intruder.userId, role: "member" });
      await grant(intruder, victim.workspaceId, (await systemRole("member")).id);
      await expectRefused({ ...intruder, headers: { ...intruder.headers, "x-workspace-id": victim.workspaceId } }, b, "member there");
      await expectAllowed(intruder, await book(intruder), "owner at home");
      // Nor can a column of another workbook be run through one's own.
      const mine = await book(intruder);
      expect((await call(intruder, "POST", `/${mine.id}/runs`, { columnId: b.enrichment })).statusCode).toBe(404);
      expect(await footprint(victim.workspaceId, b.id)).toEqual(before);
    });

    it("validate a permitted request: the body, the column and the workbook", async () => {
      const owner = await user();
      const b = await book(owner);
      const post = (path: string, body: unknown) => call(owner, "POST", path, body);
      for (const body of [
        {},
        { columnId: "x" },
        { columnId: b.enrichment, scope: "some" },
        { columnId: b.enrichment, scope: "selected" },
        { columnId: b.enrichment, rowIds: b.rows },
        { columnId: b.enrichment, scope: "selected", rowIds: [] },
        { columnId: b.enrichment, scope: "selected", rowIds: [-1] },
        { columnId: b.enrichment, workspaceId: owner.workspaceId },
        { columnId: b.enrichment, maxCredits: 0 },
      ]) {
        const res = await post(`/${b.id}/runs`, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(422);
        expect(res.json().code).toBe("VALIDATION_FAILED");
      }
      for (const [path, columnId] of [
        [`/${b.id}/runs`, b.input],
        [`/${b.id}/runs`, b.formula],
        [`/${b.id}/crm-push`, b.enrichment],
        [`/${b.id}/crm-push`, b.action],
        [`/${b.id}/crm-push`, b.input],
      ] as Array<[string, string]>) {
        const res = await post(path, { columnId });
        expect(res.statusCode, `${path} ${res.body}`).toBe(422);
        expect(res.json().code).toBe("COLUMN_NOT_RUNNABLE");
      }
      expect((await post(`/${b.id}/runs`, { columnId: MISSING })).statusCode).toBe(404);
      expect((await post(`/${MISSING}/runs`, { columnId: b.enrichment })).statusCode).toBe(404);
      await call(owner, "DELETE", `/${b.id}`);
      for (const [path, body] of runAttempts(b)) expect((await post(path, body)).statusCode, path).toBe(404);
    });

    it("stay behind the Workbooks V2 switch and sign-in", async () => {
      const owner = await user();
      const b = await book(owner);
      await setEntitlement(owner.workspaceId, "feature.workbooks_v2", false);
      for (const [path, body] of runAttempts(b)) expect((await call(owner, "POST", path, body)).statusCode, path).toBe(403);
      const anonymous = await buildApp({ ...base, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, CLERK_SECRET_KEY: "sk_test_unused", CLERK_JWT_ISSUER: "https://clerk.example.test" });
      try {
        for (const [path, body] of runAttempts(b)) {
          const res = await anonymous.inject({ method: "POST", url: `${URL_BASE}${path}`, headers: { "content-type": "application/json" }, payload: JSON.stringify(body) });
          expect(res.statusCode, path).toBe(401);
        }
      } finally {
        await anonymous.close();
      }
    });
  });

  // ── Everything else ─────────────────────────────────────────────────────────

  describe("viewing and editing without enrichment.run", () => {
    /** One working request for every route, in an order that keeps each one possible. */
    function requests(b: Book, imports: Imports): Array<[string, Method, string, unknown?]> {
      return [
        ["GET /workbooks-v2/status", "GET", "/status"],
        ["GET /workbooks-v2", "GET", ""],
        ["GET /workbooks-v2/:id", "GET", `/${b.id}`],
        ["GET /workbooks-v2/:id/rows", "GET", `/${b.id}/rows`],
        ["POST /workbooks-v2/:id/rows/query", "POST", `/${b.id}/rows/query`, { search: "Acme" }],
        ["GET /workbooks-v2/:id/activity", "GET", `/${b.id}/activity`],
        ["GET /workbooks-v2/:id/imports", "GET", `/${b.id}/imports`],
        ["GET /workbooks-v2/:id/imports/:importId", "GET", `/${b.id}/imports/${imports.done}`],
        ["GET /workbooks-v2/:id/imports/:importId/report", "GET", `/${b.id}/imports/${imports.done}/report`],
        // Sent as a file, not JSON.
        ["POST /workbooks-v2/:id/imports", "POST", `/${b.id}/imports`],
        ["GET /workbooks-v2/:id/sources/lists/:sourceId/prospects", "GET", `/${b.id}/sources/lists/${imports.list}/prospects`],
        ["GET /workbooks-v2/:id/sources/smart-lists/:sourceId/prospects", "GET", `/${b.id}/sources/smart-lists/${imports.smartList}/prospects`],
        ["POST /workbooks-v2/:id/prospect-imports", "POST", `/${b.id}/prospect-imports`, { source: { type: "list", listId: imports.list }, selection: { all: true } }],
        ["POST /workbooks-v2/:id/imports/:importId/confirm", "POST", `/${b.id}/imports/${imports.waiting}/confirm`, { columns: [{ header: 0, columnId: b.input }], dedupe: { key: "none" } }],
        ["DELETE /workbooks-v2/:id/imports/:importId", "DELETE", `/${b.id}/imports/${imports.unwanted}`],
        ["POST /workbooks-v2", "POST", "", { name: "Mine" }],
        ["PATCH /workbooks-v2/:id", "PATCH", `/${b.id}`, { name: "Renamed" }],
        ["POST /workbooks-v2/:id/duplicate", "POST", `/${b.id}/duplicate`, { includeRows: false }],
        ["POST /workbooks-v2/:id/rows", "POST", `/${b.id}/rows`, { cells: { [b.input]: "new" } }],
        ["POST /workbooks-v2/:id/rows/bulk", "POST", `/${b.id}/rows/bulk`, { rows: [{}] }],
        ["POST /workbooks-v2/:id/paste", "POST", `/${b.id}/paste`, { columnIds: [b.input], values: [["pasted"]] }],
        ["GET /workbooks-v2/:id/crm-sources", "GET", `/${b.id}/crm-sources`],
        // HubSpot isn't connected here, so an allowed caller is told that rather than reaching HubSpot.
        ["GET /workbooks-v2/:id/crm-sources/:provider/:object", "GET", `/${b.id}/crm-sources/hubspot/contact`],
        ["POST /workbooks-v2/:id/crm-imports", "POST", `/${b.id}/crm-imports`, { provider: "hubspot", object: "contact", fields: ["email"] }],
        ["GET /workbooks-v2/:id/apollo-source", "GET", `/${b.id}/apollo-source`],
        ["POST /workbooks-v2/:id/apollo-imports", "POST", `/${b.id}/apollo-imports`, { fields: ["email"], search: {} }],
        ["GET /workbooks-v2/:id/sheet-sources", "GET", `/${b.id}/sheet-sources`],
        // Nobody here has connected Google, so an allowed caller is told that rather than reaching Google.
        ["POST /workbooks-v2/:id/sheets/inspect", "POST", `/${b.id}/sheets/inspect`, { spreadsheet: "permission-sheet-abcdefghijklmnop" }],
        ["POST /workbooks-v2/:id/sheets-imports", "POST", `/${b.id}/sheets-imports`, { spreadsheet: "permission-sheet-abcdefghijklmnop", sheetId: 0 }],
        ["POST /workbooks-v2/:id/sheet-sources/:sourceId/pull", "POST", `/${b.id}/sheet-sources/${imports.pulled}/pull`, {}],
        ["DELETE /workbooks-v2/:id/sheet-sources/:sourceId", "DELETE", `/${b.id}/sheet-sources/${imports.forgotten}`],
        ["PATCH /workbooks-v2/:id/rows/:rowId", "PATCH", `/${b.id}/rows/${b.rows[0]}`, { cells: { [b.input]: "edited" } }],
        ["DELETE /workbooks-v2/:id/rows/:rowId", "DELETE", `/${b.id}/rows/${b.rows[1]}`],
        ["POST /workbooks-v2/:id/rows/delete", "POST", `/${b.id}/rows/delete`, { rowIds: [b.rows[0]] }],
        ["POST /workbooks-v2/:id/columns", "POST", `/${b.id}/columns`, { name: "joined", type: "formula", config: { fn: "join", parts: [{ columnId: b.input }] } }],
        ["POST /workbooks-v2/:id/columns/reorder", "POST", `/${b.id}/columns/reorder`, { columnIds: [] }],
        ["PATCH /workbooks-v2/:id/columns/:columnId", "PATCH", `/${b.id}/columns/${b.formula}`, { config: { fn: "change_case", source: { columnId: b.input }, case: "upper" } }],
        ["DELETE /workbooks-v2/:id/columns/:columnId", "DELETE", `/${b.id}/columns/${b.spare}`],
        ["DELETE /workbooks-v2/:id", "DELETE", `/${b.id}`],
        ["POST /workbooks-v2/:id/restore", "POST", `/${b.id}/restore`],
        ["POST /workbooks-v2/:id/runs", "POST", `/${b.id}/runs`, { columnId: b.enrichment }],
        ["POST /workbooks-v2/:id/crm-push", "POST", `/${b.id}/crm-push`, { columnId: b.crm }],
      ];
    }

    async function sweep(owner: User, u: User, b: Book) {
      const results: Record<string, number> = {};
      for (const [route, method, path, body] of requests(b, await importsFor(owner, b))) {
        // The reorder list depends on what exists by then.
        const payload = route.endsWith("/columns/reorder") ? { columnIds: (await db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, b.id))).sort((a, z) => a.position - z.position).map((c) => c.id) } : body;
        results[route] = (route === "POST /workbooks-v2/:id/imports" ? await uploadCsv(u, b.id, "a\n1\n") : await call(u, method, path, payload)).statusCode;
      }
      return results;
    }

    const expected = (outcome: Record<Access, number | "ok">) => Object.fromEntries(Object.entries(ROUTES).map(([route, access]) => [route, outcome[access]]));
    /** No CRM, Apollo or Google is connected here: being told so (409) means the caller was let through. */
    const NEEDS_CONNECTION = new Set(["GET /workbooks-v2/:id/crm-sources/:provider/:object", "POST /workbooks-v2/:id/crm-imports", "POST /workbooks-v2/:id/apollo-imports", "POST /workbooks-v2/:id/sheets/inspect", "POST /workbooks-v2/:id/sheets-imports", "POST /workbooks-v2/:id/sheet-sources/:sourceId/pull"]);
    const simplify = (results: Record<string, number>) =>
      Object.fromEntries(Object.entries(results).map(([route, status]) => [route, status < 300 || (status === 409 && NEEDS_CONNECTION.has(route)) ? "ok" : status]));

    it("sends one request to every route", async () => {
      const owner = await user();
      const b = await book(owner);
      expect(requests(b, await importsFor(owner, b)).map(([route]) => route).sort()).toEqual(Object.keys(ROUTES).sort());
    });

    it("lets a member view and edit everything, cells and formulas included, and refuses only runs and pushes", async () => {
      const owner = await user();
      const b = await book(owner);
      const member = await colleague(owner, "member");
      const before = await footprint(owner.workspaceId, b.id);
      expect(simplify(await sweep(owner, member, b))).toEqual(expected({ view: "ok", edit: "ok", run: 403 }));
      const cells = await db.select().from(workbookCells).where(and(eq(workbookCells.workbookId, b.id), inArray(workbookCells.columnId, [b.input])));
      expect(cells.map((c) => c.value)).toContain("new");
      const [formula] = await db.select().from(workbookColumns).where(eq(workbookColumns.id, b.formula));
      expect(formula!.config).toMatchObject({ fn: "change_case", case: "upper" });
      // Neither the edits nor the refused runs touched credits, jobs or runs.
      const after = await footprint(owner.workspaceId, b.id);
      expect([after.balance, after.transactions, after.jobs, after.runs]).toEqual([before.balance, before.transactions, before.jobs, before.runs]);
    });

    it("keeps an admin's access to everything", async () => {
      const owner = await user();
      const b = await book(owner);
      expect(simplify(await sweep(owner, await colleague(owner, "admin"), b))).toEqual(expected({ view: "ok", edit: "ok", run: 501 }));
    });

    it("gives a view-only role reading and nothing else", async () => {
      const owner = await user();
      const b = await book(owner);
      const viewer = await colleague(owner, ["enrichment:read"]);
      expect(simplify(await sweep(owner, viewer, b))).toEqual(expected({ view: "ok", edit: 403, run: 403 }));
    });

    it("does not let enrichment.run alone view or edit", async () => {
      const owner = await user();
      const b = await book(owner);
      const runner = await colleague(owner, [RUN]);
      const results = simplify(await sweep(owner, runner, b));
      delete results["GET /workbooks-v2/status"]; // only says the feature is on
      const want = expected({ view: 403, edit: 403, run: 501 });
      delete want["GET /workbooks-v2/status"];
      expect(results).toEqual(want);
    });
  });
});
