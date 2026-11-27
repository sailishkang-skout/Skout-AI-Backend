import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { invalidateWorkspaceAccess } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { withFailingCellInserts } from "../test/failing-cell-inserts.js";

/**
 * WB2-026: a workbook's inbound webhook, through the real routes against a real database. A second app instance on the
 * same database stands in for another API server.
 */
const base = loadEnv();
const hasDatabase = Boolean(base.DATABASE_URL);
const URL_BASE = "/api/v1/workbooks-v2";
const MISSING = "00000000-0000-4000-8000-0000000000ff";
const { workbooks, workbookColumns, workbookRows, workbookCells, workbookRuns, workbookWebhooks, entitlements, auditLogs, enrichmentJobs, enrichmentResults, creditTransactions, asyncJobs, copsIdempotencyKeys } = schema;

interface Result {
  received: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  rejected: number;
  rowCount: number;
  ignoredFields: string[];
  errors: Array<{ row: number; code: string; message: string }>;
}

describe.skipIf(!hasDatabase)("Workbooks V2 inbound webhook", () => {
  const { db, sql } = createDb(base.DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  const config = {
    ...base,
    CLERK_SECRET_KEY: undefined,
    LOG_LEVEL: "fatal" as const,
    EARLY_ACCESS_GATE_ENABLED: "true" as never,
    RATE_LIMIT_MAX: 100_000,
    PLATFORM_ADMIN_EMAILS: [],
    API_PUBLIC_URL: "https://api.example.test/",
  };
  let app: Awaited<ReturnType<typeof buildApp>>;
  let second: Awaited<ReturnType<typeof buildApp>>;
  let n = 0;
  let sender = 0;

  beforeAll(async () => {
    app = await buildApp(config);
    second = await buildApp(config);
  });
  afterAll(async () => {
    await app.close();
    await second.close();
    await sql.end();
  });

  // ── People, workbooks and webhooks ─────────────────────────────────────────

  interface User {
    userId: string;
    workspaceId: string;
    ip: string;
    headers: Record<string, string>;
  }

  async function person(): Promise<User> {
    n += 1;
    const email = `wb2-webhook-${suffix}-${n}@test.com`;
    const ip = `21.${Math.floor(n / 250)}.${n % 250}.7`;
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
    const other = await person();
    await db.insert(schema.workspaceMembers).values({ workspaceId: owner.workspaceId, userId: other.userId, role: "member" });
    await db.delete(schema.workspaceMemberRoles).where(and(eq(schema.workspaceMemberRoles.workspaceId, owner.workspaceId), eq(schema.workspaceMemberRoles.userId, other.userId)));
    const key = `webhook-${suffix}-${++n}`;
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
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });

  type ColumnSpec = { name: string; type?: "input" | "enrichment" | "formula" | "ai" | "action"; dataType?: string };
  const CONTACT: ColumnSpec[] = [{ name: "Name" }, { name: "Email", dataType: "email" }, { name: "Employees", dataType: "number" }];

  async function workbook(u: User, columns: ColumnSpec[] = CONTACT) {
    const res = await call(u, "POST", "", { name: "Webhook" });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().data.id as string;
    const made = columns.map((c, position) => ({
      id: randomUUID(),
      workbookId: id,
      name: c.name,
      type: c.type ?? ("input" as const),
      operation: c.type === "enrichment" ? "find_email" : c.type === "action" ? "add_to_list" : null,
      position,
      config: !c.type || c.type === "input" ? { dataType: c.dataType ?? "text" } : { inputs: {} },
    }));
    if (made.length) await db.insert(workbookColumns).values(made);
    return { id, col: Object.fromEntries(made.map((c) => [c.name, c.id])) as Record<string, string> };
  }

  interface Hook {
    owner: User;
    workbookId: string;
    col: Record<string, string>;
    id: string;
    token: string;
    /** Where this webhook's caller sends from. */
    ip: string;
  }

  async function webhook(owner?: User, columns?: ColumnSpec[]): Promise<Hook> {
    const u = owner ?? (await person());
    const wb = await workbook(u, columns);
    const res = await call(u, "POST", `/${wb.id}/webhook`);
    expect(res.statusCode, res.body).toBe(201);
    const { webhook: made, token } = res.json().data;
    sender += 1;
    return { owner: u, workbookId: wb.id, col: wb.col, id: made.id, token, ip: `22.${Math.floor(sender / 250)}.${sender % 250}.9` };
  }

  interface Sending {
    token?: string | null;
    headers?: Record<string, string>;
    raw?: string;
    on?: typeof app;
    id?: string;
    ip?: string;
  }
  /** What an outside system does: a POST with the token and nothing of a Skout sign-in. */
  const post = (hook: Hook, body?: unknown, s: Sending = {}) => {
    const token = s.token === undefined ? hook.token : s.token;
    return (s.on ?? app).inject({
      method: "POST",
      url: `/api/v1/webhooks/workbooks/${s.id ?? hook.id}`,
      remoteAddress: s.ip ?? hook.ip,
      headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...s.headers },
      payload: s.raw ?? JSON.stringify(body ?? [{ Name: "Ada" }]),
    });
  };
  const accepted = async (hook: Hook, body: unknown, s: Sending = {}): Promise<Result> => {
    const res = await post(hook, body, s);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data;
  };

  const record = async (hook: Hook) => (await db.select().from(workbookWebhooks).where(eq(workbookWebhooks.id, hook.id)))[0]!;
  const rowsOf = (workbookId: string) => db.select().from(workbookRows).where(eq(workbookRows.workbookId, workbookId)).orderBy(asc(workbookRows.position));
  const rowTotal = async (workbookId: string) => (await rowsOf(workbookId)).length;
  async function table(hook: Hook) {
    const rows = await rowsOf(hook.workbookId);
    const cells = await db.select().from(workbookCells).where(eq(workbookCells.workbookId, hook.workbookId));
    const names = Object.fromEntries(Object.entries(hook.col).map(([name, id]) => [id, name]));
    return rows.map((r) => Object.fromEntries(cells.filter((c) => c.rowId === r.id).map((c) => [names[c.columnId]!, (c.value as { v?: unknown } | null)?.v ?? c.value])));
  }
  const audits = (workbookId: string) => db.select().from(auditLogs).where(and(eq(auditLogs.entityType, "workbook"), eq(auditLogs.entityId, workbookId))).orderBy(asc(auditLogs.createdAt));
  const webhookAudits = async (workbookId: string) => (await audits(workbookId)).filter((a) => a.action.startsWith("workbook.webhook."));
  const actions = async (workbookId: string) => (await webhookAudits(workbookId)).map((a) => a.action.replace("workbook.webhook.", ""));
  const people = (count: number, from = 0) => Array.from({ length: count }, (_, i) => ({ Name: `Person ${from + i}` }));
  /** Moves what the limiter remembers into the past, as time passing would. */
  const age = (hook: Hook, ms: number) =>
    sql`update workbook_webhooks set recent_requests = (select coalesce(jsonb_agg(x::bigint - ${ms}), '[]'::jsonb) from jsonb_array_elements_text(recent_requests) x) where id = ${hook.id}`;

  // ── Managing the webhook ───────────────────────────────────────────────────

  describe("making and changing a webhook", () => {
    it("gives the address and a long random token once, and keeps only the token's hash", async () => {
      const u = await person();
      const wb = await workbook(u);
      expect((await call(u, "GET", `/${wb.id}/webhook`)).json()).toEqual({ data: null });

      const res = await call(u, "POST", `/${wb.id}/webhook`);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.headers["cache-control"]).toBe("no-store");
      const { webhook: made, token } = res.json().data;
      expect(token).toMatch(/^skwh_[A-Za-z0-9_-]{43}$/);
      expect(made).toMatchObject({ url: `https://api.example.test/api/v1/webhooks/workbooks/${made.id}`, enabled: true, dedupe: { key: "none" }, lastUsedAt: null, lastResult: null });
      expect(made.url).not.toContain(token);

      const [stored] = await db.select().from(workbookWebhooks).where(eq(workbookWebhooks.workbookId, wb.id));
      expect(stored!.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
      expect(JSON.stringify(stored)).not.toContain(token.slice(5));

      const read = await call(u, "GET", `/${wb.id}/webhook`);
      expect(read.json().data).toEqual(made);
      expect(read.body).not.toContain(token.slice(5));
      expect(read.body).not.toContain(stored!.tokenHash);
      expect(Object.keys(read.json().data)).not.toEqual(expect.arrayContaining(["token"]));
    });

    it("makes every token different", async () => {
      const a = await webhook();
      const b = await webhook(a.owner);
      expect(a.token).not.toBe(b.token);
      expect(a.id).not.toBe(b.id);
    });

    it("keeps one webhook for a workbook, even when asked twice at once", async () => {
      const u = await person();
      const wb = await workbook(u);
      const both = await Promise.all([call(u, "POST", `/${wb.id}/webhook`), call(u, "POST", `/${wb.id}/webhook`)]);
      expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect(both.find((r) => r.statusCode === 409)!.json().code).toBe("WEBHOOK_EXISTS");
      expect(await db.select().from(workbookWebhooks).where(eq(workbookWebhooks.workbookId, wb.id))).toHaveLength(1);
    });

    it("never stores the answer holding a token for replay", async () => {
      const u = await person();
      const wb = await workbook(u);
      const key = `create-${suffix}-${++n}`;
      const first = await call(u, "POST", `/${wb.id}/webhook`, undefined, { "idempotency-key": key });
      const again = await call(u, "POST", `/${wb.id}/webhook`, undefined, { "idempotency-key": key });
      expect([first.statusCode, again.statusCode]).toEqual([201, 409]);
      const stored = await db.select().from(copsIdempotencyKeys).where(eq(copsIdempotencyKeys.workspaceId, u.workspaceId));
      expect(JSON.stringify(stored)).not.toContain("skwh_");
    });

    it("replaces the token: the old one stops at once and the new one works", async () => {
      const hook = await webhook();
      await accepted(hook, [{ Name: "Before" }]);
      const before = await record(hook);

      const res = await call(hook.owner, "POST", `/${hook.workbookId}/webhook/regenerate`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      const { webhook: after, token } = res.json().data;
      expect(token).not.toBe(hook.token);
      expect(after.id).toBe(hook.id);
      expect(Date.parse(after.tokenCreatedAt)).toBeGreaterThan(before.tokenCreatedAt.getTime());
      expect((await record(hook)).tokenHash).not.toBe(before.tokenHash);

      expect((await post(hook, [{ Name: "Old" }])).statusCode).toBe(401);
      await accepted(hook, [{ Name: "New" }], { token });
      expect(await table(hook)).toEqual([{ Name: "Before" }, { Name: "New" }]);
    });

    it("turns off and on again, keeping the same token", async () => {
      const hook = await webhook();
      const off = await call(hook.owner, "PATCH", `/${hook.workbookId}/webhook`, { enabled: false });
      expect(off.json().data.enabled).toBe(false);
      expect((await post(hook)).statusCode).toBe(401);
      // Refused at the door: the body isn't looked at, and it neither counts against the limit nor marks the webhook used.
      expect((await post(hook, undefined, { raw: "{" })).statusCode).toBe(401);
      expect(await record(hook)).toMatchObject({ recentRequests: [], lastUsedAt: null, lastResult: null });
      expect(await rowTotal(hook.workbookId)).toBe(0);

      expect((await call(hook.owner, "PATCH", `/${hook.workbookId}/webhook`, { enabled: true })).json().data.enabled).toBe(true);
      await accepted(hook, [{ Name: "Ada" }]);
    });

    it("leaves a disabled webhook disabled when its token is replaced", async () => {
      const hook = await webhook();
      await call(hook.owner, "PATCH", `/${hook.workbookId}/webhook`, { enabled: false });
      const { token, webhook: after } = (await call(hook.owner, "POST", `/${hook.workbookId}/webhook/regenerate`)).json().data;
      expect(after.enabled).toBe(false);
      expect((await post(hook, undefined, { token })).statusCode).toBe(401);
    });

    it("answers 404 for changes before there is a webhook", async () => {
      const u = await person();
      const wb = await workbook(u);
      expect((await call(u, "POST", `/${wb.id}/webhook/regenerate`)).statusCode).toBe(404);
      expect((await call(u, "PATCH", `/${wb.id}/webhook`, { enabled: false })).statusCode).toBe(404);
    });

    it("takes only the settings it knows", async () => {
      const hook = await webhook();
      for (const body of [{}, { enabled: "yes" }, { workbookId: MISSING }, { enabled: true, tokenHash: "x" }, { dedupe: { key: "name" } }]) {
        const res = await call(hook.owner, "PATCH", `/${hook.workbookId}/webhook`, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(422);
      }
      expect((await call(hook.owner, "POST", `/${hook.workbookId}/webhook/regenerate`, { token: "mine" })).statusCode).toBe(422);
      expect((await record(hook)).enabled).toBe(true);
    });

    it("accepts a duplicate check only on an input column of this workbook that can hold the key", async () => {
      const hook = await webhook(undefined, [...CONTACT, { name: "Found", type: "enrichment" }]);
      const other = await workbook(hook.owner);
      const patch = (dedupe: unknown) => call(hook.owner, "PATCH", `/${hook.workbookId}/webhook`, { dedupe });
      for (const dedupe of [
        { key: "email" },
        { key: "email", columnId: MISSING },
        { key: "email", columnId: other.col.Email },
        { key: "email", columnId: hook.col.Found },
        { key: "email", columnId: hook.col.Employees },
        { key: "none", columnId: hook.col.Email },
      ]) {
        const res = await patch(dedupe);
        expect(res.statusCode, JSON.stringify(dedupe)).toBe(422);
        expect(res.json().code).toBe("DEDUPE_COLUMN_INVALID");
      }
      expect((await patch({ key: "email", columnId: hook.col.Email })).json().data.dedupe).toEqual({ key: "email", columnId: hook.col.Email });
      expect((await patch({ key: "none" })).json().data.dedupe).toEqual({ key: "none" });
    });

    it("audits each change once, naming who did it and never the token", async () => {
      const hook = await webhook();
      const patch = (body: unknown) => call(hook.owner, "PATCH", `/${hook.workbookId}/webhook`, body);
      await patch({ enabled: true });
      await patch({ dedupe: { key: "none" } });
      await patch({ enabled: false });
      await patch({ enabled: false });
      await patch({ enabled: true });
      await patch({ dedupe: { key: "email", columnId: hook.col.Email } });
      await patch({ dedupe: { key: "email", columnId: hook.col.Email } });
      const { token } = (await call(hook.owner, "POST", `/${hook.workbookId}/webhook/regenerate`)).json().data;

      const found = await webhookAudits(hook.workbookId);
      expect(await actions(hook.workbookId)).toEqual(["created", "disabled", "enabled", "settings_changed", "token_regenerated"]);
      for (const entry of found) expect(entry).toMatchObject({ workspaceId: hook.owner.workspaceId, actorId: hook.owner.userId });
      const everything = JSON.stringify(await audits(hook.workbookId));
      for (const secret of [hook.token, token, createHash("sha256").update(token).digest("hex")]) expect(everything).not.toContain(secret.slice(5));
    });

    it("lets viewers see the status and only editors change it", async () => {
      const hook = await webhook();
      const viewer = await colleague(hook.owner, ["enrichment:read"]);
      const editor = await colleague(hook.owner, ["enrichment:read", "enrichment:capture"]);
      const outsider = await colleague(hook.owner, []);
      const path = `/${hook.workbookId}/webhook`;

      const seen = await call(viewer, "GET", path);
      expect(seen.statusCode).toBe(200);
      expect(seen.body).not.toContain(hook.token.slice(5));
      for (const res of [await call(viewer, "POST", path), await call(viewer, "POST", `${path}/regenerate`), await call(viewer, "PATCH", path, { enabled: false })]) expect(res.statusCode).toBe(403);
      expect((await call(outsider, "GET", path)).statusCode).toBe(403);
      expect(await record(hook)).toMatchObject({ enabled: true });

      expect((await call(editor, "PATCH", path, { enabled: false })).statusCode).toBe(200);
      expect((await call(editor, "POST", `${path}/regenerate`)).statusCode).toBe(200);
    });

    it("hides a webhook from every other workspace", async () => {
      const hook = await webhook();
      const stranger = await person();
      const path = `/${hook.workbookId}/webhook`;
      const before = await record(hook);
      for (const res of [await call(stranger, "GET", path), await call(stranger, "POST", path), await call(stranger, "POST", `${path}/regenerate`), await call(stranger, "PATCH", path, { enabled: false })]) {
        expect(res.statusCode, res.body).toBe(404);
      }
      expect(await record(hook)).toEqual(before);
    });

    it("is behind the Workbooks V2 switch, for managing and for receiving", async () => {
      const hook = await webhook();
      await setEntitlement(hook.owner.workspaceId, "feature.workbooks_v2", false);
      expect((await call(hook.owner, "GET", `/${hook.workbookId}/webhook`)).statusCode).toBe(403);
      const res = await post(hook);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("feature_disabled");
      await db.update(schema.workspaces).set({ accessStatus: "pending" }).where(eq(schema.workspaces.id, hook.owner.workspaceId));
      await setEntitlement(hook.owner.workspaceId, "feature.workbooks_v2", true);
      expect((await post(hook)).statusCode).toBe(403);
      expect(await rowTotal(hook.workbookId)).toBe(0);
    });
  });

  // ── Who may send ───────────────────────────────────────────────────────────

  describe("the token", () => {
    it("answers every kind of wrong credential the same way, and adds nothing", async () => {
      const hook = await webhook();
      const other = await webhook(hook.owner);
      const tries: Array<[string, Sending]> = [
        ["no header", { token: null }],
        ["wrong token", { token: `skwh_${"a".repeat(43)}` }],
        ["another webhook's token", { token: other.token }],
        ["part of the token", { token: hook.token.slice(0, -1) }],
        ["the stored hash", { token: (await record(hook)).tokenHash }],
        ["not a bearer token", { token: null, headers: { authorization: hook.token } }],
        ["basic auth", { token: null, headers: { authorization: `Basic ${hook.token}` } }],
        ["another header", { token: null, headers: { "x-webhook-token": hook.token } }],
        ["unknown webhook", { id: MISSING }],
        ["not an id", { id: "not-a-webhook" }],
        ["the workbook's id", { id: hook.workbookId }],
      ];
      const bodies = new Set<string>();
      for (const [what, sending] of tries) {
        const res = await post(hook, undefined, sending);
        expect(res.statusCode, what).toBe(401);
        const { code, message } = res.json();
        bodies.add(`${code} ${message}`);
        expect(res.body).not.toContain(hook.token.slice(5));
      }
      expect([...bodies]).toEqual(["INVALID_WEBHOOK_TOKEN Missing or invalid webhook token"]);
      expect(await rowTotal(hook.workbookId)).toBe(0);
      expect(await rowTotal(other.workbookId)).toBe(0);
      // Refused credentials don't count against the webhook, so a stranger can't use up its limit or mark it used.
      expect(await record(hook)).toMatchObject({ recentRequests: [], lastUsedAt: null });
      expect(await actions(hook.workbookId)).toEqual(["created"]);
    });

    it("is not taken from the address or the body", async () => {
      const hook = await webhook();
      const inQuery = await app.inject({ method: "POST", url: `/api/v1/webhooks/workbooks/${hook.id}?token=${hook.token}`, remoteAddress: hook.ip, headers: { "content-type": "application/json" }, payload: "[{}]" });
      expect(inQuery.statusCode).toBe(401);
      expect((await post(hook, [{ Name: "Ada", token: hook.token }], { token: null })).statusCode).toBe(401);
    });

    it("is checked before the body is read", async () => {
      const hook = await webhook();
      expect((await post(hook, undefined, { token: null, raw: "{not json" })).statusCode).toBe(401);
      expect((await post(hook, undefined, { token: null, raw: "x".repeat(6 * 1024 * 1024) })).statusCode).toBe(401);
      expect((await post(hook, undefined, { token: null, headers: { "content-type": "text/plain" } })).statusCode).toBe(401);
    });

    it("needs no Skout sign-in, and a signed-in person gains nothing without it", async () => {
      const hook = await webhook();
      const res = await app.inject({ method: "POST", url: `/api/v1/webhooks/workbooks/${hook.id}`, remoteAddress: hook.ip, headers: { ...hook.owner.headers, "content-type": "application/json" }, payload: "[{}]" });
      expect(res.statusCode).toBe(401);
    });

    it("stops working while its workbook is deleted", async () => {
      const hook = await webhook();
      expect((await call(hook.owner, "DELETE", `/${hook.workbookId}`)).statusCode).toBeLessThan(300);
      expect((await post(hook)).statusCode).toBe(401);
      expect((await post(hook, undefined, { raw: "{" })).statusCode).toBe(401);
      expect(await record(hook)).toMatchObject({ recentRequests: [], lastUsedAt: null, lastResult: null });
      expect((await call(hook.owner, "GET", `/${hook.workbookId}/webhook`)).statusCode).toBe(404);
      expect((await call(hook.owner, "POST", `/${hook.workbookId}/restore`)).statusCode).toBe(200);
      await accepted(hook, [{ Name: "Back" }]);
    });

    it("adds nothing if it is replaced, turned off or its workbook deleted while a request is on its way", async () => {
      for (const change of ["token", "enabled", "deleted"] as const) {
        const hook = await webhook();
        let pending: ReturnType<typeof post> | undefined;
        await sql.begin(async (tx) => {
          await tx`select 1 from workbooks where id = ${hook.workbookId} for no key update`;
          pending = Promise.resolve(post(hook)) as ReturnType<typeof post>;
          // The request is let in, then waits for the workbook.
          for (let i = 0; i < 200 && !(await record(hook)).lastUsedAt; i++) await new Promise((r) => setTimeout(r, 10));
          await new Promise((r) => setTimeout(r, 150));
          if (change === "token") await tx`update workbook_webhooks set token_hash = ${randomUUID()} where id = ${hook.id}`;
          else if (change === "enabled") await tx`update workbook_webhooks set enabled = false where id = ${hook.id}`;
          else await tx`update workbooks set deleted_at = now() where id = ${hook.workbookId}`;
        });
        const res = await pending!;
        expect(res.statusCode, change).toBe(401);
        expect(await rowTotal(hook.workbookId), change).toBe(0);
      }
    });
  });

  // ── Receiving rows ─────────────────────────────────────────────────────────

  describe("receiving rows", () => {
    it("adds rows to its workbook, with values in the columns' form and where they came from", async () => {
      const hook = await webhook(undefined, [...CONTACT, { name: "Joined", dataType: "date" }, { name: "Active", dataType: "checkbox" }]);
      const started = Date.now();
      const result = await accepted(hook, [
        { name: " Ada ", EMAIL: "ADA@Example.com", employees: "1200", joined: "2026-03-01", active: "yes" },
        { Name: "Grace" },
      ]);
      expect(result).toEqual({ received: 2, inserted: 2, duplicates: 0, skipped: 0, rejected: 0, rowCount: 2, ignoredFields: [], errors: [] });
      const [first, second_] = await table(hook);
      expect(first).toMatchObject({ Name: " Ada ", Employees: 1200, Joined: "2026-03-01", Active: true });
      expect(String(first!.Email).toLowerCase()).toBe("ada@example.com");
      expect(second_).toEqual({ Name: "Grace" });

      const rows = await rowsOf(hook.workbookId);
      for (const row of rows) {
        expect(row.source).toEqual({ type: "webhook", webhookId: hook.id, receivedAt: expect.any(String) });
        expect(Date.parse((row.source as { receivedAt: string }).receivedAt)).toBeGreaterThanOrEqual(started - 1000);
        expect(row.prospectId).toBeNull();
      }
      const [wb] = await db.select().from(workbooks).where(eq(workbooks.id, hook.workbookId));
      expect(wb!.rowCount).toBe(2);
      const after = await record(hook);
      expect(after.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(started - 5000);
      expect(after.lastResult).toMatchObject({ received: 2, inserted: 2, rejected: 0 });
      expect((await call(hook.owner, "GET", `/${hook.workbookId}/webhook`)).json().data).toMatchObject({ lastUsedAt: expect.any(String), lastResult: { inserted: 2 } });
    });

    it("adds after the rows already there, in the order sent", async () => {
      const hook = await webhook();
      await accepted(hook, people(2));
      expect((await accepted(hook, people(2, 2))).rowCount).toBe(4);
      expect((await table(hook)).map((r) => r.Name)).toEqual(["Person 0", "Person 1", "Person 2", "Person 3"]);
    });

    it("leaves out fields that name no input column, and says so, without making columns", async () => {
      const hook = await webhook(undefined, [...CONTACT, { name: "Found", type: "enrichment" }]);
      const result = await accepted(hook, [{ Name: "Ada", Found: "x@y.com", Nickname: "A", ["n".repeat(300)]: 1 }]);
      expect(result.inserted).toBe(1);
      expect(result.ignoredFields).toEqual(["Found", "Nickname", `${"n".repeat(100)}…`]);
      expect(await table(hook)).toEqual([{ Name: "Ada" }]);
      expect(await db.select().from(workbookColumns).where(eq(workbookColumns.workbookId, hook.workbookId))).toHaveLength(4);
    });

    it("rejects a row whose fields match no input column, rather than calling it empty", async () => {
      const hook = await webhook();
      const res = await post(hook, [{ Nme: "typo", "E-mail": "a@x.com" }]);
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: "NO_ROWS_ACCEPTED", details: { inserted: 0, skipped: 0, rejected: 1, ignoredFields: ["Nme", "E-mail"], errors: [{ row: 1, code: "NO_MATCHING_FIELDS" }] } });
      const bare = await webhook(undefined, []);
      expect((await post(bare, [{ Name: "Ada" }])).statusCode).toBe(422);
      expect(await accepted(bare, [{}])).toMatchObject({ inserted: 0, skipped: 1 });
    });

    it("lists at most fifty unknown names", async () => {
      const hook = await webhook();
      const row = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`extra${i}`, i]));
      expect((await accepted(hook, [{ Name: "Ada", ...row }])).ignoredFields).toHaveLength(50);
    });

    it("cannot be pointed at another workbook or workspace by anything sent", async () => {
      const hook = await webhook();
      const target = await webhook();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/webhooks/workbooks/${hook.id}?workbookId=${target.workbookId}&workspaceId=${target.owner.workspaceId}`,
        remoteAddress: hook.ip,
        headers: { authorization: `Bearer ${hook.token}`, "content-type": "application/json", "x-workspace-id": target.owner.workspaceId, "x-workbook-id": target.workbookId },
        payload: JSON.stringify([{ Name: "Ada", workbookId: target.workbookId, workspaceId: target.owner.workspaceId, source: { type: "manual" }, prospectId: MISSING, id: 1, position: 99, cells: { [target.col.Name!]: "x" }, [target.col.Name!]: "by id" }]),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(await rowTotal(target.workbookId)).toBe(0);
      const [row] = await rowsOf(hook.workbookId);
      expect(row).toMatchObject({ position: 0, prospectId: null, crmRef: null, source: { type: "webhook", webhookId: hook.id } });
      expect(await table(hook)).toEqual([{ Name: "Ada" }]);
    });

    it("adds the rows that are right and reports the rest by their place and field, not their values", async () => {
      const hook = await webhook(undefined, [...CONTACT, { name: "Joined", dataType: "date" }, { name: "Active", dataType: "checkbox" }]);
      const res = await post(hook, [
        { Name: "Good" },
        { Name: "Bad mail", Email: "secret-not-an-email" },
        { Name: "Bad number", Employees: "secret-many", Joined: "secret-date" },
        { Active: "secret-maybe" },
        "secret-string",
        null,
        ["secret-array"],
        { Name: { secret: 1 } },
        {},
        { Name: "   ", Unknown: "x" },
        { Name: null },
        { Name: "Also good", Email: null, Employees: "" },
      ]);
      expect(res.statusCode, res.body).toBe(200);
      const result: Result = res.json().data;
      expect(result).toMatchObject({ received: 12, inserted: 2, duplicates: 0, skipped: 3, rejected: 7, rowCount: 2 });
      expect(result.errors.map((e) => [e.row, e.code])).toEqual([
        [2, "INVALID_VALUE"], [3, "INVALID_VALUE"], [4, "INVALID_VALUE"], [5, "NOT_AN_OBJECT"], [6, "NOT_AN_OBJECT"], [7, "NOT_AN_OBJECT"], [8, "INVALID_VALUE"], [9, "EMPTY_ROW"], [10, "EMPTY_ROW"], [11, "EMPTY_ROW"],
      ]);
      expect(result.errors[1]!.message).toContain("Employees");
      expect(result.errors[1]!.message).toContain("Joined");
      expect(res.body).not.toContain("secret-");
      expect((await table(hook)).map((r) => r.Name)).toEqual(["Good", "Also good"]);
    });

    it("rejects a row that names a column twice, an ambiguous column or too many fields", async () => {
      const hook = await webhook(undefined, [{ name: "Name" }, { name: "Note" }, { name: "note" }]);
      const wide = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`f${i}`, 1]));
      const result = await accepted(hook, [{ Name: "a" }, { Name: "b", name: "c" }, { Name: "d", NOTE: "e" }, { Name: "f", ...wide }]);
      expect(result).toMatchObject({ inserted: 1, rejected: 3 });
      expect(result.errors.map((e) => e.code)).toEqual(["REPEATED_FIELD", "AMBIGUOUS_FIELD", "TOO_MANY_FIELDS"]);
    });

    it("answers 422 when nothing could be added", async () => {
      const hook = await webhook();
      const res = await post(hook, [{ Email: "nope" }, 5]);
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: "NO_ROWS_ACCEPTED", details: { received: 2, inserted: 0, rejected: 2 } });
      expect(res.json().details.errors).toHaveLength(2);
      expect(await rowTotal(hook.workbookId)).toBe(0);
      expect((await record(hook)).lastResult).toMatchObject({ inserted: 0, rejected: 2 });
    });

    it("answers 200 when there was only nothing to add", async () => {
      const hook = await webhook();
      expect(await accepted(hook, [{}, { Name: "" }])).toMatchObject({ inserted: 0, skipped: 2, rejected: 0 });
    });

    it("reports the first hundred problems and counts them all", async () => {
      const hook = await webhook();
      const result = await accepted(hook, [{ Name: "ok" }, ...Array.from({ length: 150 }, () => 1)]);
      expect(result.rejected).toBe(150);
      expect(result.errors).toHaveLength(100);
    });

    it("takes 1,000 rows, and refuses 1,001 with nothing added", async () => {
      const hook = await webhook();
      const over = await post(hook, people(1_001));
      expect(over.statusCode).toBe(413);
      expect(over.json()).toMatchObject({ code: "TOO_MANY_ROWS", details: { limit: 1000, rows: 1001 } });
      expect(await rowTotal(hook.workbookId)).toBe(0);
      expect(await accepted(hook, people(1_000))).toMatchObject({ inserted: 1000, rowCount: 1000 });
    });

    it("refuses a body over 5 MB", async () => {
      const hook = await webhook();
      const res = await post(hook, [{ Name: "x".repeat(5 * 1024 * 1024) }]);
      expect(res.statusCode).toBe(413);
      expect(res.json().code).toBe("PAYLOAD_TOO_LARGE");
      expect(res.body.length).toBeLessThan(1000);
      expect(await rowTotal(hook.workbookId)).toBe(0);
      expect((await webhookAudits(hook.workbookId)).at(-1)).toMatchObject({ action: "workbook.webhook.request_rejected", afterState: { code: "PAYLOAD_TOO_LARGE" } });
    });

    it("takes a body larger than the API's usual limit, up to its own", async () => {
      const hook = await webhook();
      const result = await accepted(hook, people(900).map((p) => ({ ...p, Name: "x".repeat(4_000) })));
      expect(result.inserted).toBe(900);
    });

    it("refuses anything but JSON", async () => {
      const hook = await webhook();
      for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp", ""]) {
        const res = await post(hook, undefined, { headers: { "content-type": type } });
        expect(res.statusCode, type).toBe(415);
        expect(res.json().code).toBe("UNSUPPORTED_MEDIA_TYPE");
      }
      for (const type of ["application/json; charset=utf-8", "Application/JSON", "application/vnd.example+json"]) {
        expect((await post(hook, undefined, { headers: { "content-type": type } })).statusCode, type).toBe(200);
      }
    });

    it("explains a body that isn't a JSON array of rows, without quoting it", async () => {
      const hook = await webhook();
      const tries: Array<[string, number, string]> = [
        ['[{"Name": "secret-broken"', 400, "INVALID_JSON"],
        ["secret-words", 400, "INVALID_JSON"],
        ["", 400, "INVALID_JSON"],
        ["   ", 400, "INVALID_JSON"],
        ['{"Name": "secret-object"}', 422, "INVALID_PAYLOAD"],
        ['{"rows": [{"Name": "secret-wrapped"}]}', 422, "INVALID_PAYLOAD"],
        ['"secret-string"', 422, "INVALID_PAYLOAD"],
        ["null", 422, "INVALID_PAYLOAD"],
        ["[]", 422, "INVALID_PAYLOAD"],
      ];
      for (const [raw, status, code] of tries) {
        const res = await post(hook, undefined, { raw });
        expect(res.statusCode, raw).toBe(status);
        expect(res.json().code, raw).toBe(code);
        expect(res.body, raw).not.toContain("secret-");
      }
      expect(await rowTotal(hook.workbookId)).toBe(0);
      expect((await actions(hook.workbookId)).filter((a) => a === "request_rejected")).toHaveLength(tries.length);
    });

    it("reads a body that starts with a byte order mark", async () => {
      const hook = await webhook();
      expect((await post(hook, undefined, { raw: '\uFEFF[{"Name":"Ada"}]' })).statusCode).toBe(200);
    });

    it("fills the workbook to its row limit and no further", async () => {
      const hook = await webhook();
      await setEntitlement(hook.owner.workspaceId, "workbooks.row_limit", 3);
      await accepted(hook, people(2));
      const result = await accepted(hook, people(3, 2));
      expect(result).toMatchObject({ inserted: 1, rejected: 2, rowCount: 3 });
      expect(result.errors.map((e) => [e.row, e.code])).toEqual([[2, "ROW_LIMIT_EXCEEDED"], [3, "ROW_LIMIT_EXCEEDED"]]);
      const full = await post(hook, people(1, 9));
      expect(full.statusCode).toBe(422);
      expect(full.json()).toMatchObject({ code: "ROW_LIMIT_EXCEEDED", details: { inserted: 0, rejected: 1, rowCount: 3 } });
      expect(await rowTotal(hook.workbookId)).toBe(3);
    });

    it("holds the row limit when requests arrive together", async () => {
      const hook = await webhook();
      await setEntitlement(hook.owner.workspaceId, "workbooks.row_limit", 25);
      const all = await Promise.all(Array.from({ length: 6 }, (_, i) => post(hook, people(10, i * 10), { on: i % 2 ? second : app })));
      const inserted = all.reduce((sum, r) => sum + (r.json().data?.inserted ?? r.json().details.inserted), 0);
      expect(inserted).toBe(25);
      const rows = await rowsOf(hook.workbookId);
      expect(rows).toHaveLength(25);
      expect(new Set(rows.map((r) => r.position)).size).toBe(25);
    });

    it("saves nothing of a request that fails part way, and takes it when sent again", async () => {
      const hook = await webhook();
      const body = [{ Name: "fine" }, { Name: `boom-${suffix}` }];
      const res = await withFailingCellInserts(sql, `wb2_webhook_${suffix}`, `new.value::text like '%boom-${suffix}%'`, async () => post(hook, body));
      expect(res.statusCode).toBe(500);
      expect(res.json().code).toBe("INTERNAL_ERROR");
      expect(res.body).not.toContain("boom");
      expect(await rowTotal(hook.workbookId)).toBe(0);
      expect((await record(hook)).lastResult).toBeNull();
      expect(await actions(hook.workbookId)).toEqual(["created"]);
      expect((await accepted(hook, body)).inserted).toBe(2);
    });
  });

  // ── Duplicates ─────────────────────────────────────────────────────────────

  describe("duplicate check", () => {
    const COLUMNS: ColumnSpec[] = [{ name: "Name" }, { name: "Email", dataType: "email" }, { name: "LinkedIn", dataType: "linkedin_url" }, { name: "Domain", dataType: "domain" }];

    it("adds duplicates when no check is set", async () => {
      const hook = await webhook();
      await accepted(hook, [{ Email: "a@x.com" }]);
      expect(await accepted(hook, [{ Email: "a@x.com" }, { Email: "a@x.com" }])).toMatchObject({ inserted: 2, duplicates: 0 });
    });

    it.each([
      ["email", "Email", "a@x.com", " A@X.COM ", "b@x.com"],
      ["linkedin_url", "LinkedIn", "https://www.linkedin.com/in/ada", "linkedin.com/in/Ada/", "linkedin.com/in/grace"],
      ["domain", "Domain", "example.com", "WWW.Example.com", "other.com"],
    ])("leaves out rows whose %s the workbook already has, or an earlier row of the request has", async (key, column, first, again, fresh) => {
      const hook = await webhook(undefined, COLUMNS);
      await call(hook.owner, "PATCH", `/${hook.workbookId}/webhook`, { dedupe: { key, columnId: hook.col[column] } });
      expect(await accepted(hook, [{ [column]: first }])).toMatchObject({ inserted: 1 });
      const result = await accepted(hook, [{ [column]: again }, { [column]: fresh }, { [column]: fresh }]);
      expect(result).toMatchObject({ inserted: 1, duplicates: 2, rejected: 0, rowCount: 2 });
      expect(result.errors.map((e) => [e.row, e.code])).toEqual([[1, "DUPLICATE"], [3, "DUPLICATE"]]);
      // Sending only what is there already is a success that adds nothing.
      expect(await accepted(hook, [{ [column]: first }])).toMatchObject({ inserted: 0, duplicates: 1 });
    });

    it("adds rows that have no value for the key", async () => {
      const hook = await webhook(undefined, COLUMNS);
      await call(hook.owner, "PATCH", `/${hook.workbookId}/webhook`, { dedupe: { key: "email", columnId: hook.col.Email } });
      expect(await accepted(hook, [{ Name: "a" }, { Name: "a", Email: "" }])).toMatchObject({ inserted: 2, duplicates: 0 });
    });

    it("does not let a rejected row make a later one a duplicate", async () => {
      const hook = await webhook(undefined, [...COLUMNS, { name: "Age", dataType: "number" }]);
      await call(hook.owner, "PATCH", `/${hook.workbookId}/webhook`, { dedupe: { key: "email", columnId: hook.col.Email } });
      expect(await accepted(hook, [{ Email: "a@x.com", Age: "old" }, { Email: "a@x.com", Age: 3 }])).toMatchObject({ inserted: 1, rejected: 1, duplicates: 0 });
    });

    it("calls rows over the limit rejected, not duplicates of each other", async () => {
      const hook = await webhook(undefined, COLUMNS);
      await call(hook.owner, "PATCH", `/${hook.workbookId}/webhook`, { dedupe: { key: "email", columnId: hook.col.Email } });
      await setEntitlement(hook.owner.workspaceId, "workbooks.row_limit", 1);
      const result = await accepted(hook, [{ Email: "a@x.com" }, { Email: "b@x.com" }, { Email: "b@x.com" }, { Email: "a@x.com" }]);
      expect(result).toMatchObject({ inserted: 1, rejected: 2, duplicates: 1 });
      expect(result.errors.map((e) => [e.row, e.code])).toEqual([[2, "ROW_LIMIT_EXCEEDED"], [3, "ROW_LIMIT_EXCEEDED"], [4, "DUPLICATE"]]);
    });

    it("counts rows added by hand", async () => {
      const hook = await webhook(undefined, COLUMNS);
      await call(hook.owner, "PATCH", `/${hook.workbookId}/webhook`, { dedupe: { key: "email", columnId: hook.col.Email } });
      expect((await call(hook.owner, "POST", `/${hook.workbookId}/rows`, { cells: { [hook.col.Email!]: "hand@x.com" } })).statusCode).toBe(201);
      expect(await accepted(hook, [{ Email: "HAND@x.com" }])).toMatchObject({ inserted: 0, duplicates: 1 });
    });

    it("adds nothing once the column it checks is gone, and says what to do", async () => {
      const hook = await webhook(undefined, COLUMNS);
      await call(hook.owner, "PATCH", `/${hook.workbookId}/webhook`, { dedupe: { key: "email", columnId: hook.col.Email } });
      await db.delete(workbookColumns).where(eq(workbookColumns.id, hook.col.Email!));
      const res = await post(hook, [{ Name: "Ada" }]);
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe("DEDUPE_COLUMN_INVALID");
      expect(await rowTotal(hook.workbookId)).toBe(0);
      await call(hook.owner, "PATCH", `/${hook.workbookId}/webhook`, { dedupe: { key: "none" } });
      await accepted(hook, [{ Name: "Ada" }]);
    });

    it("adds one row when the same key arrives in requests at once", async () => {
      const hook = await webhook(undefined, COLUMNS);
      await call(hook.owner, "PATCH", `/${hook.workbookId}/webhook`, { dedupe: { key: "email", columnId: hook.col.Email } });
      await Promise.all(Array.from({ length: 8 }, (_, i) => post(hook, [{ Email: "once@x.com" }], { on: i % 2 ? second : app })));
      expect(await rowTotal(hook.workbookId)).toBe(1);
    });
  });

  // ── Sending again ──────────────────────────────────────────────────────────

  describe("Idempotency-Key", () => {
    const keyed = (key: string, more: Sending = {}) => ({ ...more, headers: { "idempotency-key": key, ...more.headers } });
    const newKey = () => `delivery-${suffix}-${++n}`;

    it("answers a repeat as the first was and adds the rows once, on either server", async () => {
      const hook = await webhook();
      const key = newKey();
      const first = await post(hook, people(2), keyed(key));
      const again = await post(hook, people(2), keyed(key, { on: second }));
      expect([first.statusCode, again.statusCode]).toEqual([200, 200]);
      expect(again.json()).toEqual(first.json());
      expect(again.headers["idempotency-replayed"]).toBe("true");
      expect(first.headers["idempotency-replayed"]).toBeUndefined();
      expect(await rowTotal(hook.workbookId)).toBe(2);
    });

    it("adds the rows once when repeats arrive together", async () => {
      const hook = await webhook();
      const key = newKey();
      const all = await Promise.all(Array.from({ length: 8 }, (_, i) => post(hook, people(3), keyed(key, { on: i % 2 ? second : app }))));
      for (const res of all) expect([200, 409]).toContain(res.statusCode);
      expect(all.some((r) => r.statusCode === 200)).toBe(true);
      expect(await rowTotal(hook.workbookId)).toBe(3);
    });

    it("refuses the same key with other rows", async () => {
      const hook = await webhook();
      const key = newKey();
      await post(hook, people(1), keyed(key));
      const res = await post(hook, people(1, 5), keyed(key));
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(await rowTotal(hook.workbookId)).toBe(1);
    });

    it("keeps each webhook's keys apart", async () => {
      const a = await webhook();
      const b = await webhook(a.owner);
      const key = newKey();
      await post(a, people(1), keyed(key));
      expect((await post(b, people(1), keyed(key))).statusCode).toBe(200);
      expect(await rowTotal(b.workbookId)).toBe(1);
    });

    it("needs the token for a repeat", async () => {
      const hook = await webhook();
      const key = newKey();
      await post(hook, people(1), keyed(key));
      expect((await post(hook, people(1), keyed(key, { token: null }))).statusCode).toBe(401);
    });

    it("refuses a key of the wrong length", async () => {
      const hook = await webhook();
      for (const key of ["short", "k".repeat(129), ""]) {
        const res = await post(hook, people(1), keyed(key));
        expect(res.statusCode, key).toBe(422);
      }
      expect(await rowTotal(hook.workbookId)).toBe(0);
    });

    it("does not remember a refusal, so the same request can succeed later", async () => {
      const hook = await webhook();
      const key = newKey();
      await setEntitlement(hook.owner.workspaceId, "workbooks.row_limit", 0);
      expect((await post(hook, people(1), keyed(key))).statusCode).toBe(422);
      await setEntitlement(hook.owner.workspaceId, "workbooks.row_limit", 10);
      expect((await post(hook, people(1), keyed(key))).statusCode).toBe(200);
      expect(await rowTotal(hook.workbookId)).toBe(1);

      const other = newKey();
      expect((await post(hook, undefined, keyed(other, { raw: "{" }))).statusCode).toBe(400);
      expect((await post(hook, undefined, keyed(other, { raw: "{" }))).statusCode).toBe(400);
    });

    it("saves the rows and the answer together, or neither", async () => {
      const hook = await webhook();
      const key = newKey();
      const name = `wb2_webhook_idem_${suffix}`;
      await sql.unsafe(`create function ${name}() returns trigger language plpgsql as $$ begin if new.key like '%${key}' and new.state = 'complete' then raise exception 'boom'; end if; return new; end $$`);
      await sql.unsafe(`create trigger ${name} before update on cops_idempotency_keys for each row execute function ${name}()`);
      try {
        expect((await post(hook, people(2), keyed(key))).statusCode).toBe(500);
        expect(await rowTotal(hook.workbookId)).toBe(0);
      } finally {
        await sql.unsafe(`drop trigger ${name} on cops_idempotency_keys`);
        await sql.unsafe(`drop function ${name}()`);
      }
      // The key was released, so the retry is handled, not refused as still running.
      expect((await post(hook, people(2), keyed(key))).statusCode).toBe(200);
      expect(await rowTotal(hook.workbookId)).toBe(2);
    });
  });

  // ── Rate limit ─────────────────────────────────────────────────────────────

  describe("rate limit", () => {
    const burst = async (hook: Hook, count: number, s: (i: number) => Sending = () => ({})) => {
      const statuses: number[] = [];
      for (let i = 0; i < count; i++) statuses.push((await post(hook, [{}], s(i))).statusCode);
      return statuses;
    };

    it("takes 60 requests in a minute and answers 429 to the next, saying when to come back", async () => {
      const hook = await webhook();
      expect(new Set(await burst(hook, 60))).toEqual(new Set([200]));
      const res = await post(hook, people(1));
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ code: "RATE_LIMITED", retryable: true });
      const wait = Number(res.headers["retry-after"]);
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(60);
      expect(await rowTotal(hook.workbookId)).toBe(0);
    });

    it("counts one webhook's requests across servers", async () => {
      const hook = await webhook();
      expect(new Set(await burst(hook, 60, (i) => ({ on: i % 2 ? second : app })))).toEqual(new Set([200]));
      expect((await post(hook, [{}])).statusCode).toBe(429);
      expect((await post(hook, [{}], { on: second })).statusCode).toBe(429);
    });

    it("lets exactly 60 of many requests arriving together through, across servers", async () => {
      const hook = await webhook();
      const all = await Promise.all(Array.from({ length: 100 }, (_, i) => post(hook, [{}], { on: i % 2 ? second : app, ip: `23.0.0.${i}` })));
      const tally = all.map((r) => r.statusCode);
      expect(tally.filter((s) => s === 200)).toHaveLength(60);
      expect(tally.filter((s) => s === 429)).toHaveLength(40);
      expect((await record(hook)).recentRequests).toHaveLength(60);
      expect((await actions(hook.workbookId)).filter((a) => a === "rate_limited")).toHaveLength(1);
    });

    it("opens again as requests leave the last minute, without refused ones holding it shut", async () => {
      const hook = await webhook();
      await burst(hook, 60);
      await burst(hook, 5);
      await age(hook, 50_000);
      const early = await post(hook, [{}]);
      expect(early.statusCode).toBe(429);
      expect(Number(early.headers["retry-after"])).toBeLessThanOrEqual(10);
      await age(hook, 11_000);
      expect((await post(hook, [{}])).statusCode).toBe(200);
      expect((await record(hook)).recentRequests).toHaveLength(1);
    });

    it("counts requests refused for their content, and ones with any address", async () => {
      const hook = await webhook();
      await burst(hook, 30, () => ({ raw: "{" }));
      await burst(hook, 30, (i) => ({ headers: { "content-type": "text/plain" }, ip: `24.0.0.${i}` }));
      expect((await post(hook, [{}])).statusCode).toBe(429);
    });

    it("keeps each webhook's count apart, and a new token does not reset it", async () => {
      const a = await webhook();
      const b = await webhook(a.owner);
      await burst(a, 60);
      expect((await post(b, [{}], { ip: a.ip })).statusCode).toBe(200);
      const { token } = (await call(a.owner, "POST", `/${a.workbookId}/webhook/regenerate`)).json().data;
      expect((await post(a, [{}], { token })).statusCode).toBe(429);
    });

    it("audits being limited at most once a minute", async () => {
      const hook = await webhook();
      await burst(hook, 65);
      const noted = async () => (await actions(hook.workbookId)).filter((a) => a === "rate_limited").length;
      expect(await noted()).toBe(1);
      await sql`update workbook_webhooks set rate_limit_noted_at = now() - interval '61 seconds' where id = ${hook.id}`;
      await post(hook, [{}]);
      expect(await noted()).toBe(2);
    });

    it("limits an address that guesses, whatever tokens it sends", async () => {
      const hook = await webhook();
      const ip = "25.9.9.9";
      const statuses: number[] = [];
      for (let i = 0; i < 601; i++) statuses.push((await post(hook, [{}], { ip, id: "guess", token: `skwh_${String(i).padStart(43, "0")}` })).statusCode);
      expect(statuses.slice(0, 600).every((s) => s === 401)).toBe(true);
      expect(statuses[600]).toBe(429);
      expect((await post(hook, [{}], { ip: "25.9.9.10" })).statusCode).toBe(200);
    });
  });

  // ── Records, and what receiving does not do ────────────────────────────────

  describe("records", () => {
    it("shows added rows in the workbook's activity, with the source, time and counts", async () => {
      const hook = await webhook(undefined, [...CONTACT]);
      await call(hook.owner, "PATCH", `/${hook.workbookId}/webhook`, { dedupe: { key: "email", columnId: hook.col.Email } });
      await accepted(hook, [{ Email: "a@secret.com" }, { Email: "a@secret.com" }, {}, { Employees: "x" }]);
      const res = await call(hook.owner, "GET", `/${hook.workbookId}/activity`);
      const added = res.json().data.filter((e: { type: string }) => e.type === "rows.added");
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({ actor: null, details: { source: "webhook", rows: 1, rowCount: 1, duplicates: 1, skipped: 1, rejected: 1 }, occurredAt: expect.any(String) });
      expect(res.body).not.toContain("secret.com");
      expect(res.body).not.toContain(hook.token.slice(5));
    });

    it("audits accepted and refused requests without anything that was sent or the token", async () => {
      const hook = await webhook();
      await accepted(hook, [{ Name: "secret-name", Extra: "secret-extra", "secret-field": 1 }]);
      await post(hook, undefined, { raw: "secret-broken{" });
      await post(hook, people(1_001));
      const found = await webhookAudits(hook.workbookId);
      expect(found.map((a) => [a.action, (a.afterState as { code?: string }).code])).toEqual([
        ["workbook.webhook.created", undefined],
        ["workbook.webhook.request_accepted", undefined],
        ["workbook.webhook.request_rejected", "INVALID_JSON"],
        ["workbook.webhook.request_rejected", "TOO_MANY_ROWS"],
      ]);
      expect(found[1]).toMatchObject({ workspaceId: hook.owner.workspaceId, actorId: null, actorType: "integration", afterState: { webhookId: hook.id, received: 1, inserted: 1 } });
      const everything = JSON.stringify(await audits(hook.workbookId));
      expect(everything).not.toContain("secret-");
      expect(everything).not.toContain(hook.token.slice(5));
      expect(everything).not.toContain((await record(hook)).tokenHash);
    });

    it("only adds rows: no enrichment, formula, AI or action column runs, and nothing is charged", async () => {
      const hook = await webhook(undefined, [...CONTACT, { name: "Found", type: "enrichment" }, { name: "Sum", type: "formula" }, { name: "Written", type: "ai" }, { name: "Listed", type: "action" }]);
      const workspaceId = hook.owner.workspaceId;
      const spent = async () => ({
        runs: (await db.select().from(workbookRuns).where(eq(workbookRuns.workbookId, hook.workbookId))).length,
        jobs: (await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.workspaceId, workspaceId))).length,
        results: (await db.select().from(enrichmentResults).where(eq(enrichmentResults.workspaceId, workspaceId))).length,
        charges: (await db.select().from(creditTransactions).where(eq(creditTransactions.workspaceId, workspaceId))).length,
        queued: (await db.select().from(asyncJobs).where(eq(asyncJobs.workspaceId, workspaceId))).length,
      });
      const before = await spent();
      await accepted(hook, [{ Name: "Ada", Email: "ada@x.com", Found: "mine", Sum: 3, Written: "w", Listed: "l" }]);
      expect(await spent()).toEqual(before);
      const cells = await db.select().from(workbookCells).where(eq(workbookCells.workbookId, hook.workbookId));
      expect(cells.map((c) => c.columnId).sort()).toEqual([hook.col.Name, hook.col.Email].sort());
      const computed = ["Found", "Sum", "Written", "Listed"].map((name) => hook.col[name]!);
      expect(await db.select().from(workbookCells).where(and(eq(workbookCells.workbookId, hook.workbookId), inArray(workbookCells.columnId, computed)))).toEqual([]);
    });
  });
});
