import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { invalidateWorkspaceAccess } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

/** WB2-013: the Columns API through the real routes against a real database. */
const base = loadEnv();
const hasDatabase = Boolean(base.DATABASE_URL);
const URL_BASE = "/api/v1/workbooks-v2";
const MISSING = "00000000-0000-4000-8000-0000000000ff";
const { workbooks, workbookColumns, workbookCells, workbookRuns, workbookViews, entitlements, auditLogs, sequences, lists, crmConnections, workspaceIntegrations } = schema;

interface Column {
  id: string;
  name: string;
  type: string;
  operation: string | null;
  config: Record<string, any>;
  position: number;
  width: number;
  hidden: boolean;
  frozen: boolean;
}

describe.skipIf(!hasDatabase)("Workbooks V2 columns routes", () => {
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
    const email = `wb2-cols-${suffix}-${n}@test.com`;
    const ip = `12.${Math.floor(n / 250)}.${n % 250}.7`;
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
    await db.insert(schema.workspaceMembers).values({ workspaceId: owner.workspaceId, userId: other.userId, role: "member" });
    await db.delete(schema.workspaceMemberRoles).where(and(eq(schema.workspaceMemberRoles.workspaceId, owner.workspaceId), eq(schema.workspaceMemberRoles.userId, other.userId)));
    const key = `cols-${suffix}-${++n}`;
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

  async function book(u: User, name = "Columns") {
    const res = await call(u, "POST", "", { name });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().data.id as string;
  }

  const post = (u: User, wb: string, body: Record<string, unknown>) => call(u, "POST", `/${wb}/columns`, body);

  /** Adds a column and expects it to work. */
  async function add(u: User, wb: string, body: Record<string, unknown>): Promise<Column> {
    const res = await post(u, wb, { name: "c", ...body });
    expect(res.statusCode, `${JSON.stringify(body)} ${res.body}`).toBe(201);
    return res.json().data as Column;
  }
  const input = (u: User, wb: string, dataType = "text", extra: Record<string, unknown> = {}) => add(u, wb, { name: dataType, type: "input", config: { dataType }, ...extra });

  const columnsOf = async (wb: string) => db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, wb)).orderBy(asc(workbookColumns.position), asc(workbookColumns.id));
  const cellsOf = async (wb: string) => (await db.select().from(workbookCells).where(eq(workbookCells.workbookId, wb))).sort((a, z) => a.rowId - z.rowId || a.columnId.localeCompare(z.columnId));
  const names = async (wb: string) => (await columnsOf(wb)).map((c) => c.name);
  const positions = async (wb: string) => (await columnsOf(wb)).map((c) => c.position);
  const stored = async (wb: string) => (await db.select().from(workbooks).where(eq(workbooks.id, wb)))[0]!;
  const snapshot = async (wb: string) => ({ workbook: await stored(wb), columns: await columnsOf(wb), cells: await cellsOf(wb) });

  async function addRows(u: User, wb: string, rows: Array<Record<string, unknown>>) {
    const res = await call(u, "POST", `/${wb}/rows/bulk`, { rows: rows.map((cells) => ({ cells })) });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(201);
    return (res.json().data.rows as Array<{ id: number }>).map((r) => r.id);
  }

  /** Name, domain, email, number, LinkedIn and date columns to point at. */
  async function sources(u: User, wb: string) {
    const ids = {} as Record<"name" | "domain" | "email" | "number" | "linkedin" | "date", string>;
    for (const [key, dataType] of [["name", "text"], ["domain", "domain"], ["email", "email"], ["number", "number"], ["linkedin", "linkedin_url"], ["date", "date"]] as const) {
      ids[key] = (await input(u, wb, dataType, { name: key })).id;
    }
    const ref = (key: keyof typeof ids) => ({ columnId: ids[key] });
    return { ids, ref };
  }

  /** A sequence, list, CRM connection and provider key in the user's workspace. */
  async function targets(u: User) {
    const [sequence] = await db.insert(sequences).values({ workspaceId: u.workspaceId, name: "Founders" }).returning();
    const [list] = await db.insert(lists).values({ workspaceId: u.workspaceId, name: "Leads" }).returning();
    await db.insert(crmConnections).values({ workspaceId: u.workspaceId, provider: "hubspot" });
    await db.insert(workspaceIntegrations).values({ workspaceId: u.workspaceId, provider: "hunter", encryptedApiKey: "encrypted-secret", keyHint: "…abcd" });
    return { sequenceId: sequence!.id, listId: list!.id };
  }

  beforeAll(async () => {
    app = await buildApp({ ...base, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, EARLY_ACCESS_GATE_ENABLED: "true", RATE_LIMIT_MAX: 10_000, PLATFORM_ADMIN_EMAILS: [] });
  });
  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  // ── Add ─────────────────────────────────────────────────────────────────────

  describe("POST /columns", () => {
    it("adds a column with defaults after the last one and marks the workbook edited", async () => {
      const u = await user();
      const wb = await book(u);
      const before = await stored(wb);
      const res = await post(u, wb, { name: "  Company  ", type: "input" });
      expect(res.statusCode, res.body).toBe(201);
      const { data, columns } = res.json();
      expect(data).toEqual({ id: data.id, name: "Company", type: "input", operation: null, config: { dataType: "text" }, position: 0, width: 160, hidden: false, frozen: false });
      expect(columns).toEqual([data]);
      const second = await add(u, wb, { name: "Domain", type: "input", config: { dataType: "domain" }, width: 240, hidden: true });
      expect(second).toMatchObject({ position: 1, width: 240, hidden: true, config: { dataType: "domain" } });
      expect(await names(wb)).toEqual(["Company", "Domain"]);
      expect((await stored(wb)).updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
      const detail = (await call(u, "GET", `/${wb}`)).json().data;
      expect(detail.columnCount).toBe(2);
      expect(detail.columns.map((c: Column) => c.id)).toEqual([data.id, second.id]);
    });

    it("inserts at a position and shifts the rest", async () => {
      const u = await user();
      const wb = await book(u);
      for (const name of ["a", "b", "c"]) await add(u, wb, { name, type: "input" });
      await add(u, wb, { name: "first", type: "input", position: 0 });
      await add(u, wb, { name: "middle", type: "input", position: 2 });
      await add(u, wb, { name: "last", type: "input", position: 5 });
      expect(await names(wb)).toEqual(["first", "a", "middle", "b", "c", "last"]);
      expect(await positions(wb)).toEqual([0, 1, 2, 3, 4, 5]);
      const past = await post(u, wb, { name: "x", type: "input", position: 7 });
      expect(past.statusCode).toBe(422);
      expect(past.json().code).toBe("COLUMN_ORDER_INVALID");
    });

    it("adds every input type", async () => {
      const u = await user();
      const wb = await book(u);
      const types = ["text", "number", "email", "url", "linkedin_url", "domain", "phone", "date", "checkbox"];
      for (const dataType of types) await input(u, wb, dataType);
      expect((await columnsOf(wb)).map((c) => c.config)).toEqual(types.map((dataType) => ({ dataType })));
    });

    it("adds every waterfall enrichment column", async () => {
      const u = await user();
      const wb = await book(u);
      const { ref } = await sources(u, wb);
      await targets(u);
      const email = await add(u, wb, {
        name: "Work email",
        type: "enrichment",
        operation: "find_email",
        config: {
          inputs: { fullName: ref("name"), companyDomain: ref("domain") },
          quality: { mustBeValid: true, acceptCatchAll: true },
          waterfall: { steps: [{ source: "own_key", provider: "hunter", enabled: true }, { source: "skout", enabled: true }] },
          maxCreditsPerRow: 3,
          condition: { rules: [{ ...ref("email"), op: "is_empty" }, { ...ref("number"), op: "gt", value: 80 }] },
        },
      });
      expect(email).toMatchObject({ operation: "find_email", config: { maxCreditsPerRow: 3, condition: { match: "all" } } });
      const company = await add(u, wb, { type: "enrichment", operation: "company_data", config: { inputs: { companyDomain: ref("domain") }, fields: ["industry", "headcount"] } });
      const profile = await add(u, wb, { type: "enrichment", operation: "linkedin_profile", config: { inputs: { linkedinUrl: ref("linkedin") } } });
      await add(u, wb, { type: "enrichment", operation: "verify_email", config: { inputs: { email: { columnId: email.id } } } });
      await add(u, wb, {
        type: "enrichment",
        operation: "find_phone",
        config: { inputs: { linkedinUrl: ref("linkedin") }, quality: { phoneTypes: ["mobile"] }, condition: { rules: [{ columnId: profile.id, field: "seniority", op: "in", value: ["VP", "C-level"] }] } },
      });
      await add(u, wb, { type: "enrichment", operation: "company_domain", config: { inputs: { companyName: { columnId: company.id, field: "industry" } } } });
      expect((await columnsOf(wb)).filter((c) => c.type === "enrichment").map((c) => c.operation).sort()).toEqual(
        ["company_data", "company_domain", "find_email", "find_phone", "linkedin_profile", "verify_email"]
      );
    });

    it("adds AI columns of every output type, with prompt references and web research", async () => {
      const u = await user();
      const wb = await book(u);
      const { ids } = await sources(u, wb);
      const outputs = [
        { type: "text" },
        { type: "number" },
        { type: "yes_no" },
        { type: "category", options: ["SaaS", "Retail"] },
        { type: "fields", fields: [{ name: "fit", type: "yes_no" }, { name: "reason", type: "text", description: "one line" }] },
      ];
      const made: Column[] = [];
      for (const output of outputs) {
        made.push(await add(u, wb, { type: "ai", config: { prompt: `Look at {{${ids.name}}} from {{${ids.domain.toUpperCase()}}}`, output, webResearch: output.type === "text", template: "first_line" } }));
      }
      expect(made[0]!.config).toMatchObject({ prompt: `Look at {{${ids.name}}} from {{${ids.domain}}}`, webResearch: true });
      const chained = await add(u, wb, { type: "ai", config: { prompt: `Because {{${made[4]!.id}.reason}}`, output: { type: "text" } } });
      expect(chained.operation).toBeNull();
    });

    it("adds every formula column", async () => {
      const u = await user();
      const wb = await book(u);
      const { ref } = await sources(u, wb);
      const formulas: Array<Record<string, unknown>> = [
        { fn: "extract_domain", source: ref("email") },
        { fn: "split_name", source: ref("name"), part: "first" },
        { fn: "join", parts: [ref("name"), { text: " (" }, ref("number"), { text: ")" }] },
        { fn: "change_case", source: ref("name"), case: "upper" },
        { fn: "trim_clean", source: ref("name") },
        { fn: "find_replace", source: ref("name"), find: "Ltd", replace: "" },
        { fn: "if_then_else", condition: { rules: [{ ...ref("number"), op: "gte", value: 10 }] }, then: { value: "big" }, else: ref("name") },
        { fn: "number_format", source: ref("number"), decimals: 1, prefix: "$" },
        { fn: "date_part", source: ref("date"), part: "year" },
        { fn: "first_non_empty", sources: [ref("email"), ref("domain")] },
        { fn: "regex_extract", source: ref("email"), pattern: "@(.+)$", group: 1 },
      ];
      for (const config of formulas) await add(u, wb, { name: String(config.fn), type: "formula", config });
      expect((await columnsOf(wb)).filter((c) => c.type === "formula").map((c) => c.config.fn)).toEqual(formulas.map((f) => f.fn));
    });

    it("adds every action column", async () => {
      const u = await user();
      const wb = await book(u);
      const { ref } = await sources(u, wb);
      const { sequenceId, listId } = await targets(u);
      const actions: Array<[string, Record<string, unknown>]> = [
        ["add_to_sequence", { sequenceId, emailColumn: ref("email"), condition: { rules: [{ ...ref("email"), op: "has_value" }] } }],
        ["add_to_list", { listId }],
        ["push_to_crm", { provider: "hubspot", object: "contact", mapping: [{ crmField: "email", ...ref("email") }, { crmField: "firstname", ...ref("name") }] }],
        ["send_to_webhook", { url: "https://hooks.example.com/services/T0/secret-token", columns: [ref("name"), ref("email")] }],
      ];
      for (const [operation, config] of actions) await add(u, wb, { name: operation, type: "action", operation, config });
      expect((await columnsOf(wb)).filter((c) => c.type === "action").map((c) => c.operation)).toEqual(actions.map(([o]) => o));
    });

    it("rejects invalid settings for every type with the place of the problem, and stores nothing", async () => {
      const u = await user();
      const wb = await book(u);
      const { ref } = await sources(u, wb);
      await targets(u);
      const before = await snapshot(wb);
      const bad: Array<Record<string, unknown>> = [
        { type: "input", config: { dataType: "money" } },
        { type: "input", config: { dataType: "text", prompt: "x" } },
        { type: "input", operation: "find_email", config: {} },
        { type: "enrichment", config: { inputs: { linkedinUrl: ref("linkedin") } } },
        { type: "enrichment", operation: "find_email", config: { inputs: { fullName: ref("name") } } },
        { type: "enrichment", operation: "find_email", config: { inputs: { linkedinUrl: ref("number") } } },
        { type: "enrichment", operation: "verify_email", config: { inputs: { email: ref("date") } } },
        { type: "enrichment", operation: "company_data", config: { inputs: { companyDomain: ref("domain") }, fields: [] } },
        { type: "enrichment", operation: "find_email", config: { inputs: { linkedinUrl: ref("linkedin") }, condition: { rules: [{ ...ref("name"), op: "gt", value: "x" }] } } },
        { type: "ai", config: { prompt: "x", output: { type: "category", options: [] } } },
        { type: "ai", config: { prompt: "Hello {{name}}", output: { type: "text" } } },
        { type: "ai", operation: "ai_research", config: { prompt: "x", output: { type: "text" } } },
        { type: "formula", config: { fn: "javascript", code: "return 1" } },
        { type: "formula", config: { fn: "date_part", source: ref("number"), part: "year" } },
        { type: "formula", config: { fn: "regex_extract", source: ref("name"), pattern: "([", group: 0 } },
        { type: "action", operation: "send_to_webhook", config: { url: "http://hooks.example.com", columns: [ref("name")] } },
        { type: "action", operation: "send_to_webhook", config: { url: "https://169.254.169.254/", columns: [ref("name")] } },
        { type: "action", operation: "add_to_sequence", config: { sequenceId: MISSING, emailColumn: ref("email") } },
        { type: "action", operation: "push_to_crm", config: { provider: "hubspot", object: "contact", mapping: [] } },
      ];
      for (const body of bad) {
        const res = await post(u, wb, { name: "bad", ...body });
        expect(res.statusCode, `${JSON.stringify(body)} ${res.body}`).toBe(422);
        expect(res.json().code).toBe("INVALID_COLUMN_CONFIG");
        expect(res.json().details.errorCount).toBeGreaterThan(0);
        expect(typeof res.json().details.errors[0].message).toBe("string");
      }
      expect(await snapshot(wb)).toEqual(before);
    });

    it("rejects malformed requests, and server-owned fields", async () => {
      const u = await user();
      const wb = await book(u);
      const bad: unknown[] = [
        {},
        { name: "x" },
        { type: "input" },
        { name: "", type: "input" },
        { name: "x".repeat(201), type: "input" },
        { name: "nul\u0000", type: "input" },
        { name: "x", type: "derived" },
        { name: "x", type: "input", id: MISSING },
        { name: "x", type: "input", workbookId: MISSING },
        { name: "x", type: "input", workspaceId: u.workspaceId },
        { name: "x", type: "input", position: -1 },
        { name: "x", type: "input", position: 1.5 },
        { name: "x", type: "input", width: 59 },
        { name: "x", type: "input", width: 1001 },
        { name: "x", type: "input", width: "100" },
        { name: "x", type: "input", hidden: "yes" },
        { name: "x", type: "input", config: [] },
        [],
      ];
      for (const body of bad) {
        const res = await call(u, "POST", `/${wb}/columns`, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(422);
        expect(res.json().code).toBe("VALIDATION_FAILED");
      }
      expect((await call(u, "POST", `/${wb}/columns`, "{nope")).statusCode).toBe(400);
      expect(await columnsOf(wb)).toEqual([]);
    });

    it("requires the targets of enrichment and action columns to belong to this workspace", async () => {
      const u = await user();
      const other = await user();
      const theirs = await targets(other);
      const wb = await book(u);
      const { ref } = await sources(u, wb);
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ type: "action", operation: "add_to_sequence", config: { sequenceId: theirs.sequenceId, emailColumn: ref("email") } }, "sequenceId"],
        [{ type: "action", operation: "add_to_list", config: { listId: theirs.listId } }, "listId"],
        [{ type: "action", operation: "push_to_crm", config: { provider: "hubspot", object: "contact", mapping: [{ crmField: "email", ...ref("email") }] } }, "provider"],
        [{ type: "enrichment", operation: "find_email", config: { inputs: { linkedinUrl: ref("linkedin") }, waterfall: { steps: [{ source: "skout", enabled: true }, { source: "own_key", provider: "hunter", enabled: true }] } } }, "waterfall.steps.1.provider"],
      ];
      for (const [body, path] of cases) {
        const res = await post(u, wb, { name: "x", ...body });
        expect(res.statusCode, res.body).toBe(422);
        expect(res.json().details.errors).toEqual([expect.objectContaining({ path })]);
      }
      // Once the workspace has them, the same settings are accepted, and a key that stopped working is not.
      const mine = await targets(u);
      await add(u, wb, { type: "action", operation: "add_to_list", config: { listId: mine.listId } });
      await db.update(workspaceIntegrations).set({ status: "invalid" }).where(eq(workspaceIntegrations.workspaceId, u.workspaceId));
      await db.update(crmConnections).set({ status: "disconnected" }).where(eq(crmConnections.workspaceId, u.workspaceId));
      for (const [body] of cases.slice(2)) expect((await post(u, wb, { name: "x", ...body })).statusCode).toBe(422);
    });

    it("stops at 200 columns", async () => {
      const u = await user();
      const wb = await book(u);
      await db.insert(workbookColumns).values(Array.from({ length: 199 }, (_, position) => ({ workbookId: wb, name: `c${position}`, type: "input" as const, position })));
      await add(u, wb, { type: "input" });
      const res = await post(u, wb, { name: "one too many", type: "input" });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: "COLUMN_LIMIT_EXCEEDED", details: { limit: 200 } });
      expect(await columnsOf(wb)).toHaveLength(200);
    });

    it("applies an Idempotency-Key once", async () => {
      const u = await user();
      const wb = await book(u);
      const key = { "idempotency-key": randomUUID() };
      const first = await call(u, "POST", `/${wb}/columns`, { name: "once", type: "input" }, key);
      const again = await call(u, "POST", `/${wb}/columns`, { name: "once", type: "input" }, key);
      expect([first.statusCode, again.statusCode]).toEqual([201, 201]);
      expect(again.json()).toEqual(first.json());
      expect(await columnsOf(wb)).toHaveLength(1);
    });

    it("keeps positions unique when columns are added at the same time", async () => {
      const u = await user();
      const wb = await book(u);
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => post(u, wb, { name: `p${i}`, type: "input", ...(i % 2 ? { position: 0 } : {}) })));
      expect(results.map((r) => r.statusCode)).toEqual(Array(12).fill(201));
      expect(await positions(wb)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    });
  });

  // ── References ──────────────────────────────────────────────────────────────

  describe("column references", () => {
    it("rejects a column of another workbook everywhere it can be referred to", async () => {
      const u = await user();
      const stranger = await user();
      const wb = await book(u);
      const { ref } = await sources(u, wb);
      const sibling = await book(u, "same workspace");
      const foreign = await book(stranger, "other workspace");
      await targets(u);
      const before = await snapshot(wb);
      for (const [owner, otherBook] of [[u, sibling], [stranger, foreign]] as const) {
        const away = { columnId: (await input(owner, otherBook, "email")).id };
        const cases: Array<Record<string, unknown>> = [
          { type: "enrichment", operation: "verify_email", config: { inputs: { email: away } } },
          { type: "enrichment", operation: "verify_email", config: { inputs: { email: ref("email") }, condition: { rules: [{ ...away, op: "has_value" }] } } },
          { type: "ai", config: { prompt: `Use {{${away.columnId}}}`, output: { type: "text" } } },
          { type: "formula", config: { fn: "join", parts: [ref("name"), away] } },
          { type: "formula", config: { fn: "if_then_else", condition: { rules: [{ ...ref("name"), op: "has_value" }] }, then: away, else: { value: null } } },
          { type: "action", operation: "send_to_webhook", config: { url: "https://hooks.example.com/x", columns: [away] } },
          { type: "action", operation: "push_to_crm", config: { provider: "hubspot", object: "contact", mapping: [{ crmField: "email", ...away }] } },
          { type: "formula", config: { fn: "trim_clean", source: { columnId: MISSING } } },
        ];
        for (const body of cases) {
          const res = await post(u, wb, { name: "x", ...body });
          expect(res.statusCode, `${JSON.stringify(body)} ${res.body}`).toBe(422);
          expect(res.json().details.errors[0].message).toBe("This workbook has no such column");
        }
      }
      expect(await snapshot(wb)).toEqual(before);
    });

    it("refuses reading an action column, a field that is not there, itself, or a circle", async () => {
      const u = await user();
      const wb = await book(u);
      const { ref } = await sources(u, wb);
      const { listId } = await targets(u);
      const action = await add(u, wb, { type: "action", operation: "add_to_list", config: { listId } });
      const company = await add(u, wb, { type: "enrichment", operation: "company_data", config: { inputs: { companyDomain: ref("domain") }, fields: ["industry"] } });
      for (const source of [{ columnId: action.id }, { columnId: company.id }, { columnId: company.id, field: "headcount" }, { ...ref("name"), field: "x" }]) {
        expect((await post(u, wb, { name: "x", type: "formula", config: { fn: "trim_clean", source } })).statusCode, JSON.stringify(source)).toBe(422);
      }
      const first = await add(u, wb, { name: "first", type: "formula", config: { fn: "trim_clean", source: ref("name") } });
      const second = await add(u, wb, { name: "second", type: "formula", config: { fn: "trim_clean", source: { columnId: first.id } } });
      const third = await add(u, wb, { name: "third", type: "formula", config: { fn: "trim_clean", source: { columnId: second.id } } });
      const before = await snapshot(wb);
      const self = await call(u, "PATCH", `/${wb}/columns/${first.id}`, { config: { fn: "trim_clean", source: { columnId: first.id } } });
      expect(self.json().details.errors[0].message).toBe("A column cannot refer to itself");
      const circle = await call(u, "PATCH", `/${wb}/columns/${first.id}`, { config: { fn: "trim_clean", source: { columnId: third.id } } });
      expect(circle.statusCode, circle.body).toBe(422);
      expect(circle.json().details.errors[0].message).toMatch(/circle/);
      expect(await snapshot(wb)).toEqual(before);
    });

    it("keeps references pointing at their own columns in a duplicate", async () => {
      const u = await user();
      const wb = await book(u);
      const { ids, ref } = await sources(u, wb);
      const company = await add(u, wb, { name: "co", type: "enrichment", operation: "company_data", config: { inputs: { companyDomain: ref("domain") }, fields: ["industry"] } });
      await add(u, wb, { name: "ai", type: "ai", config: { prompt: `{{${ids.name}}} in {{${company.id}.industry}}`, output: { type: "text" } } });
      const copy = (await call(u, "POST", `/${wb}/duplicate`, { includeRows: false })).json().data;
      const columns = copy.columns as Column[];
      const by = Object.fromEntries(columns.map((c) => [c.name, c]));
      expect(by.ai!.config.prompt).toBe(`{{${by.name!.id}}} in {{${by.co!.id}.industry}}`);
      expect(by.co!.config.inputs.companyDomain.columnId).toBe(by.domain!.id);
      // The copied settings are still valid there.
      const res = await call(u, "PATCH", `/${copy.id}/columns/${by.ai!.id}`, { config: by.ai!.config });
      expect(res.statusCode, res.body).toBe(200);
    });
  });

  // ── Edit ────────────────────────────────────────────────────────────────────

  describe("PATCH /columns/:columnId", () => {
    it("renames and changes settings without touching other columns or cells", async () => {
      const u = await user();
      const wb = await book(u);
      const { ids, ref } = await sources(u, wb);
      const formula = await add(u, wb, { name: "old", type: "formula", config: { fn: "trim_clean", source: ref("name") } });
      await addRows(u, wb, [{ [ids.name]: "Ada" }]);
      const before = await snapshot(wb);
      const res = await call(u, "PATCH", `/${wb}/columns/${formula.id.toUpperCase()}`, { name: " New name ", config: { fn: "change_case", source: ref("name"), case: "upper" } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toMatchObject({ id: formula.id, name: "New name", position: formula.position, config: { fn: "change_case", case: "upper" } });
      expect(res.json().columns).toHaveLength(7);
      const after = await snapshot(wb);
      expect(after.cells).toEqual(before.cells);
      expect(after.columns.filter((c) => c.id !== formula.id)).toEqual(before.columns.filter((c) => c.id !== formula.id));
      expect(after.workbook.updatedAt.getTime()).toBeGreaterThan(before.workbook.updatedAt.getTime());
    });

    it("validates new settings against the column's own type and refuses changing type or operation", async () => {
      const u = await user();
      const wb = await book(u);
      const { ids, ref } = await sources(u, wb);
      const { listId } = await targets(u);
      const columns = {
        input: ids.name,
        enrichment: (await add(u, wb, { type: "enrichment", operation: "verify_email", config: { inputs: { email: ref("email") } } })).id,
        ai: (await add(u, wb, { type: "ai", config: { prompt: "x", output: { type: "text" } } })).id,
        formula: (await add(u, wb, { type: "formula", config: { fn: "trim_clean", source: ref("name") } })).id,
        action: (await add(u, wb, { type: "action", operation: "add_to_list", config: { listId } })).id,
      };
      const wrong: Record<keyof typeof columns, unknown> = {
        input: { fn: "trim_clean", source: ref("email") },
        enrichment: { dataType: "text" },
        ai: { fn: "trim_clean", source: ref("name") },
        formula: { prompt: "x", output: { type: "text" } },
        action: { listId, url: "https://hooks.example.com" },
      };
      const before = await snapshot(wb);
      for (const [type, id] of Object.entries(columns)) {
        const res = await call(u, "PATCH", `/${wb}/columns/${id}`, { name: "changed", config: wrong[type as keyof typeof columns] });
        expect(res.statusCode, `${type} ${res.body}`).toBe(422);
        expect(res.json().code).toBe("INVALID_COLUMN_CONFIG");
      }
      for (const body of [{}, { type: "ai" }, { operation: "find_email" }, { position: 0 }, { name: "" }, { width: 10 }, { config: "x" }, { name: "x", workbookId: MISSING }]) {
        const res = await call(u, "PATCH", `/${wb}/columns/${columns.input}`, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(422);
        expect(res.json().code).toBe("VALIDATION_FAILED");
      }
      expect(await snapshot(wb)).toEqual(before);
    });

    it("lets a column be renamed after its provider key was removed", async () => {
      const u = await user();
      const wb = await book(u);
      const { ref } = await sources(u, wb);
      await targets(u);
      const column = await add(u, wb, { type: "enrichment", operation: "find_email", config: { inputs: { linkedinUrl: ref("linkedin") }, waterfall: { steps: [{ source: "skout", enabled: true }, { source: "own_key", provider: "hunter", enabled: true }] } } });
      await db.delete(workspaceIntegrations).where(eq(workspaceIntegrations.workspaceId, u.workspaceId));
      expect((await call(u, "PATCH", `/${wb}/columns/${column.id}`, { name: "Email", width: 200 })).statusCode).toBe(200);
      expect((await call(u, "PATCH", `/${wb}/columns/${column.id}`, { config: column.config })).statusCode).toBe(422);
    });

    it("re-reads cells when an input column changes type, keeping what does not fit and flagging it", async () => {
      const u = await user();
      const wb = await book(u);
      const column = await input(u, wb, "text");
      const other = await input(u, wb, "text", { name: "other" });
      const typed = ["42", " 7 ", "many", "100", "a@example.com"];
      await addRows(u, wb, typed.map((v) => ({ [column.id]: v, [other.id]: "1" })));
      const values = async () => (await cellsOf(wb)).filter((c) => c.columnId === column.id).map((c) => [c.value, c.state, c.errorCode]);
      const untouched = async () => (await cellsOf(wb)).filter((c) => c.columnId === other.id);
      const others = await untouched();

      const res = await call(u, "PATCH", `/${wb}/columns/${column.id}`, { config: { dataType: "number" } });
      expect(res.statusCode, res.body).toBe(200);
      expect(await values()).toEqual([
        [42, "found", null],
        [7, "found", null],
        ["many", "error", "invalid_number"],
        [100, "found", null],
        ["a@example.com", "error", "invalid_number"],
      ]);
      const sorted = (await call(u, "POST", `/${wb}/rows/query`, { sort: [{ columnId: column.id }] })).json().data;
      expect(sorted.slice(0, 3).map((r: any) => r.cells[column.id].value)).toEqual([7, 42, 100]);

      await call(u, "PATCH", `/${wb}/columns/${column.id}`, { config: { dataType: "email" } });
      expect(await values()).toEqual([
        [42, "error", "invalid_email"],
        [7, "error", "invalid_email"],
        ["many", "error", "invalid_email"],
        [100, "error", "invalid_email"],
        ["a@example.com", "found", null],
      ]);
      await call(u, "PATCH", `/${wb}/columns/${column.id}`, { config: { dataType: "text" } });
      expect((await values()).map(([v, s]) => [v, s])).toEqual([["42", "found"], ["7", "found"], ["many", "found"], ["100", "found"], ["a@example.com", "found"]]);
      expect(await untouched()).toEqual(others);
    });

    it("re-reads every cell of a column larger than one batch", async () => {
      const u = await user();
      const wb = await book(u);
      const column = await input(u, wb, "text");
      for (let start = 0; start < 6_000; start += 1_000) await addRows(u, wb, Array.from({ length: 1_000 }, (_, i) => ({ [column.id]: String(start + i) })));
      expect((await call(u, "PATCH", `/${wb}/columns/${column.id}`, { config: { dataType: "number" } })).statusCode).toBe(200);
      const [counts] = await sql`select count(*) filter (where jsonb_typeof(value) = 'number' and state = 'found')::int as numbers, count(*)::int as total, sum((value #>> '{}')::numeric)::bigint as sum from workbook_cells where workbook_id = ${wb}`;
      expect(counts).toMatchObject({ numbers: 6_000, total: 6_000 });
      expect(Number(counts!.sum)).toBe((5_999 * 6_000) / 2);
    });

    it("refuses a change that would break a column reading this one", async () => {
      const u = await user();
      const wb = await book(u);
      const { ids, ref } = await sources(u, wb);
      const company = await add(u, wb, { name: "co", type: "enrichment", operation: "company_data", config: { inputs: { companyDomain: ref("domain") }, fields: ["industry", "headcount"] } });
      await add(u, wb, { name: "big", type: "formula", config: { fn: "number_format", source: { columnId: company.id, field: "headcount" } } });
      await add(u, wb, { name: "verify", type: "enrichment", operation: "verify_email", config: { inputs: { email: ref("email") } } });
      await addRows(u, wb, [{ [ids.email]: "a@example.com" }]);
      const before = await snapshot(wb);
      const fields = await call(u, "PATCH", `/${wb}/columns/${company.id}`, { config: { inputs: { companyDomain: ref("domain") }, fields: ["industry"] } });
      expect(fields.statusCode, fields.body).toBe(409);
      expect(fields.json()).toMatchObject({ code: "COLUMN_IN_USE", details: { dependents: [{ name: "big" }] } });
      const retype = await call(u, "PATCH", `/${wb}/columns/${ids.email}`, { config: { dataType: "checkbox" } });
      expect(retype.statusCode).toBe(409);
      expect(retype.json().details.dependents).toEqual([expect.objectContaining({ name: "verify" })]);
      expect(await snapshot(wb)).toEqual(before);
      // A change they can live with goes through.
      expect((await call(u, "PATCH", `/${wb}/columns/${ids.email}`, { config: { dataType: "text" } })).statusCode).toBe(200);
      expect((await call(u, "PATCH", `/${wb}/columns/${company.id}`, { config: { inputs: { companyDomain: ref("domain") }, fields: ["headcount", "location"] } })).statusCode).toBe(200);
    });
  });

  describe("PATCH /columns/:columnId with columns further down the chain", () => {
    it("refuses a change that would break a column reading it through a formula", async () => {
      const u = await user();
      const wb = await book(u);
      const email = await input(u, wb, "email");
      const backup = await input(u, wb, "email", { name: "backup" });
      const best = await add(u, wb, { name: "best", type: "formula", config: { fn: "first_non_empty", sources: [{ columnId: email.id }, { columnId: backup.id }] } });
      const cleaned = await add(u, wb, { name: "choice", type: "formula", config: { fn: "if_then_else", condition: { rules: [{ columnId: email.id, op: "has_value" }] }, then: { columnId: best.id }, else: { columnId: backup.id } } });
      await add(u, wb, { name: "verify", type: "enrichment", operation: "verify_email", config: { inputs: { email: { columnId: cleaned.id } } } });
      const before = await snapshot(wb);
      // The chain stays readable while the first source is text.
      expect((await call(u, "PATCH", `/${wb}/columns/${email.id}`, { config: { dataType: "text" } })).statusCode).toBe(200);
      await call(u, "PATCH", `/${wb}/columns/${email.id}`, { config: { dataType: "email" } });
      const unreadable = await call(u, "PATCH", `/${wb}/columns/${best.id}`, { config: { fn: "date_part", source: { columnId: backup.id }, part: "year" } });
      expect(unreadable.statusCode, unreadable.body).toBe(422); // an email column has no year
      const direct = await call(u, "PATCH", `/${wb}/columns/${cleaned.id}`, { config: { fn: "extract_domain", source: { columnId: email.id } } });
      expect(direct.statusCode, direct.body).toBe(409); // "verify" would be reading domains
      const mixed = await call(u, "PATCH", `/${wb}/columns/${best.id}`, { config: { fn: "extract_domain", source: { columnId: email.id } } });
      expect(mixed.statusCode, mixed.body).toBe(200); // domain and email together read as text, which "verify" accepts
      const both = await call(u, "PATCH", `/${wb}/columns/${backup.id}`, { config: { dataType: "domain" } });
      expect(both.statusCode, both.body).toBe(409); // now every branch is a domain, two steps above "verify"
      expect(both.json().details.dependents).toEqual([expect.objectContaining({ name: "verify" })]);
      expect((await columnsOf(wb)).find((c) => c.id === backup.id)!.config).toEqual(before.columns.find((c) => c.id === backup.id)!.config);
    });
  });

  // ── Hide, freeze, resize ────────────────────────────────────────────────────

  describe("hide, freeze and resize", () => {
    async function four() {
      const u = await user();
      const wb = await book(u);
      const ids: string[] = [];
      for (const name of ["a", "b", "c", "d"]) ids.push((await add(u, wb, { name, type: "input" })).id);
      const [a, b, c, d] = ids as [string, string, string, string];
      await addRows(u, wb, [{ [a]: "1", [b]: "2", [c]: "3", [d]: "4" }]);
      const patch = (id: string, body: unknown) => call(u, "PATCH", `/${wb}/columns/${id}`, body);
      const frozen = async () => (await columnsOf(wb)).filter((x) => x.frozen).map((x) => x.name);
      return { u, wb, a, b, c, d, patch, frozen };
    }

    it("hides and shows a column, keeping its place, settings and cells", async () => {
      const { wb, b, patch } = await four();
      const before = await snapshot(wb);
      const hide = await patch(b, { hidden: true });
      expect(hide.json().data).toMatchObject({ hidden: true, position: 1 });
      const hidden = await snapshot(wb);
      expect(hidden.cells).toEqual(before.cells);
      expect(hidden.columns.map((c) => [c.name, c.position, c.hidden])).toEqual([["a", 0, false], ["b", 1, true], ["c", 2, false], ["d", 3, false]]);
      expect((await patch(b, { hidden: false })).json().data.hidden).toBe(false);
      expect((await columnsOf(wb)).map((c) => c.config)).toEqual(before.columns.map((c) => c.config));
      expect(await cellsOf(wb)).toEqual(before.cells);
    });

    it("moves a column to the frozen block when frozen, and out of it when unfrozen", async () => {
      const { wb, c, d, patch, frozen } = await four();
      const before = await cellsOf(wb);
      const first = await patch(c, { frozen: true });
      expect(first.json().data).toMatchObject({ frozen: true, position: 0 });
      expect(first.json().columns.map((x: Column) => x.name)).toEqual(["c", "a", "b", "d"]);
      await patch(d, { frozen: true });
      expect(await names(wb)).toEqual(["c", "d", "a", "b"]);
      expect(await frozen()).toEqual(["c", "d"]);
      await patch(d, { frozen: true }); // already frozen: nothing moves
      expect(await names(wb)).toEqual(["c", "d", "a", "b"]);
      const un = await patch(c, { frozen: false });
      expect(un.json().data).toMatchObject({ frozen: false, position: 1 });
      expect(await names(wb)).toEqual(["d", "c", "a", "b"]);
      expect(await positions(wb)).toEqual([0, 1, 2, 3]);
      expect(await cellsOf(wb)).toEqual(before);
    });

    it("places new columns so frozen ones stay first", async () => {
      const { u, wb, a, patch } = await four();
      await patch(a, { frozen: true });
      await add(u, wb, { name: "f", type: "input", frozen: true });
      await add(u, wb, { name: "z", type: "input" });
      expect(await names(wb)).toEqual(["a", "f", "b", "c", "d", "z"]);
      for (const body of [{ position: 0 }, { frozen: true, position: 4 }]) {
        const res = await post(u, wb, { name: "no", type: "input", ...body });
        expect(res.statusCode, JSON.stringify(body)).toBe(422);
        expect(res.json().code).toBe("COLUMN_ORDER_INVALID");
      }
      expect(await columnsOf(wb)).toHaveLength(6);
    });

    it("saves a width and refuses unreasonable ones", async () => {
      const { wb, b, patch } = await four();
      for (const width of [60, 333, 1000]) {
        expect((await patch(b, { width })).json().data.width).toBe(width);
        expect((await columnsOf(wb))[1]!.width).toBe(width);
      }
      for (const width of [0, 59, 1001, -100, 100.5, "200", null, 1e12]) {
        const res = await patch(b, { width });
        expect(res.statusCode, String(width)).toBe(422);
      }
      expect((await columnsOf(wb))[1]!.width).toBe(1000);
    });
  });

  // ── Reorder ─────────────────────────────────────────────────────────────────

  describe("POST /columns/reorder", () => {
    async function five() {
      const u = await user();
      const wb = await book(u);
      const ids: string[] = [];
      for (const name of ["a", "b", "c", "d", "e"]) ids.push((await add(u, wb, { name, type: "input" })).id);
      await addRows(u, wb, [Object.fromEntries(ids.map((id, i) => [id, `v${i}`]))]);
      const reorder = (columnIds: string[], previousColumnIds?: string[]) => call(u, "POST", `/${wb}/columns/reorder`, { columnIds, ...(previousColumnIds ? { previousColumnIds } : {}) });
      return { u, wb, ids, reorder };
    }

    it("puts the columns in the given order and changes nothing else", async () => {
      const { wb, ids, reorder } = await five();
      const before = await snapshot(wb);
      const [a, b, c, d, e] = ids as [string, string, string, string, string];
      const res = await reorder([e, c.toUpperCase(), a, d, b], ids);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data.map((x: Column) => [x.name, x.position])).toEqual([["e", 0], ["c", 1], ["a", 2], ["d", 3], ["b", 4]]);
      expect(await names(wb)).toEqual(["e", "c", "a", "d", "b"]);
      const after = await snapshot(wb);
      expect(after.cells).toEqual(before.cells);
      const strip = (columns: typeof after.columns) => columns.map(({ position: _p, updatedAt: _u, ...rest }) => rest).sort((x, y) => x.name.localeCompare(y.name));
      expect(strip(after.columns)).toEqual(strip(before.columns));
      expect(after.workbook.updatedAt.getTime()).toBeGreaterThan(before.workbook.updatedAt.getTime());
    });

    it("refuses a list that is out of date, incomplete or foreign, and changes nothing", async () => {
      const { u, wb, ids, reorder } = await five();
      const elsewhere = (await input(u, await book(u, "other"))).id;
      const before = await snapshot(wb);
      for (const columnIds of [ids.slice(1), [...ids, MISSING], [...ids.slice(1), elsewhere], []]) {
        const res = await reorder(columnIds);
        expect(res.statusCode, JSON.stringify(columnIds)).toBe(409);
        expect(res.json()).toMatchObject({ code: "COLUMN_ORDER_CONFLICT", details: { columnIds: ids } });
      }
      const stale = await reorder([...ids].reverse(), [...ids].reverse());
      expect(stale.statusCode).toBe(409);
      for (const body of [{}, { columnIds: [ids[0], ids[0]] }, { columnIds: [ids[0], ids[0]!.toUpperCase()] }, { columnIds: ["x"] }, { columnIds: ids, force: true }, { columnIds: Array.from({ length: 201 }, () => randomUUID()) }]) {
        expect((await call(u, "POST", `/${wb}/columns/reorder`, body)).statusCode, JSON.stringify(body).slice(0, 80)).toBe(422);
      }
      expect(await snapshot(wb)).toEqual(before);
    });

    it("lets only one of two reorders from the same starting order win", async () => {
      const { wb, ids, reorder } = await five();
      const one = [...ids].reverse();
      const two = [ids[1]!, ids[0]!, ids[2]!, ids[3]!, ids[4]!];
      const results = await Promise.all([reorder(one, ids), reorder(two, ids)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const winner = results[0]!.statusCode === 200 ? one : two;
      expect((await columnsOf(wb)).map((c) => c.id)).toEqual(winner);
      expect(await positions(wb)).toEqual([0, 1, 2, 3, 4]);
    });

    it("stays consistent while columns are reordered, added and deleted together", async () => {
      const { u, wb, ids, reorder } = await five();
      await Promise.all([
        reorder([...ids].reverse()),
        post(u, wb, { name: "f", type: "input" }),
        call(u, "DELETE", `/${wb}/columns/${ids[2]}`),
        post(u, wb, { name: "g", type: "input", position: 0 }),
        reorder(ids),
        call(u, "DELETE", `/${wb}/columns/${ids[0]}`),
      ]);
      expect(await positions(wb)).toEqual([0, 1, 2, 3, 4]);
      expect((await names(wb)).sort()).toEqual(["b", "d", "e", "f", "g"]);
    });

    it("keeps frozen columns first", async () => {
      const { u, wb, ids, reorder } = await five();
      const [a, b, c, d, e] = ids as [string, string, string, string, string];
      await call(u, "PATCH", `/${wb}/columns/${a}`, { frozen: true });
      await call(u, "PATCH", `/${wb}/columns/${b}`, { frozen: true });
      const res = await reorder([a, c, b, d, e]);
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe("COLUMN_ORDER_INVALID");
      expect(await names(wb)).toEqual(["a", "b", "c", "d", "e"]);
      expect((await reorder([b, a, e, d, c])).statusCode).toBe(200);
      expect(await names(wb)).toEqual(["b", "a", "e", "d", "c"]);
    });
  });

  // ── Delete ──────────────────────────────────────────────────────────────────

  describe("DELETE /columns/:columnId", () => {
    it("removes the column, its cells and its runs, and renumbers the rest", async () => {
      const u = await user();
      const wb = await book(u);
      const a = await input(u, wb, "text", { name: "a" });
      const b = await input(u, wb, "text", { name: "b" });
      const c = await input(u, wb, "text", { name: "c" });
      const rows = await addRows(u, wb, Array.from({ length: 20 }, (_, i) => ({ [a.id]: `a${i}`, [b.id]: `b${i}`, [c.id]: `c${i}` })));
      await db.insert(workbookRuns).values([
        { workbookId: wb, columnId: b.id, scope: "all", status: "completed" },
        { workbookId: wb, columnId: c.id, scope: "all", status: "completed" },
      ]);
      await db.insert(workbookViews).values([
        { workbookId: wb, name: "uses b", hiddenColumns: [b.id, c.id], sorts: [{ columnId: b.id }, { columnId: a.id }], filters: [{ columnId: b.id.toUpperCase(), op: "has_value" }] },
        { workbookId: wb, name: "does not", hiddenColumns: [a.id] },
      ]);
      const sibling = await book(u, "sibling");
      const theirs = await input(u, sibling);
      await addRows(u, sibling, [{ [theirs.id]: "keep" }]);
      const before = await snapshot(wb);

      const res = await call(u, "DELETE", `/${wb}/columns/${b.id}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toEqual({ id: b.id });
      expect(res.json().columns.map((x: Column) => [x.name, x.position])).toEqual([["a", 0], ["c", 1]]);

      const after = await snapshot(wb);
      expect(after.cells).toEqual(before.cells.filter((cell) => cell.columnId !== b.id));
      expect(after.cells).toHaveLength(40);
      expect(after.workbook.rowCount).toBe(rows.length);
      expect((await db.select().from(workbookRuns).where(eq(workbookRuns.workbookId, wb))).map((r) => r.columnId)).toEqual([c.id]);
      const views = await db.select().from(workbookViews).where(eq(workbookViews.workbookId, wb)).orderBy(asc(workbookViews.name));
      expect(views.map((v) => [v.name, v.hiddenColumns, v.sorts, v.filters])).toEqual([
        ["does not", [a.id], [], []],
        ["uses b", [c.id], [{ columnId: a.id }], []],
      ]);
      const [orphans] = await sql`select count(*)::int as n from workbook_cells x where x.workbook_id = ${wb} and not exists (select 1 from workbook_columns c where c.workbook_id = x.workbook_id and c.id = x.column_id)`;
      expect(orphans!.n).toBe(0);
      expect(await cellsOf(sibling)).toHaveLength(1);

      const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.workspaceId, u.workspaceId), eq(auditLogs.action, "workbook.column.delete")));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorId: u.userId, entityId: wb, beforeState: { columnId: b.id, name: "b", type: "input" } });
      // The rows still read, and a second delete finds nothing.
      expect((await call(u, "GET", `/${wb}/rows`)).json().data[0].cells).not.toHaveProperty(b.id);
      expect((await call(u, "DELETE", `/${wb}/columns/${b.id}`)).statusCode).toBe(404);
    });

    it("refuses while another column uses it, in any kind of reference", async () => {
      const u = await user();
      const wb = await book(u);
      const { ids, ref } = await sources(u, wb);
      const { listId } = await targets(u);
      const users: Array<[keyof typeof ids, Record<string, unknown>]> = [
        ["email", { type: "enrichment", operation: "verify_email", config: { inputs: { email: ref("email") } } }],
        ["name", { type: "ai", config: { prompt: `Hi {{${ids.name}}}`, output: { type: "text" } } }],
        ["number", { type: "action", operation: "add_to_list", config: { listId, condition: { rules: [{ ...ref("number"), op: "gt", value: 1 }] } } }],
        ["date", { type: "formula", config: { fn: "date_part", source: ref("date"), part: "year" } }],
      ];
      for (const [target, body] of users) {
        const dependent = await add(u, wb, { name: `uses ${target}`, ...body });
        const before = await snapshot(wb);
        const res = await call(u, "DELETE", `/${wb}/columns/${ids[target]}`);
        expect(res.statusCode, `${target} ${res.body}`).toBe(409);
        expect(res.json()).toMatchObject({ code: "COLUMN_IN_USE", details: { dependents: [{ columnId: dependent.id, name: `uses ${target}` }] } });
        expect(await snapshot(wb)).toEqual(before);
        // Delete the user of the column first, then the column.
        expect((await call(u, "DELETE", `/${wb}/columns/${dependent.id}`)).statusCode).toBe(200);
        expect((await call(u, "DELETE", `/${wb}/columns/${ids[target]}`)).statusCode).toBe(200);
      }
    });

    it("protects a column named by settings it cannot parse", async () => {
      const u = await user();
      const wb = await book(u);
      const a = await input(u, wb);
      await db.insert(workbookColumns).values({ workbookId: wb, name: "older", type: "formula", position: 1, config: { template: `{{${a.id}}}` } });
      expect((await call(u, "DELETE", `/${wb}/columns/${a.id}`)).json().code).toBe("COLUMN_IN_USE");
    });

    it("leaves no stray cells when rows are written while the column is deleted", async () => {
      const u = await user();
      const wb = await book(u);
      const keep = await input(u, wb);
      const doomed = await input(u, wb);
      const writes = Array.from({ length: 6 }, () => call(u, "POST", `/${wb}/rows/bulk`, { rows: Array.from({ length: 50 }, () => ({ cells: { [keep.id]: "k", [doomed.id]: "d" } })) }));
      const [deleted, ...results] = await Promise.all([call(u, "DELETE", `/${wb}/columns/${doomed.id}`), ...writes]);
      expect(deleted.statusCode).toBe(200);
      // A write that arrived after the delete is refused whole; none fails halfway.
      for (const r of results) expect([201, 422], r.body.slice(0, 200)).toContain(r.statusCode);
      const cells = await cellsOf(wb);
      expect(cells.every((c) => c.columnId === keep.id)).toBe(true);
      expect(cells).toHaveLength((await stored(wb)).rowCount);
    });
  });

  // ── Security ────────────────────────────────────────────────────────────────

  describe("access control", () => {
    const attempts = (wb: string, columnId: string): Array<[Method, string, unknown?]> => [
      ["POST", `/${wb}/columns`, { name: "intruder", type: "input" }],
      ["POST", `/${wb}/columns/reorder`, { columnIds: [columnId] }],
      ["PATCH", `/${wb}/columns/${columnId}`, { name: "intruder", hidden: true }],
      ["DELETE", `/${wb}/columns/${columnId}`],
    ];

    async function victim() {
      const owner = await user();
      const wb = await book(owner);
      const column = await input(owner, wb, "text", { name: "victim-secret" });
      await addRows(owner, wb, [{ [column.id]: "value" }]);
      return { owner, wb, column };
    }

    it("returns 404 for missing workbooks and columns, and 422 for malformed ids", async () => {
      const { owner, wb, column } = await victim();
      for (const [method, path, body] of attempts(MISSING, column.id)) expect((await call(owner, method, path, body)).statusCode, `${method} ${path}`).toBe(404);
      for (const [method, path, body] of attempts(wb, MISSING).slice(2)) expect((await call(owner, method, path, body)).statusCode, `${method} ${path}`).toBe(404);
      for (const [method, path, body] of attempts("nope", column.id)) expect((await call(owner, method, path, body)).statusCode, `${method} ${path}`).toBe(422);
      for (const [method, path, body] of attempts(wb, "nope").slice(2)) expect((await call(owner, method, path, body)).statusCode, `${method} ${path}`).toBe(422);
      // Another workbook's column is not a column of this one.
      const second = await book(owner, "second");
      for (const [method, path, body] of attempts(second, column.id).slice(2)) expect((await call(owner, method, path, body)).statusCode, `${method} ${path}`).toBe(404);
      expect((await columnsOf(wb)).map((c) => c.name)).toEqual(["victim-secret"]);
    });

    it("treats a deleted workbook as not found", async () => {
      const { owner, wb, column } = await victim();
      expect((await call(owner, "DELETE", `/${wb}`)).statusCode).toBeLessThan(300);
      const before = await snapshot(wb);
      for (const [method, path, body] of attempts(wb, column.id)) expect((await call(owner, method, path, body)).statusCode, `${method} ${path}`).toBe(404);
      expect(await snapshot(wb)).toEqual(before);
    });

    it("hides another workspace's workbook from every column route, whatever the client claims", async () => {
      const { owner, wb, column } = await victim();
      const intruder = await user();
      const own = await book(intruder);
      const before = await snapshot(wb);
      const claims: Array<Record<string, string>> = [{}, { "x-workspace-id": owner.workspaceId }];
      for (const headers of claims) {
        for (const [method, path, body] of attempts(wb, column.id)) {
          const res = await call(intruder, method, path, body, headers);
          expect([403, 404], `${method} ${path} ${res.body}`).toContain(res.statusCode);
          if (!("x-workspace-id" in headers)) expect(res.statusCode).toBe(404);
          expect(res.body).not.toContain("victim-secret");
        }
      }
      // Nor through the intruder's own workbook.
      for (const [method, path, body] of attempts(own, column.id).slice(2)) expect((await call(intruder, method, path, body)).statusCode).toBe(404);
      expect(await snapshot(wb)).toEqual(before);
    });

    it("lets only members who can edit change columns, and shows viewers a webhook's host only", async () => {
      const { owner, wb, column } = await victim();
      const webhook = await add(owner, wb, { name: "hook", type: "action", operation: "send_to_webhook", config: { url: "https://hooks.example.com/services/T0/very-secret-token?k=very-secret-query", columns: [{ columnId: column.id }] } });
      const viewer = await colleague(owner, ["enrichment:read"]);
      const outsider = await colleague(owner, []);
      const before = await snapshot(wb);
      for (const [method, path, body] of attempts(wb, column.id)) {
        expect((await call(viewer, method, path, body)).statusCode, `viewer ${method} ${path}`).toBe(403);
        expect((await call(outsider, method, path, body)).statusCode, `outsider ${method} ${path}`).toBe(403);
      }
      expect(await snapshot(wb)).toEqual(before);

      const seen = await call(viewer, "GET", `/${wb}`);
      expect(seen.statusCode).toBe(200);
      expect(seen.body).not.toContain("very-secret");
      expect(seen.json().data.columns.find((c: Column) => c.id === webhook.id).config.url).toBe("https://hooks.example.com/…");
      expect(seen.json().data.columns.find((c: Column) => c.id === column.id).config).toEqual({ dataType: "text" });
      expect((await call(owner, "GET", `/${wb}`)).body).toContain("very-secret-token");
    });

    it("never returns a stored provider key", async () => {
      const u = await user();
      const wb = await book(u);
      const { ref } = await sources(u, wb);
      await targets(u);
      const res = await post(u, wb, { name: "e", type: "enrichment", operation: "find_email", config: { inputs: { linkedinUrl: ref("linkedin") }, waterfall: { steps: [{ source: "skout", enabled: true }, { source: "own_key", provider: "hunter", enabled: true }] } } });
      expect(res.statusCode).toBe(201);
      for (const body of [res.body, (await call(u, "GET", `/${wb}`)).body]) expect(body).not.toMatch(/encrypted-secret|abcd/);
    });

    it("is switched off unless the workspace has Workbooks V2, and needs a signed-in user", async () => {
      const { owner, wb, column } = await victim();
      const before = await snapshot(wb);
      await setEntitlement(owner.workspaceId, "feature.workbooks_v2", false);
      for (const [method, path, body] of attempts(wb, column.id)) expect((await call(owner, method, path, body)).statusCode, `${method} ${path}`).toBe(403);
      const anonymous = await buildApp({ ...base, LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, CLERK_SECRET_KEY: "sk_test_unused", CLERK_JWT_ISSUER: "https://clerk.example.test" });
      try {
        for (const [method, path, body] of attempts(wb, column.id)) {
          const res = await anonymous.inject({ method, url: `${URL_BASE}${path}`, ...(body ? { headers: { "content-type": "application/json" }, payload: JSON.stringify(body) } : {}) });
          expect(res.statusCode, `${method} ${path}`).toBe(401);
        }
      } finally {
        await anonymous.close();
      }
      expect(await snapshot(wb)).toEqual(before);
    });
  });
});
