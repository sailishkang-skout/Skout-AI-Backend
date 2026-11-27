import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { invalidateWorkspaceAccess } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { findOptedOut } from "../services/cops-can-contact.js";
import { identifiersIn, linkedinKey } from "../services/workbook-suppression.service.js";
import { rowsThatMayRun, runForRow } from "../services/workbook-v2-runs.service.js";
import { ACTION_OPERATIONS, ENRICHMENT_OPERATIONS } from "../services/workbook-v2-column-config.js";
import { withFailingCellInserts } from "../test/failing-cell-inserts.js";

/**
 * WB2-027: suppressed and opted-out people in Workbooks V2, through the real routes against a real database. Each
 * import source also has its own test beside the rest of that source's tests.
 */
vi.mock("../workers/workbook-import.queue.js", () => ({
  workbookImportQueue: () => ({ ready: async () => true, enqueue: async () => {} }),
  closeWorkbookImportQueue: async () => {},
}));

const base = loadEnv();
const hasDatabase = Boolean(base.DATABASE_URL);
const API = "/api/v1";
const {
  workbooks, workbookColumns, workbookRows, workbookCells, workbookRuns, workbookImports, workbookImportItems, entitlements, auditLogs, suppressions, consents,
  contacts, contactChannels, prospectActivations, enrichmentIdentities, dataSubjectRequests, creditBalances, creditTransactions, enrichmentJobs, asyncJobs,
} = schema;

describe.skipIf(!hasDatabase)("Workbooks V2 suppression", () => {
  const { db, sql } = createDb(base.DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  const config = { ...base, CLERK_SECRET_KEY: undefined, LOG_LEVEL: "fatal" as const, EARLY_ACCESS_GATE_ENABLED: "true" as never, RATE_LIMIT_MAX: 100_000, PLATFORM_ADMIN_EMAILS: [], EXPORTS_BUCKET: undefined };
  const previousDir = process.env.WORKBOOK_IMPORTS_LOCAL_DIR;
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let n = 0;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "wb2-suppression-test-"));
    process.env.WORKBOOK_IMPORTS_LOCAL_DIR = dir;
    app = await buildApp(config);
  });
  afterAll(async () => {
    await app.close();
    await sql.end();
    if (previousDir === undefined) delete process.env.WORKBOOK_IMPORTS_LOCAL_DIR;
    else process.env.WORKBOOK_IMPORTS_LOCAL_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
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
    const email = `wb2-supp-${suffix}-${n}@test.com`;
    const ip = `26.${Math.floor(n / 250)}.${n % 250}.7`;
    await app.inject({ method: "GET", url: `${API}/me`, headers: { "x-stub-user-email": email }, remoteAddress: ip });
    const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    const [m] = await db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, u!.id));
    await db.update(schema.workspaces).set({ accessStatus: "active" }).where(eq(schema.workspaces.id, m!.workspaceId));
    await db.insert(entitlements).values({ workspaceId: m!.workspaceId, key: "feature.workbooks_v2", value: true, source: "test" }).onConflictDoNothing();
    invalidateWorkspaceAccess(m!.workspaceId);
    return { userId: u!.id, workspaceId: m!.workspaceId, ip, headers: { "x-stub-user-email": email } };
  }

  type Method = "GET" | "POST" | "PATCH" | "DELETE";
  const send = (u: User, method: Method, url: string, body?: unknown) =>
    app.inject({
      method,
      url: `${API}${url}`,
      remoteAddress: u.ip,
      headers: { ...u.headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  const call = (u: User, method: Method, p: string, body?: unknown) => send(u, method, `/workbooks-v2${p}`, body);

  type Spec = { name: string; type?: "input" | "enrichment" | "formula" | "ai" | "action"; dataType?: string; operation?: string };
  const PEOPLE: Spec[] = [{ name: "Name" }, { name: "Email", dataType: "email" }, { name: "Phone", dataType: "phone" }, { name: "LinkedIn", dataType: "linkedin_url" }, { name: "Notes" }];

  interface Book {
    id: string;
    owner: User;
    col: Record<string, string>;
  }

  async function workbook(owner: User, specs: Spec[] = PEOPLE): Promise<Book> {
    const res = await call(owner, "POST", "", { name: "Suppression" });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().data.id as string;
    const made = specs.map((c, position) => ({
      id: randomUUID(),
      workbookId: id,
      name: c.name,
      type: c.type ?? ("input" as const),
      operation: c.operation ?? null,
      position,
      config: !c.type || c.type === "input" ? { dataType: c.dataType ?? "text" } : { inputs: {} },
    }));
    await db.insert(workbookColumns).values(made);
    return { id, owner, col: Object.fromEntries(made.map((c) => [c.name, c.id])) };
  }

  const cellsOf = (b: Book, values: Record<string, string>) => Object.fromEntries(Object.entries(values).map(([name, v]) => [b.col[name]!, v]));
  /** Adds rows through the API and returns their ids in order. */
  async function add(b: Book, rows: Array<Record<string, string>>): Promise<number[]> {
    const res = await call(b.owner, "POST", `/${b.id}/rows/bulk`, { rows: rows.map((r) => ({ cells: cellsOf(b, r) })) });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().data.rows.map((r: { id: number }) => r.id);
  }
  const rowsOf = (workbookId: string) => db.select().from(workbookRows).where(eq(workbookRows.workbookId, workbookId)).orderBy(asc(workbookRows.position));
  const marks = async (b: Book) => (await rowsOf(b.id)).map((r) => r.suppressed);
  const cell = async (b: Book, rowId: number, column: string) =>
    (await db.select().from(workbookCells).where(and(eq(workbookCells.workbookId, b.id), eq(workbookCells.rowId, rowId), eq(workbookCells.columnId, b.col[column]!))))[0];
  const names = async (b: Book) => {
    const cells = await db.select().from(workbookCells).where(and(eq(workbookCells.workbookId, b.id), eq(workbookCells.columnId, b.col.Name!)));
    const byRow = new Map(cells.map((c) => [c.rowId, c.value]));
    return (await rowsOf(b.id)).map((r) => byRow.get(r.id) ?? null);
  };

  const suppress = (u: User, ...emails: string[]) => db.insert(suppressions).values(emails.map((email) => ({ workspaceId: u.workspaceId, email })));
  async function contact(u: User, values: { email?: string; prospectId?: string; linkedinUrl?: string } = {}) {
    const [made] = await db.insert(contacts).values({ workspaceId: u.workspaceId, firstName: "Contact", email: values.email ?? null, sourceProspectId: values.prospectId ?? null, linkedinUrl: values.linkedinUrl ?? null }).returning();
    return made!.id;
  }
  const channel = (u: User, contactId: string, kind: "email" | "phone" | "linkedin", value: string, extra: { suppressed?: boolean; bounceStatus?: string } = {}) =>
    db.insert(contactChannels).values({ workspaceId: u.workspaceId, contactId, channel: kind, value, suppressed: extra.suppressed ?? false, bounceStatus: extra.bounceStatus ?? "none" });
  const consent = (u: User, subjectId: string, revoked: boolean, type = "email", subjectType = "prospect") =>
    db.insert(consents).values({ workspaceId: u.workspaceId, subjectType, subjectId, type, basis: "test", revokedAt: revoked ? new Date() : null });
  const prospect = async (u: User, snapshot: Record<string, unknown> = {}) => {
    const id = `supp-${suffix}-${++n}`;
    await db.insert(prospectActivations).values({ workspaceId: u.workspaceId, prospectId: id, companyId: id, snapshot });
    return id;
  };
  /** Links a row to a prospect, as adding from a list does, and reads its mark again. */
  async function linked(b: Book, prospectId: string, values: Record<string, string> = { Name: "Linked" }) {
    const [rowId] = await add(b, [values]);
    await db.update(workbookRows).set({ prospectId }).where(eq(workbookRows.id, rowId!));
    await rowsThatMayRun(db, b.owner.workspaceId, b.id, b.col.Notes!, [rowId!]);
    return (await rowsOf(b.id)).find((r) => r.id === rowId)!.suppressed;
  }

  // ── Who counts as opted out ────────────────────────────────────────────────

  describe("matching", () => {
    it("marks an address on the suppression list however it is typed, in an email column or any other", async () => {
      const u = await user();
      await suppress(u, "gone@example.com");
      const b = await workbook(u);
      await add(b, [{ Email: "gone@example.com" }, { Email: " GONE@Example.COM " }, { Notes: "Gone@example.com" }, { Email: "stays@example.com" }, { Notes: "ask gone@example.com about it" }, { Name: "gone" }]);
      expect(await marks(b)).toEqual([true, true, true, false, false, false]);
    });

    it("marks an email or phone marked do-not-contact, and everything else of that contact", async () => {
      const u = await user();
      const dnc = await contact(u, { email: "main@dnc.com" });
      await channel(u, dnc, "email", "Other@DNC.com", { suppressed: true });
      const caller = await contact(u, {});
      await channel(u, caller, "phone", "+44 (0)20 7946-0001", { suppressed: true });
      const b = await workbook(u);
      await add(b, [{ Email: "other@dnc.com" }, { Email: "main@dnc.com" }, { Phone: "+44 0 20 7946 0001" }, { Notes: "+44 0 20 7946 0001" }, { Phone: "+44 20 7946 0002" }]);
      // A number is only read from a phone column.
      expect(await marks(b)).toEqual([true, true, true, false, false]);
      // Another address held for someone who is on the list is theirs too.
      const listed = await contact(u, { email: "listed@dnc.com" });
      await channel(u, listed, "email", "Alias@DNC.com");
      await suppress(u, "listed@dnc.com");
      const other = await workbook(u);
      await add(other, [{ Email: "alias@dnc.com" }]);
      expect(await marks(other)).toEqual([true]);
    });

    it("marks revoked email consent unless another consent is active", async () => {
      const u = await user();
      const [revoked, renewed, sms, granted] = [await prospect(u), await prospect(u), await prospect(u), await prospect(u)];
      await consent(u, revoked, true);
      await consent(u, renewed, true);
      await consent(u, renewed, false);
      await consent(u, sms, true, "sms");
      await consent(u, granted, false);
      await consent(u, "revoked@example.com", true, "email", "email");
      const b = await workbook(u);
      expect([await linked(b, revoked), await linked(b, renewed), await linked(b, sms), await linked(b, granted)]).toEqual([true, false, false, false]);
      const other = await workbook(u);
      await add(other, [{ Email: "revoked@example.com" }]);
      expect(await marks(other)).toEqual([true]);
    });

    it("does not count a bounced address as an opt-out", async () => {
      const u = await user();
      const bounced = await contact(u, { email: "bounced@example.com" });
      await channel(u, bounced, "email", "bounced@example.com", { bounceStatus: "hard" });
      const b = await workbook(u);
      await add(b, [{ Email: "bounced@example.com" }]);
      expect(await marks(b)).toEqual([false]);
    });

    it("follows a linked prospect to its stored address and CRM contact", async () => {
      const u = await user();
      const bySnapshot = await prospect(u, { email: "Snap@Out.com" });
      await suppress(u, "snap@out.com");
      const byContactAddress = await prospect(u);
      await contact(u, { prospectId: byContactAddress, email: "crm@out.com" });
      await suppress(u, "crm@out.com");
      const byChannel = await prospect(u);
      const c = await contact(u, { prospectId: byChannel, email: "x@fine.com" });
      await channel(u, c, "phone", "+1 555 010 0100", { suppressed: true });
      const byContactConsent = await prospect(u);
      const d = await contact(u, { prospectId: byContactConsent });
      await consent(u, d, true, "email", "contact");
      const fine = await prospect(u, { email: "fine@fine.com" });
      const b = await workbook(u);
      for (const [id, want] of [[bySnapshot, true], [byContactAddress, true], [byChannel, true], [byContactConsent, true], [fine, false]] as const) expect(await linked(b, id), id).toBe(want);
    });

    it("follows a LinkedIn URL to the captured person, using the identity records", async () => {
      const u = await user();
      const c = await contact(u, { email: "profile@out.com" });
      await db.insert(enrichmentIdentities).values({ workspaceId: u.workspaceId, entityType: "person", canonicalKey: `in:ada-${suffix}`, entityId: c });
      await suppress(u, "profile@out.com");
      const b = await workbook(u);
      await add(b, [{ LinkedIn: `https://www.linkedin.com/in/Ada-${suffix}/` }, { LinkedIn: `linkedin.com/in/ada-${suffix}?trk=1` }, { LinkedIn: "https://www.linkedin.com/in/someone-else" }]);
      expect(await marks(b)).toEqual([true, true, false]);
    });

    it("guesses no person from a company, a name or a domain", async () => {
      const u = await user();
      await suppress(u, "ceo@acme.com");
      const c = await contact(u, { email: "ceo@acme.com", linkedinUrl: "https://www.linkedin.com/in/ceo-acme" });
      await channel(u, c, "phone", "+1 555 010 0200", { suppressed: true });
      const b = await workbook(u, [{ name: "Name" }, { name: "Domain", dataType: "domain" }, { name: "Company", dataType: "linkedin_url" }, { name: "Notes" }]);
      await add(b, [{ Name: "Acme", Domain: "acme.com", Company: "https://www.linkedin.com/company/acme", Notes: "+1 555 010 0200" }, { Name: "Contact" }, {}]);
      expect(await marks(b)).toEqual([false, false, false]);

      // A CRM company record's switchboard number doesn't make it the person who holds that number; a contact's does.
      const crm = await workbook(u, [{ name: "Name" }, { name: "Phone", dataType: "phone" }]);
      const ids = await add(crm, [{ Phone: "+1 555 010 0200" }, { Phone: "+1 555 010 0200" }]);
      for (const [i, object] of ["company", "contact"].entries()) await db.update(workbookRows).set({ crmRef: { provider: "hubspot", object, id: String(i) } }).where(eq(workbookRows.id, ids[i]!));
      expect((await rowsThatMayRun(db, u.workspaceId, crm.id, crm.col.Name!, ids)).suppressed).toEqual([ids[1]]);
    });

    it("keeps each workspace's records to itself", async () => {
      const [u, other] = [await user(), await user()];
      await suppress(other, "theirs@example.com");
      const c = await contact(other, { email: "theirs2@example.com" });
      await channel(other, c, "email", "theirs2@example.com", { suppressed: true });
      await consent(other, "theirs3@example.com", true, "email", "email");
      const b = await workbook(u);
      await add(b, [{ Email: "theirs@example.com" }, { Email: "theirs2@example.com" }, { Email: "theirs3@example.com" }]);
      expect(await marks(b)).toEqual([false, false, false]);
    });

    it("reads identifiers only from input and enrichment cells", async () => {
      const u = await user();
      await suppress(u, "out@example.com");
      const b = await workbook(u, [{ name: "Name" }, { name: "Found", type: "enrichment", operation: "find_email" }, { name: "Dial", type: "enrichment", operation: "find_phone" }, { name: "Draft", type: "ai" }, { name: "Notes" }]);
      const ids = await add(b, [{ Name: "a" }, { Name: "b" }]);
      await db.insert(workbookCells).values([
        { workbookId: b.id, rowId: ids[0]!, columnId: b.col.Found!, value: "out@example.com", state: "found" },
        { workbookId: b.id, rowId: ids[1]!, columnId: b.col.Draft!, value: "out@example.com", state: "found" },
      ]);
      expect((await rowsThatMayRun(db, u.workspaceId, b.id, b.col.Notes!, ids)).suppressed).toEqual([ids[0]]);
      const dnc = await contact(u);
      await channel(u, dnc, "phone", "5550100300", { suppressed: true });
      await db.insert(workbookCells).values({ workbookId: b.id, rowId: ids[1]!, columnId: b.col.Dial!, value: "(555) 010-0300", state: "found" });
      expect((await rowsThatMayRun(db, u.workspaceId, b.id, b.col.Notes!, ids)).suppressed).toEqual(ids);
    });

    it("reads each kind of identifier, and nothing from other values", async () => {
      expect(identifiersIn(1, " A@B.co ", false)).toEqual([{ ref: 1, kind: "email", value: "a@b.co" }]);
      expect(identifiersIn(1, { email: "a@b.co", other: 3 }, false)).toHaveLength(1);
      expect(identifiersIn(1, "+1 555 010 0100", true)).toEqual([{ ref: 1, kind: "phone", value: "15550100100" }]);
      expect(identifiersIn(1, "+1 555 010 0100", false)).toEqual([]);
      expect([identifiersIn(1, "12345", true), identifiersIn(1, 5550100100, true), identifiersIn(1, "Ada", true), identifiersIn(1, null, true)].flat()).toEqual([]);
      for (const url of ["https://www.linkedin.com/in/Ada", "http://linkedin.com/in/ada/", "uk.linkedin.com/in/ada", "www.linkedin.com/in/ada#x"]) expect(linkedinKey(url), url).toBe("in:ada");
      for (const url of ["https://www.linkedin.com/company/ada", "https://evil.com/linkedin.com/in/ada", "https://notlinkedin.com/in/ada", "linkedin.com/in/"]) expect(linkedinKey(url), url).toBeNull();
      expect(await findOptedOut(db, randomUUID(), [])).toEqual(new Set());
      // The gate compares addresses without regard to case, whoever calls it.
      const u = await user();
      await suppress(u, "gone@example.com");
      expect(await findOptedOut(db, u.workspaceId, [{ ref: 7, kind: "email", value: " GONE@Example.com " }, { ref: 8, kind: "email", value: "stays@example.com" }])).toEqual(new Set([7]));
    });
  });

  // ── Typing, pasting and webhooks ───────────────────────────────────────────

  describe("marking rows as they are written", () => {
    it("marks a single added row, and keeps the mark true to what the row says as it is edited", async () => {
      const u = await user();
      await suppress(u, "out@example.com");
      const b = await workbook(u);
      const made = await call(u, "POST", `/${b.id}/rows`, { cells: cellsOf(b, { Name: "Ada", Email: "out@example.com" }) });
      expect(made.statusCode, made.body).toBe(201);
      expect(made.json().data).toMatchObject({ suppressed: true, source: { type: "manual" } });
      expect(made.body).not.toMatch(/unsubscribed|reason/);
      const id = made.json().data.id as number;

      const edit = async (cells: Record<string, string | null>) => (await call(u, "PATCH", `/${b.id}/rows/${id}`, { cells: Object.fromEntries(Object.entries(cells).map(([k, v]) => [b.col[k]!, v])) })).json().data.suppressed;
      expect(await edit({ Email: "in@example.com" })).toBe(false);
      expect(await edit({ Notes: "out@example.com" })).toBe(true);
      expect(await edit({ Notes: null })).toBe(false);
      expect(await edit({ Email: "OUT@example.com" })).toBe(true);
    });

    it("marks rows pasted in, pasted over and emptied by a paste", async () => {
      const u = await user();
      await suppress(u, "out@example.com");
      const b = await workbook(u);
      const [first, second] = await add(b, [{ Email: "a@example.com" }, { Email: "out@example.com" }]);
      const res = await call(u, "POST", `/${b.id}/paste`, { columnIds: [b.col.Email], values: [["out@example.com"], [""], ["out@example.com"], ["z@example.com"]], start: { rowId: first, endRowId: second, rows: 2 } });
      expect(res.statusCode, res.body).toBe(200);
      expect(await marks(b)).toEqual([true, false, true, false]);
    });

    it("marks rows a webhook adds, without telling the sender", async () => {
      const u = await user();
      await suppress(u, "out@example.com");
      const b = await workbook(u);
      const made = (await call(u, "POST", `/${b.id}/webhook`)).json().data;
      const res = await app.inject({
        method: "POST",
        url: `${API}/webhooks/workbooks/${made.webhook.id}`,
        remoteAddress: "27.0.0.1",
        headers: { authorization: `Bearer ${made.token}`, "content-type": "application/json" },
        payload: JSON.stringify([{ Email: "out@example.com" }, { Email: "in@example.com" }]),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data.inserted).toBe(2);
      expect(res.body).not.toMatch(/suppress/i);
      const rows = await rowsOf(b.id);
      expect(rows.map((r) => r.suppressed)).toEqual([true, false]);
      expect(rows[0]!.source).toMatchObject({ type: "webhook", webhookId: made.webhook.id });
      const activity = await call(u, "GET", `/${b.id}/activity`);
      expect(activity.body).not.toMatch(/suppress|out@example/i);
    });

    it("marks every one of many rows for the same person, and a copy keeps the marks", async () => {
      const u = await user();
      await suppress(u, "out@example.com");
      const b = await workbook(u);
      await add(b, [{ Email: "out@example.com" }, { Email: "in@example.com" }]);
      await add(b, [{ Email: "out@example.com" }, { Email: "in@example.com" }]);
      expect(await marks(b)).toEqual([true, false, true, false]);
      const copy = await call(u, "POST", `/${b.id}/duplicate`, { includeRows: true });
      expect((await rowsOf(copy.json().data.id)).map((r) => r.suppressed)).toEqual([true, false, true, false]);
    });

    it("marks rows whose ids are past what a 32-bit number holds", async () => {
      const u = await user();
      await suppress(u, "out@example.com");
      const b = await workbook(u);
      const id = 3_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
      await sql`insert into workbook_rows (id, workbook_id, position) overriding system value values (${id}, ${b.id}, 0)`;
      const res = await call(u, "PATCH", `/${b.id}/rows/${id}`, { cells: { [b.col.Email!]: "out@example.com" } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().data).toMatchObject({ id, suppressed: true });
    });

    it("saves no row whose mark could not be set", async () => {
      const u = await user();
      const b = await workbook(u);
      const res = await withFailingCellInserts(sql, `wb2_supp_${suffix}`, `new.value::text like '%boom-${suffix}%'`, async () => call(u, "POST", `/${b.id}/rows`, { cells: cellsOf(b, { Name: `boom-${suffix}` }) }));
      expect(res.statusCode).toBe(500);
      expect(await rowsOf(b.id)).toEqual([]);
    });
  });

  // ── Running columns ────────────────────────────────────────────────────────

  describe("running columns", () => {
    const COLUMNS: Spec[] = [
      { name: "Name" },
      { name: "Email", dataType: "email" },
      ...ENRICHMENT_OPERATIONS.map((operation) => ({ name: operation, type: "enrichment" as const, operation })),
      { name: "ai", type: "ai" },
      ...ACTION_OPERATIONS.map((operation) => ({ name: operation, type: "action" as const, operation })),
    ];
    const RUNNABLE = [...ENRICHMENT_OPERATIONS, "ai", ...ACTION_OPERATIONS];

    /** A workbook with every kind of column that runs, one opted-out person and one other. */
    async function runnable() {
      const u = await user();
      await suppress(u, "out@example.com");
      const b = await workbook(u, COLUMNS);
      const [out, fine] = await add(b, [{ Email: "out@example.com" }, { Email: "in@example.com" }]);
      return { u, b, out: out!, fine: fine! };
    }
    const spent = async (u: User, b: Book) => ({
      balance: await db.select().from(creditBalances).where(eq(creditBalances.workspaceId, u.workspaceId)),
      ledger: await db.select().from(creditTransactions).where(eq(creditTransactions.workspaceId, u.workspaceId)),
      jobs: (await db.select().from(enrichmentJobs).where(eq(enrichmentJobs.workspaceId, u.workspaceId))).length,
      queued: (await db.select().from(asyncJobs).where(eq(asyncJobs.workspaceId, u.workspaceId))).length,
      runs: (await db.select().from(workbookRuns).where(eq(workbookRuns.workbookId, b.id))).length,
      // Includes the AI action allowance.
      usage: await db.select().from(schema.copsUsageCounters).where(eq(schema.copsUsageCounters.workspaceId, u.workspaceId)),
    });

    it.each(RUNNABLE)("does nothing outside for a suppressed row of a %s column, and records why", async (name) => {
      const { u, b, out, fine } = await runnable();
      const before = await spent(u, b);
      const execute = vi.fn(async () => "done");
      expect(await runForRow(db, u.workspaceId, b.id, b.col[name]!, out, execute)).toEqual({ skipped: "suppressed" });
      expect(execute).not.toHaveBeenCalled();
      expect(await cell(b, out, name)).toMatchObject({ state: "skipped", errorCode: "suppressed", value: null, creditsCharged: 0 });
      expect(await spent(u, b)).toEqual(before);

      expect(await runForRow(db, u.workspaceId, b.id, b.col[name]!, fine, execute)).toEqual({ skipped: null, result: "done" });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(await cell(b, fine, name)).toBeUndefined();
    });

    it("splits any choice of rows into those to run and those to skip", async () => {
      const { u, b, out, fine } = await runnable();
      const column = b.col.find_email!;
      expect(await rowsThatMayRun(db, u.workspaceId, b.id, column, [out, fine])).toEqual({ run: [fine], suppressed: [out] });
      expect(await rowsThatMayRun(db, u.workspaceId, b.id, column, [out])).toEqual({ run: [], suppressed: [out] });
      expect(await rowsThatMayRun(db, u.workspaceId, b.id, column, [])).toEqual({ run: [], suppressed: [] });
    });

    it("keeps a value a cell already holds, and notes the skip on one that holds none", async () => {
      const { u, b, out } = await runnable();
      await db.insert(workbookCells).values([
        { workbookId: b.id, rowId: out, columnId: b.col.find_email!, value: "kept@example.com", state: "found", creditsCharged: 2 },
        { workbookId: b.id, rowId: out, columnId: b.col.ai!, state: "error", errorCode: "timeout" },
      ]);
      for (const name of ["find_email", "ai"]) await rowsThatMayRun(db, u.workspaceId, b.id, b.col[name]!, [out]);
      expect(await cell(b, out, "find_email")).toMatchObject({ value: "kept@example.com", state: "found", errorCode: null, creditsCharged: 2 });
      expect(await cell(b, out, "ai")).toMatchObject({ state: "skipped", errorCode: "suppressed" });
    });

    it("reads the records again each time: an opt-out after the import, during a run or before a retry stops the next operation", async () => {
      const { u, b, fine } = await runnable();
      const execute = vi.fn(async () => {
        // The person unsubscribes while the first operation is under way.
        await suppress(u, "in@example.com");
      });
      expect((await runForRow(db, u.workspaceId, b.id, b.col.find_email!, fine, execute)).skipped).toBeNull();
      expect((await rowsOf(b.id))[1]!.suppressed).toBe(false);
      expect((await runForRow(db, u.workspaceId, b.id, b.col.verify_email!, fine, execute)).skipped).toBe("suppressed");
      expect((await runForRow(db, u.workspaceId, b.id, b.col.find_email!, fine, execute)).skipped).toBe("suppressed");
      expect(execute).toHaveBeenCalledTimes(1);
      expect((await rowsOf(b.id))[1]!.suppressed).toBe(true);

      await db.delete(suppressions).where(and(eq(suppressions.workspaceId, u.workspaceId), eq(suppressions.email, "in@example.com")));
      expect((await runForRow(db, u.workspaceId, b.id, b.col.find_email!, fine, async () => 1)).skipped).toBeNull();
      expect((await rowsOf(b.id))[1]!.suppressed).toBe(false);
    });

    it("does not act on a row of another workspace, another workbook, a deleted workbook or a row that is gone", async () => {
      const { u, b, fine } = await runnable();
      const other = await runnable();
      const execute = vi.fn(async () => 1);
      const column = b.col.find_email!;
      expect(await runForRow(db, other.u.workspaceId, b.id, column, fine, execute)).toEqual({ skipped: "row_missing" });
      expect(await runForRow(db, u.workspaceId, b.id, column, other.fine, execute)).toEqual({ skipped: "row_missing" });
      expect(await rowsThatMayRun(db, other.u.workspaceId, b.id, column, [fine])).toEqual({ run: [], suppressed: [] });
      await call(u, "DELETE", `/${b.id}/rows/${fine}`);
      expect(await runForRow(db, u.workspaceId, b.id, column, fine, execute)).toEqual({ skipped: "row_missing" });
      await call(other.u, "DELETE", `/${other.b.id}`);
      expect(await runForRow(db, other.u.workspaceId, other.b.id, other.b.col.find_email!, other.fine, execute)).toEqual({ skipped: "row_missing" });
      expect(execute).not.toHaveBeenCalled();
    });

    it("starts nothing through the run routes, for any scope", async () => {
      const { u, b, out } = await runnable();
      const before = [await spent(u, b), await db.select().from(workbookCells).where(eq(workbookCells.workbookId, b.id))];
      for (const body of [...["all", "empty", "failed", "first10"].map((scope) => ({ columnId: b.col.find_email, scope })), { columnId: b.col.find_email, scope: "selected", rowIds: [out] }]) {
        expect((await call(u, "POST", `/${b.id}/runs`, body)).statusCode, body.scope).toBe(501);
      }
      expect((await call(u, "POST", `/${b.id}/crm-push`, { columnId: b.col.push_to_crm })).statusCode).toBe(501);
      expect([await spent(u, b), await db.select().from(workbookCells).where(eq(workbookCells.workbookId, b.id))]).toEqual(before);
    });

    it("lets no code start a Workbooks V2 run without going through the check", () => {
      // The run engine is not built yet (WB2-050). Whatever records a run must use `runForRow` for what it does.
      const root = new URL("..", import.meta.url);
      const sources = ["services", "routes", "workers"].flatMap((folder) =>
        readdirSync(new URL(`${folder}/`, root))
          .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
          .map((f) => readFileSync(new URL(`${folder}/${f}`, root), "utf8"))
      );
      const starting = sources.filter((s) => /insert\(workbookRuns\)|insert\(schema\.workbookRuns\)|INSERT INTO workbook_runs/i.test(s));
      for (const source of starting) expect(source).toContain("runForRow");
      expect(sources.some((s) => s.includes("export async function runForRow"))).toBe(true);
    });
  });

  // ── Erasure ────────────────────────────────────────────────────────────────

  describe("erasure", () => {
    const request = async (u: User, email: string, extra: Record<string, unknown> = {}) => {
      const res = await send(u, "POST", "/dsar", { requestType: "erasure", subjectEmail: email, ...extra });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().data.id as string;
    };
    const complete = async (u: User, id: string) => {
      const res = await send(u, "PATCH", `/dsar/${id}`, { status: "completed" });
      expect(res.statusCode, res.body).toBe(200);
      return res.json();
    };
    const rowCount = async (id: string) => (await db.select({ n: workbooks.rowCount }).from(workbooks).where(eq(workbooks.id, id)))[0]!.n;
    const cellCount = async (id: string) => (await db.select().from(workbookCells).where(eq(workbookCells.workbookId, id))).length;
    const filesUnder = async (): Promise<string[]> => (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
    const everyFile = async () => (await Promise.all((await filesUnder()).map((f) => readFile(f, "utf8")))).join("\n");

    it("removes the person's rows and cells from every workbook, deleted ones too, and nothing else", async () => {
      const u = await user();
      const email = `erase-${suffix}@example.com`;
      const [a, b, gone] = [await workbook(u), await workbook(u), await workbook(u)];
      await add(a, [{ Name: "Subject", Email: email }, { Name: "Other", Email: "other@example.com" }, { Name: "Pasted as text", Notes: ` ${email.toUpperCase()} ` }]);
      await add(b, [{ Name: "Keep", Email: "keep@example.com" }, { Name: "Subject again", Email: email, Notes: "x" }]);
      await add(gone, [{ Name: "Subject", Email: email }]);
      await call(u, "DELETE", `/${gone.id}`);

      const id = await request(u, email);
      expect(await rowsOf(a.id)).toHaveLength(3);
      // Only completing the request removes anything.
      for (const status of ["in_progress", "rejected", "received"]) await send(u, "PATCH", `/dsar/${id}`, { status });
      expect(await rowsOf(a.id)).toHaveLength(3);

      const done = await complete(u, id);
      expect(done.data).toMatchObject({ status: "completed" });
      expect(done.erasure).toMatchObject({ rowsRemoved: 4, cellsCleared: 0, workbooks: 3 });
      expect(await names(a)).toEqual(["Other"]);
      expect(await names(b)).toEqual(["Keep"]);
      expect(await rowsOf(gone.id)).toEqual([]);
      expect([await rowCount(a.id), await rowCount(b.id), await rowCount(gone.id)]).toEqual([1, 1, 0]);
      expect([await cellCount(a.id), await cellCount(b.id), await cellCount(gone.id)]).toEqual([2, 2, 0]);

      const [listed] = await db.select().from(suppressions).where(and(eq(suppressions.workspaceId, u.workspaceId), eq(suppressions.email, email)));
      expect(listed!.reason).toBe("dsar_erasure");
      const trail = await db.select().from(auditLogs).where(eq(auditLogs.workspaceId, u.workspaceId));
      const mine = trail.filter((e) => e.action === "workbook.person.erased" || e.action === "workbook.rows.delete");
      expect(mine.map((e) => e.action)).toContain("workbook.person.erased");
      expect(mine.every((e) => e.actorId === u.userId)).toBe(true);
      expect(JSON.stringify(mine)).not.toContain("erase-");
      expect((await call(u, "GET", `/${a.id}/activity`)).body).toContain('"rows.deleted"');
    });

    it("is safe to repeat, and marks the person if they are imported again", async () => {
      const u = await user();
      const email = `again-${suffix}@example.com`;
      const b = await workbook(u);
      await add(b, [{ Email: email }, { Email: "stay@example.com" }]);
      const id = await request(u, email);
      await complete(u, id);
      const second = await complete(u, id);
      expect(second.erasure).toMatchObject({ rowsRemoved: 0, cellsCleared: 0 });
      expect(await rowsOf(b.id)).toHaveLength(1);
      expect(await db.select().from(suppressions).where(eq(suppressions.workspaceId, u.workspaceId))).toHaveLength(1);

      await add(b, [{ Email: email }]);
      expect(await marks(b)).toEqual([false, true]);
      // Completing it again takes the re-imported row out too.
      expect((await complete(u, id)).erasure).toMatchObject({ rowsRemoved: 1 });
    });

    it("finds the person by their prospect link, their LinkedIn profile and a contact the request names", async () => {
      const u = await user();
      const email = `known-${suffix}@example.com`;
      const held = await prospect(u, { email: email.toUpperCase() });
      const byContact = `kc-${suffix}`;
      const c = await contact(u, { email, prospectId: byContact });
      await db.insert(enrichmentIdentities).values({ workspaceId: u.workspaceId, entityType: "person", canonicalKey: `in:known-${suffix}`, entityId: c });
      const b = await workbook(u);
      const ids = await add(b, [{ Name: "by snapshot" }, { Name: "by contact" }, { Name: "by profile", LinkedIn: `https://www.linkedin.com/in/Known-${suffix}` }, { Name: "someone else", LinkedIn: `https://www.linkedin.com/in/known-${suffix}-jr` }]);
      await db.update(workbookRows).set({ prospectId: held }).where(eq(workbookRows.id, ids[0]!));
      await db.update(workbookRows).set({ prospectId: byContact }).where(eq(workbookRows.id, ids[1]!));
      await add(b, [{ Name: "by profile, with another address", LinkedIn: `linkedin.com/in/known-${suffix}`, Email: "assistant@example.com" }]);
      expect((await complete(u, await request(u, email))).erasure).toMatchObject({ rowsRemoved: 4, cellsCleared: 0 });
      expect(await names(b)).toEqual(["someone else"]);

      const named = await prospect(u);
      const d = await contact(u, { prospectId: named, email: `second-${suffix}@example.com` });
      const [linkedRow] = await add(b, [{ Name: "named" }]);
      await db.update(workbookRows).set({ prospectId: named }).where(eq(workbookRows.id, linkedRow!));
      await add(b, [{ Name: "their other address", Email: `second-${suffix}@example.com` }]);
      expect((await complete(u, await request(u, `first-${suffix}@example.com`, { subjectId: d, subjectType: "contact" }))).erasure.rowsRemoved).toBe(2);
      expect(await names(b)).toEqual(["someone else"]);
    });

    it("clears only the cell on a row about someone else that mentions the address", async () => {
      const u = await user();
      const email = `mentioned-${suffix}@example.com`;
      const b = await workbook(u);
      const [other, own] = await add(b, [{ Name: "Other", Email: "other@example.com", Notes: email }, { Name: "Theirs", Notes: email }]);
      const done = await complete(u, await request(u, email));
      expect(done.erasure).toMatchObject({ rowsRemoved: 1, cellsCleared: 1, workbooks: 1 });
      expect((await rowsOf(b.id)).map((r) => r.id)).toEqual([other]);
      expect(await cell(b, other!, "Notes")).toBeUndefined();
      expect((await cell(b, other!, "Email"))!.value).toBe("other@example.com");
      expect(own).toBeDefined();
    });

    it("does not remove rows for a shared phone number, a name, or text that only contains the address", async () => {
      const u = await user();
      const email = `narrow-${suffix}@example.com`;
      const c = await contact(u, { email });
      await db.update(contacts).set({ phone: "+1 555 010 0400" }).where(eq(contacts.id, c));
      const b = await workbook(u);
      await add(b, [{ Phone: "+1 555 010 0400" }, { Name: "Contact" }, { Notes: `write to ${email} today` }, { Email: `x${email}` }]);
      expect((await complete(u, await request(u, email))).erasure.rowsRemoved).toBe(0);
      expect(await rowsOf(b.id)).toHaveLength(4);
    });

    it("never touches another workspace", async () => {
      const [u, other] = [await user(), await user()];
      const email = `shared-${suffix}@example.com`;
      const [mine, theirs] = [await workbook(u), await workbook(other)];
      await add(mine, [{ Email: email }]);
      await add(theirs, [{ Email: email }]);
      const theirRequest = await request(other, email);
      await complete(u, await request(u, email));
      expect(await rowsOf(mine.id)).toEqual([]);
      expect(await rowsOf(theirs.id)).toHaveLength(1);
      expect(await db.select().from(suppressions).where(eq(suppressions.workspaceId, other.workspaceId))).toEqual([]);
      // Nor can their request be completed from here.
      expect((await send(u, "PATCH", `/dsar/${theirRequest}`, { status: "completed" })).statusCode).toBe(404);
      expect(await rowsOf(theirs.id)).toHaveLength(1);
    });

    it("leaves other kinds of request alone, and needs an owner or admin", async () => {
      const u = await user();
      const email = `kind-${suffix}@example.com`;
      const b = await workbook(u);
      await add(b, [{ Email: email }]);
      const access = await send(u, "POST", "/dsar", { requestType: "rectification", subjectEmail: email });
      await complete(u, access.json().data.id);
      expect(await rowsOf(b.id)).toHaveLength(1);

      const member = await user();
      await db.insert(schema.workspaceMembers).values({ workspaceId: u.workspaceId, userId: member.userId, role: "member" });
      const id = await request(u, email);
      const res = await send({ ...member, headers: { ...member.headers, "x-workspace-id": u.workspaceId } }, "PATCH", `/dsar/${id}`, { status: "completed" });
      expect(res.statusCode).toBe(403);
      expect(await rowsOf(b.id)).toHaveLength(1);
    });

    it("removes nothing and completes nothing if any part fails", async () => {
      const u = await user();
      const email = `atomic-${suffix}@example.com`;
      const b = await workbook(u);
      await add(b, [{ Email: email }]);
      const id = await request(u, email);
      const name = `wb2_supp_dsar_${suffix}`;
      await sql.unsafe(`create function ${name}() returns trigger language plpgsql as $$ begin if new.id = '${id}' and new.status = 'completed' then raise exception 'boom'; end if; return new; end $$`);
      try {
        await sql.unsafe(`create trigger ${name} before update on data_subject_requests for each row execute function ${name}()`);
        expect((await send(u, "PATCH", `/dsar/${id}`, { status: "completed" })).statusCode).toBe(500);
      } finally {
        await sql.unsafe(`drop trigger if exists ${name} on data_subject_requests`);
        await sql.unsafe(`drop function if exists ${name}()`);
      }
      const untouched = async () => {
        expect(await rowsOf(b.id)).toHaveLength(1);
        expect(await db.select().from(suppressions).where(eq(suppressions.workspaceId, u.workspaceId))).toEqual([]);
        expect((await db.select().from(dataSubjectRequests).where(eq(dataSubjectRequests.id, id)))[0]!.status).toBe("received");
      };
      await untouched();
      // The same when everything is written and the transaction then can't be committed.
      try {
        await sql.unsafe(`create function ${name}_late() returns trigger language plpgsql as $$ begin if new.email = '${email}' then raise exception 'boom'; end if; return null; end $$`);
        await sql.unsafe(`create constraint trigger ${name}_late after insert on suppressions deferrable initially deferred for each row execute function ${name}_late()`);
        expect((await send(u, "PATCH", `/dsar/${id}`, { status: "completed" })).statusCode).toBe(500);
      } finally {
        await sql.unsafe(`drop trigger if exists ${name}_late on suppressions`);
        await sql.unsafe(`drop function if exists ${name}_late()`);
      }
      await untouched();
      expect((await complete(u, id)).erasure.rowsRemoved).toBe(1);
    });

    it("takes the person out of import reports, waiting uploads and queued additions, leaving everyone else", async () => {
      const u = await user();
      const email = `files-${suffix}@example.com`;
      const b = await workbook(u);
      const upload = async (content: string) => {
        const res = await app.inject({ method: "POST", url: `${API}/workbooks-v2/${b.id}/imports`, remoteAddress: u.ip, headers: { ...u.headers, "content-type": "text/csv", "x-file-name": "a.csv" }, payload: content });
        expect(res.statusCode, res.body).toBe(201);
        return res.json().data.id as string;
      };
      // A finished import whose report lists the person and someone else; one waiting that holds them, and one that doesn't.
      const done = await upload(`Name,Email\nSubject,${email}\nSubject copy,${email}\nOther,dup-${suffix}@example.com\nOther copy,dup-${suffix}@example.com\n`);
      const confirmed = await call(u, "POST", `/${b.id}/imports/${done}/confirm`, { columns: [{ header: 0, columnId: b.col.Name }, { header: 1, columnId: b.col.Email }], dedupe: { key: "email", header: 1 } });
      expect(confirmed.json().data.report.available, confirmed.body).toBe(true);
      const waiting = await upload(`Name,Email\n${"Filler,f@example.com\n".repeat(30)}Late,${email.toUpperCase()}\n`);
      const unrelated = await upload("Name,Email\nSomeone,else@example.com\n");
      const queuedProspect = await prospect(u, { email });
      const [queued] = await db.insert(workbookImports).values({ workbookId: b.id, sourceType: "search", status: "queued", plan: {} }).returning();
      await db.insert(workbookImportItems).values([{ importId: queued!.id, seq: 1, prospectId: queuedProspect }, { importId: queued!.id, seq: 2, prospectId: "kept" }]);
      // Lines an import under way has noted and not yet written to its report.
      await db.insert(schema.workbookImportIssues).values([
        { importId: queued!.id, record: 1, line: 1, kind: "skipped", reason: "x", values: ["a", ` ${email.toUpperCase()}`] },
        { importId: queued!.id, record: 2, line: 2, kind: "skipped", reason: "x", values: [queuedProspect, "Name", "domain.com"] },
        { importId: queued!.id, record: 3, line: 3, kind: "skipped", reason: "x", values: ["kept", "Someone"] },
      ]);
      expect(await everyFile()).toContain(email);

      const result = await complete(u, await request(u, email));
      expect(result.erasure).toMatchObject({ rowsRemoved: 1, reportsCleaned: 1, previewsCancelled: 1 });
      expect((await everyFile()).toLowerCase()).not.toContain(email);
      const report = await call(u, "GET", `/${b.id}/imports/${done}/report`);
      expect(report.statusCode).toBe(200);
      expect(report.body).toContain(`dup-${suffix}@example.com`);
      expect(report.body).toContain('"Reason"');
      const state = async (id: string) => (await db.select().from(workbookImports).where(eq(workbookImports.id, id)))[0]!;
      expect(await state(waiting)).toMatchObject({ status: "cancelled", preview: null, fileKey: null });
      expect((await state(unrelated)).status).toBe("awaiting_confirmation");
      expect((await db.select().from(workbookImportItems).where(eq(workbookImportItems.importId, queued!.id)).orderBy(asc(workbookImportItems.seq))).map((i) => i.prospectId)).toEqual(["erased", "kept"]);
      expect((await db.select().from(schema.workbookImportIssues).where(eq(schema.workbookImportIssues.importId, queued!.id))).map((i) => i.record)).toEqual([3]);
      expect((await complete(u, await request(u, email))).erasure).toMatchObject({ rowsRemoved: 0, reportsCleaned: 0, previewsCancelled: 0 });
    });

    it("happens when a person is deleted in enrichment, without adding them to the suppression list", async () => {
      const u = await user();
      const other = await user();
      const email = `captured-${suffix}@example.com`;
      const id = await prospect(u, { email, fullName: "Captured Person" });
      const c = await contact(u, { prospectId: id, email });
      await db.insert(enrichmentIdentities).values({ workspaceId: u.workspaceId, entityType: "person", canonicalKey: `in:captured-${suffix}`, entityId: c });
      const [a, b, theirs] = [await workbook(u), await workbook(u), await workbook(other)];
      const [linkedRow] = await add(a, [{ Name: "linked" }, { Name: "other", Email: "other@example.com" }]);
      await db.update(workbookRows).set({ prospectId: id }).where(eq(workbookRows.id, linkedRow!));
      await add(b, [{ Name: "by profile", LinkedIn: `linkedin.com/in/captured-${suffix}` }, { Name: "by email", Email: email }]);
      await add(theirs, [{ Email: email }]);

      const res = await send(u, "DELETE", `/enrichment/people/${id}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ success: true, workbookRowsRemoved: 3 });
      expect(await names(a)).toEqual(["other"]);
      expect(await rowsOf(b.id)).toEqual([]);
      expect(await rowsOf(theirs.id)).toHaveLength(1);
      expect(await db.select().from(suppressions).where(eq(suppressions.workspaceId, u.workspaceId))).toEqual([]);
      expect((await send(u, "DELETE", `/enrichment/people/${id}`)).statusCode).toBe(404);
      const audited = await db.select().from(auditLogs).where(and(eq(auditLogs.workspaceId, u.workspaceId), eq(auditLogs.action, "workbook.person.erased")));
      expect(audited).toHaveLength(1);
    });
  });
});
