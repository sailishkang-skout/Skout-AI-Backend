import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { createDb, schema } from "@skout/db";
import { buildTestAuthEnv, buildTestAuthToken, ensureTestAuthHarness, grantSystemMemberRole, invalidateWorkspaceAccess } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";
import { isPublicRoute } from "../plugins/auth.js";

/**
 * WB2-015, PRD SEC-1: nobody can see or touch another workspace's workbooks through any Workbooks V2 route.
 *
 * Workspace A attacks workspace B with A's own session (a real bearer token, not the stub header). Each request naming
 * something of B's is
 *  - repeated with ids that exist nowhere, and must get the identical answer, so B's ids reveal nothing;
 *  - checked for any of B's data in the answer; and
 *  - followed by a comparison of everything both workspaces store, which must be unchanged.
 * The 404, 422 and 409 cases are also sent by an owner against their own data, where they must work, so a refusal can
 * only be about ownership.
 *
 * What each kind of foreign id must get:
 *  - a workbook, or a row or column the API looks up, that is not the caller's: 404;
 *  - another workbook's column, list or sequence named inside a request on the caller's own workbook: 422 or 409, the
 *    same answer as a made-up id (the addressed resource is the caller's; the request is invalid);
 *  - a `workspaceId` in a body or query: 422, the field is refused;
 *  - an `x-workspace-id` the caller does not belong to: 403 from sign-in, before any workbook is looked up.
 *
 * There are no run-history, import, export or webhook routes yet. B has such records so their ids can be watched, and
 * the first test fails as soon as any route is registered without a case here. B also has activity log entries.
 */
const base = loadEnv();
const hasDatabase = Boolean(base.DATABASE_URL);
/** In CI a missing database is a failure, never a silently skipped suite. */
const mustRun = Boolean(process.env.CI);
const PREFIX = "/api/v1";

const {
  workspaces,
  users,
  workspaceMembers,
  entitlements,
  workbooks,
  workbookColumns,
  workbookCells,
  workbookRuns,
  workbookImports,
  workbookViews,
  workbookWebhooks,
  creditBalances,
  sequences,
  lists,
  crmConnections,
  workspaceIntegrations,
  auditLogs,
} = schema;

type Method = "GET" | "HEAD" | "POST" | "PATCH" | "DELETE";
interface Req {
  method: Method;
  /** After /api/v1/workbooks-v2. */
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Every id a request can name, for one workspace. */
interface Ids {
  workspace: string;
  workbook: string;
  /** A soft-deleted workbook. */
  deleted: string;
  input: string;
  spare: string;
  formula: string;
  enrichment: string;
  ai: string;
  action: string;
  crm: string;
  row1: number;
  row2: number;
  row3: number;
  sequence: string;
  list: string;
  run: string;
  import: string;
  view: string;
  webhook: string;
  /** An entry in the workbook's activity log. */
  activity: string;
  /** Idempotency keys this workspace has already used. */
  duplicateKey: string;
  rowKey: string;
  bulkKey: string;
  columnKey: string;
}

const COLUMN_KEYS = ["input", "spare", "formula", "enrichment", "ai", "action", "crm"] as const;
const allColumns = (ids: Ids) => COLUMN_KEYS.map((key) => ids[key]);

/** Ids that exist nowhere. */
function ghostIds(): Ids {
  const row = 7_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000_000);
  const id = () => randomUUID();
  return {
    workspace: id(), workbook: id(), deleted: id(), input: id(), spare: id(), formula: id(), enrichment: id(), ai: id(), action: id(), crm: id(),
    row1: row, row2: row + 1, row3: row + 2, sequence: id(), list: id(), run: id(), import: id(), view: id(), webhook: id(), activity: id(),
    duplicateKey: id(), rowKey: id(), bulkKey: id(), columnKey: id(),
  };
}

interface Case {
  /** The registered route this exercises. */
  route: string;
  name: string;
  /** `mine` are the caller's ids; `theirs` are the ids of the workspace being attacked. */
  send: (mine: Ids, theirs: Ids) => Req;
  /** What an owner gets for the same request on their own data, if not a success. */
  own?: number;
}

const formula = (columnId: string) => ({ fn: "trim_clean", source: { columnId } });
const textColumn = { name: "added", type: "input" };

// The requests a workspace itself sends with an idempotency key; an attacker replays them exactly.
const duplicateRequest = (ids: Ids): Req => ({ method: "POST", path: `/${ids.workbook}/duplicate`, body: { includeRows: true }, headers: { "idempotency-key": ids.duplicateKey } });
const rowRequest = (ids: Ids): Req => ({ method: "POST", path: `/${ids.workbook}/rows`, body: { cells: { [ids.input]: "keyed" } }, headers: { "idempotency-key": ids.rowKey } });
const bulkRequest = (ids: Ids): Req => ({ method: "POST", path: `/${ids.workbook}/rows/bulk`, body: { rows: [{ cells: { [ids.input]: "keyed" } }] }, headers: { "idempotency-key": ids.bulkKey } });
const columnRequest = (ids: Ids): Req => ({ method: "POST", path: `/${ids.workbook}/columns`, body: textColumn, headers: { "idempotency-key": ids.columnKey } });

/** Requests naming a workbook, row or column of another workspace where the API looks it up: always 404. */
function notFoundCases(): Case[] {
  const cases: Case[] = [];
  const on = (route: string, name: string, send: Case["send"], own?: number) => cases.push({ route, name, send, own });
  const [GET, PATCH, DEL] = ["GET /workbooks-v2/:id", "PATCH /workbooks-v2/:id", "DELETE /workbooks-v2/:id"];

  on(GET!, "open their workbook", (_, t) => ({ method: "GET", path: `/${t.workbook}` }));
  on(PATCH!, "rename their workbook", (_, t) => ({ method: "PATCH", path: `/${t.workbook}`, body: { name: "taken over" } }));
  on(DEL!, "delete their workbook", (_, t) => ({ method: "DELETE", path: `/${t.workbook}` }));
  const duplicate = "POST /workbooks-v2/:id/duplicate";
  on(duplicate, "copy their columns", (_, t) => ({ method: "POST", path: `/${t.workbook}/duplicate`, body: { includeRows: false } }));
  on(duplicate, "copy their rows", (_, t) => ({ method: "POST", path: `/${t.workbook}/duplicate`, body: { includeRows: true, name: "mine now" } }));
  on(duplicate, "replay their keyed copy", (_, t) => duplicateRequest(t));
  const restore = "POST /workbooks-v2/:id/restore";
  on(restore, "restore their deleted workbook", (_, t) => ({ method: "POST", path: `/${t.deleted}/restore` }));
  // An owner is told it is not deleted (409); anyone else must not learn that much.
  on(restore, "restore their live workbook", (_, t) => ({ method: "POST", path: `/${t.workbook}/restore` }), 409);

  const rows = "GET /workbooks-v2/:id/rows";
  on(rows, "read their rows", (_, t) => ({ method: "GET", path: `/${t.workbook}/rows` }));
  on(rows, "read a window of their rows and cells", (_, t) => ({ method: "GET", path: `/${t.workbook}/rows?offset=1&limit=1&columnIds=${t.input},${t.formula}` }));
  on(rows, "read their rows naming my columns", (m, t) => ({ method: "GET", path: `/${t.workbook}/rows?columnIds=${m.input}` }));
  const query = "POST /workbooks-v2/:id/rows/query";
  on(query, "search, filter and sort their rows", (_, t) => ({
    method: "POST",
    path: `/${t.workbook}/rows/query`,
    body: { search: "a", filters: [{ type: "value", columnId: t.input, op: "has_value" }], sort: [{ columnId: t.input }], columnIds: [t.input] },
  }));
  on(query, "query their rows by my column", (m, t) => ({ method: "POST", path: `/${t.workbook}/rows/query`, body: { sort: [{ columnId: m.input }] } }));
  const addRow = "POST /workbooks-v2/:id/rows";
  on(addRow, "add a row to their workbook", (_, t) => ({ method: "POST", path: `/${t.workbook}/rows`, body: { cells: { [t.input]: "injected" } } }));
  on(addRow, "add a row to theirs using my column", (m, t) => ({ method: "POST", path: `/${t.workbook}/rows`, body: { cells: { [m.input]: "injected" } } }));
  on(addRow, "replay their keyed row", (_, t) => rowRequest(t));
  const bulk = "POST /workbooks-v2/:id/rows/bulk";
  on(bulk, "bulk add to their workbook", (_, t) => ({ method: "POST", path: `/${t.workbook}/rows/bulk`, body: { rows: [{ cells: { [t.input]: "injected" } }, {}] } }));
  on(bulk, "replay their keyed bulk add", (_, t) => bulkRequest(t));

  const editRow = "PATCH /workbooks-v2/:id/rows/:rowId";
  on(editRow, "edit their cell", (_, t) => ({ method: "PATCH", path: `/${t.workbook}/rows/${t.row1}`, body: { cells: { [t.input]: "overwritten" } } }));
  on(editRow, "edit my row inside their workbook", (m, t) => ({ method: "PATCH", path: `/${t.workbook}/rows/${m.row1}`, body: { cells: { [m.input]: "x" } } }));
  on(editRow, "edit their row through my workbook", (m, t) => ({ method: "PATCH", path: `/${m.workbook}/rows/${t.row1}`, body: { cells: { [m.input]: "x" } } }));
  on(editRow, "clear their cell through my workbook", (m, t) => ({ method: "PATCH", path: `/${m.workbook}/rows/${t.row2}`, body: { cells: { [m.input]: null } } }));
  const deleteRow = "DELETE /workbooks-v2/:id/rows/:rowId";
  on(deleteRow, "delete their row", (_, t) => ({ method: "DELETE", path: `/${t.workbook}/rows/${t.row1}` }));
  on(deleteRow, "delete my row inside their workbook", (m, t) => ({ method: "DELETE", path: `/${t.workbook}/rows/${m.row1}` }));
  on(deleteRow, "delete their row through my workbook", (m, t) => ({ method: "DELETE", path: `/${m.workbook}/rows/${t.row1}` }));
  const deleteRows = "POST /workbooks-v2/:id/rows/delete";
  on(deleteRows, "delete their rows", (_, t) => ({ method: "POST", path: `/${t.workbook}/rows/delete`, body: { rowIds: [t.row1, t.row2] } }));
  on(deleteRows, "delete my rows inside their workbook", (m, t) => ({ method: "POST", path: `/${t.workbook}/rows/delete`, body: { rowIds: [m.row1] } }));
  on(deleteRows, "delete their rows through my workbook", (m, t) => ({ method: "POST", path: `/${m.workbook}/rows/delete`, body: { rowIds: [t.row1, t.row2] } }));
  on(deleteRows, "slip their row in among mine", (m, t) => ({ method: "POST", path: `/${m.workbook}/rows/delete`, body: { rowIds: [m.row1, t.row2] } }));

  const addColumn = "POST /workbooks-v2/:id/columns";
  on(addColumn, "add a column to their workbook", (_, t) => ({ method: "POST", path: `/${t.workbook}/columns`, body: textColumn }));
  on(addColumn, "add a column reading theirs to their workbook", (_, t) => ({ method: "POST", path: `/${t.workbook}/columns`, body: { name: "x", type: "formula", config: formula(t.input) } }));
  on(addColumn, "add a column reading mine to their workbook", (m, t) => ({ method: "POST", path: `/${t.workbook}/columns`, body: { name: "x", type: "formula", config: formula(m.input) } }));
  on(addColumn, "replay their keyed column", (_, t) => columnRequest(t));
  const reorder = "POST /workbooks-v2/:id/columns/reorder";
  on(reorder, "reorder their columns", (_, t) => ({ method: "POST", path: `/${t.workbook}/columns/reorder`, body: { columnIds: allColumns(t) } }));
  on(reorder, "reorder their workbook with my columns", (m, t) => ({ method: "POST", path: `/${t.workbook}/columns/reorder`, body: { columnIds: allColumns(m) } }));

  const editColumn = "PATCH /workbooks-v2/:id/columns/:columnId";
  const edits: Array<[string, (ids: Ids) => Record<string, unknown>]> = [
    ["rename", () => ({ name: "taken over" })],
    ["hide", () => ({ hidden: true })],
    ["freeze", () => ({ frozen: true })],
    ["resize", () => ({ width: 500 })],
    ["reconfigure", (ids) => ({ config: formula(ids.input) })],
  ];
  for (const [verb, body] of edits) {
    on(editColumn, `${verb} their column`, (_, t) => ({ method: "PATCH", path: `/${t.workbook}/columns/${t.formula}`, body: body(t) }));
    on(editColumn, `${verb} their column through my workbook`, (m, t) => ({ method: "PATCH", path: `/${m.workbook}/columns/${t.formula}`, body: body(m) }));
  }
  on(editColumn, "edit my column inside their workbook", (m, t) => ({ method: "PATCH", path: `/${t.workbook}/columns/${m.formula}`, body: { hidden: true } }));
  const deleteColumn = "DELETE /workbooks-v2/:id/columns/:columnId";
  on(deleteColumn, "delete their column", (_, t) => ({ method: "DELETE", path: `/${t.workbook}/columns/${t.spare}` }));
  on(deleteColumn, "delete my column inside their workbook", (m, t) => ({ method: "DELETE", path: `/${t.workbook}/columns/${m.spare}` }));
  on(deleteColumn, "delete their column through my workbook", (m, t) => ({ method: "DELETE", path: `/${m.workbook}/columns/${t.spare}` }));

  const activity = "GET /workbooks-v2/:id/activity";
  on(activity, "read their activity log", (_, t) => ({ method: "GET", path: `/${t.workbook}/activity` }));
  on(activity, "page through their activity log", (_, t) => ({ method: "GET", path: `/${t.workbook}/activity?limit=1` }));

  // Runs and CRM pushes: there is no engine yet, so an owner's valid request answers 501.
  for (const [route, path, column] of [
    ["POST /workbooks-v2/:id/runs", "runs", "enrichment"],
    ["POST /workbooks-v2/:id/crm-push", "crm-push", "crm"],
  ] as const) {
    const run = (workbook: string, body: Record<string, unknown>): Req => ({ method: "POST", path: `/${workbook}/${path}`, body });
    on(route, "start on their column", (_, t) => run(t.workbook, { columnId: t[column] }), 501);
    on(route, "start on their selected rows", (_, t) => run(t.workbook, { columnId: t[column], scope: "selected", rowIds: [t.row1] }), 501);
    on(route, "start in their workbook on my column", (m, t) => run(t.workbook, { columnId: m[column] }), 501);
    on(route, "start on their column through my workbook", (m, t) => run(m.workbook, { columnId: t[column] }), 501);
    on(route, "start on my column with their rows", (m, t) => run(m.workbook, { columnId: m[column], scope: "selected", rowIds: [t.row1, t.row2] }), 501);
    on(route, "slip their row in among mine", (m, t) => run(m.workbook, { columnId: m[column], scope: "selected", rowIds: [m.row1, t.row2] }), 501);
  }

  // Fastify answers HEAD for every GET, through the same handler.
  for (const c of cases.filter((c) => c.route.startsWith("GET "))) {
    cases.push({ route: c.route.replace("GET ", "HEAD "), name: c.name, send: (m, t) => ({ ...c.send(m, t), method: "HEAD" }), own: c.own });
  }
  return cases;
}

/** Another workspace's ids named inside a request on the caller's own workbook. */
function referenceCases(): Array<Case & { status: number; code: string }> {
  const cases: Array<Case & { status: number; code: string }> = [];
  const on = (status: number, code: string) => (route: string, name: string, send: Case["send"]) => cases.push({ route, name, send, status, code });
  const unknown = on(422, "UNKNOWN_COLUMN");
  const config = on(422, "INVALID_COLUMN_CONFIG");
  const conflict = on(409, "COLUMN_ORDER_CONFLICT");

  unknown("GET /workbooks-v2/:id/rows", "ask for their column", (m, t) => ({ method: "GET", path: `/${m.workbook}/rows?columnIds=${m.input},${t.input}` }));
  const query = (name: string, body: (m: Ids, t: Ids) => unknown) =>
    unknown("POST /workbooks-v2/:id/rows/query", name, (m, t) => ({ method: "POST", path: `/${m.workbook}/rows/query`, body: body(m, t) }));
  query("return their column", (_, t) => ({ columnIds: [t.input] }));
  query("sort by their column", (m, t) => ({ sort: [{ columnId: m.input }, { columnId: t.input }] }));
  query("filter by their column's value", (_, t) => ({ filters: [{ type: "value", columnId: t.input, op: "has_value" }] }));
  query("filter by their column's state", (_, t) => ({ filters: [{ type: "state", columnId: t.input, states: ["found"] }] }));

  unknown("POST /workbooks-v2/:id/rows", "write to their column", (m, t) => ({ method: "POST", path: `/${m.workbook}/rows`, body: { cells: { [m.input]: "a", [t.input]: "b" } } }));
  unknown("POST /workbooks-v2/:id/rows/bulk", "write one of many rows to their column", (m, t) => ({
    method: "POST",
    path: `/${m.workbook}/rows/bulk`,
    body: { rows: [{ cells: { [m.input]: "a" } }, { cells: { [t.input]: "b" } }] },
  }));
  unknown("PATCH /workbooks-v2/:id/rows/:rowId", "edit my row's cell in their column", (m, t) => ({ method: "PATCH", path: `/${m.workbook}/rows/${m.row1}`, body: { cells: { [t.input]: "x" } } }));

  const addConfig = (name: string, column: (m: Ids, t: Ids) => Record<string, unknown>) =>
    config("POST /workbooks-v2/:id/columns", name, (m, t) => ({ method: "POST", path: `/${m.workbook}/columns`, body: { name: "x", ...column(m, t) } }));
  addConfig("formula on their column", (_, t) => ({ type: "formula", config: formula(t.input) }));
  addConfig("join with their column", (m, t) => ({ type: "formula", config: { fn: "join", parts: [{ columnId: m.input }, { columnId: t.input }] } }));
  addConfig("enrichment reading their column", (_, t) => ({ type: "enrichment", operation: "company_domain", config: { inputs: { companyName: { columnId: t.input } } } }));
  addConfig("condition on their column", (m, t) => ({
    type: "enrichment",
    operation: "company_domain",
    config: { inputs: { companyName: { columnId: m.input } }, condition: { rules: [{ columnId: t.input, op: "has_value" }] } },
  }));
  addConfig("prompt quoting their column", (_, t) => ({ type: "ai", config: { prompt: `About {{${t.input}}}`, output: { type: "text" } } }));
  addConfig("add to their list", (_, t) => ({ type: "action", operation: "add_to_list", config: { listId: t.list } }));
  addConfig("enrol in their sequence", (m, t) => ({ type: "action", operation: "add_to_sequence", config: { sequenceId: t.sequence, emailColumn: { columnId: m.input } } }));
  addConfig("send their column to a webhook", (_, t) => ({ type: "action", operation: "send_to_webhook", config: { url: "https://hooks.example.com/x", columns: [{ columnId: t.input }] } }));
  addConfig("push their column to a CRM", (_, t) => ({ type: "action", operation: "push_to_crm", config: { provider: "hubspot", object: "contact", mapping: [{ crmField: "email", columnId: t.input }] } }));
  config("PATCH /workbooks-v2/:id/columns/:columnId", "repoint my formula at their column", (m, t) => ({ method: "PATCH", path: `/${m.workbook}/columns/${m.formula}`, body: { config: formula(t.input) } }));
  config("PATCH /workbooks-v2/:id/columns/:columnId", "repoint my action at their list", (m, t) => ({ method: "PATCH", path: `/${m.workbook}/columns/${m.action}`, body: { config: { listId: t.list } } }));

  const swapped = (m: Ids, t: Ids) => allColumns(m).map((id) => (id === m.spare ? t.spare : id));
  conflict("POST /workbooks-v2/:id/columns/reorder", "order their column into my workbook", (m, t) => ({ method: "POST", path: `/${m.workbook}/columns/reorder`, body: { columnIds: swapped(m, t) } }));
  conflict("POST /workbooks-v2/:id/columns/reorder", "claim their column was in my previous order", (m, t) => ({
    method: "POST",
    path: `/${m.workbook}/columns/reorder`,
    body: { columnIds: allColumns(m), previousColumnIds: swapped(m, t) },
  }));
  return cases;
}

/** Naming a workspace in a request is never honoured: the field is refused outright. */
const workspaceClaims: Case[] = [
  { route: "POST /workbooks-v2", name: "create in their workspace", send: (_, t) => ({ method: "POST", path: "", body: { name: "planted", workspaceId: t.workspace } }) },
  { route: "PATCH /workbooks-v2/:id", name: "move my workbook to their workspace", send: (m, t) => ({ method: "PATCH", path: `/${m.workbook}`, body: { name: "x", workspaceId: t.workspace } }) },
  { route: "POST /workbooks-v2/:id/duplicate", name: "copy my workbook into their workspace", send: (m, t) => ({ method: "POST", path: `/${m.workbook}/duplicate`, body: { includeRows: true, workspaceId: t.workspace } }) },
  { route: "GET /workbooks-v2/:id/rows", name: "read rows as their workspace", send: (m, t) => ({ method: "GET", path: `/${m.workbook}/rows?workspaceId=${t.workspace}` }) },
  { route: "POST /workbooks-v2/:id/rows/query", name: "query as their workspace", send: (m, t) => ({ method: "POST", path: `/${m.workbook}/rows/query`, body: { workspaceId: t.workspace } }) },
  { route: "POST /workbooks-v2/:id/rows", name: "add a row as their workspace", send: (m, t) => ({ method: "POST", path: `/${m.workbook}/rows`, body: { workspaceId: t.workspace } }) },
  { route: "POST /workbooks-v2/:id/columns", name: "add a column as their workspace", send: (m, t) => ({ method: "POST", path: `/${m.workbook}/columns`, body: { ...textColumn, workspaceId: t.workspace } }) },
  { route: "GET /workbooks-v2/:id/activity", name: "read activity as their workspace", send: (m, t) => ({ method: "GET", path: `/${m.workbook}/activity?workspaceId=${t.workspace}` }) },
  { route: "POST /workbooks-v2/:id/runs", name: "run as their workspace", send: (m, t) => ({ method: "POST", path: `/${m.workbook}/runs`, body: { columnId: m.enrichment, workspaceId: t.workspace } }) },
];

/** Routes that name no resource; they answer for the caller's workspace only. */
const collectionCases: Case[] = [
  { route: "GET /workbooks-v2/status", name: "feature status", send: () => ({ method: "GET", path: "/status" }) },
  { route: "HEAD /workbooks-v2/status", name: "feature status", send: () => ({ method: "HEAD", path: "/status" }) },
  { route: "GET /workbooks-v2", name: "list", send: () => ({ method: "GET", path: "" }) },
  { route: "HEAD /workbooks-v2", name: "list", send: () => ({ method: "HEAD", path: "" }) },
  { route: "POST /workbooks-v2", name: "create", send: () => ({ method: "POST", path: "", body: { name: "new" } }) },
];

const NOT_FOUND = notFoundCases();
const REFERENCES = referenceCases();
const ROUTES = [...new Set([...collectionCases, ...NOT_FOUND, ...REFERENCES, ...workspaceClaims].map((c) => c.route))].sort();
/** One request per route, for the checks that do not depend on which resource is named. */
const representative = (route: string) => [...collectionCases, ...NOT_FOUND].find((c) => c.route === route)!;
const label = (c: Case) => [c.route, c.name] as const;

describe.skipIf(!hasDatabase && !mustRun)("Workbooks V2 tenant isolation", () => {
  let db: ReturnType<typeof createDb>["db"];
  let sql: ReturnType<typeof createDb>["sql"];
  let app: FastifyInstance;
  const registered = new Set<string>();
  const publicRoutes: string[] = [];
  const created: string[] = [];
  const run = randomUUID().slice(0, 8);
  let requests = 0;

  interface Person {
    userId: string;
    email: string;
    workspaceId: string;
  }
  interface Tenant extends Person {
    ids: Ids;
    /** Text planted in everything this workspace stores. */
    marker: string;
    /** Strings that must never reach another workspace. */
    secrets: string[];
  }

  let A: Tenant;
  let B: Tenant;

  /** Sends a request as `who`, signed in and acting in their workspace. Each token is new, so rate limits never interfere. */
  function send(who: Person | null, req: Req, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    requests += 1;
    const auth: Record<string, string> = who
      ? { authorization: `Bearer ${buildTestAuthToken({ userId: who.userId, email: who.email, name: `request ${requests}` })}`, "x-workspace-id": who.workspaceId }
      : {};
    return app.inject({
      method: req.method as InjectOptions["method"],
      url: `${PREFIX}/workbooks-v2${req.path}`,
      remoteAddress: `10.${(requests >> 16) & 255}.${(requests >> 8) & 255}.${requests & 255}`,
      headers: { ...auth, ...(req.body === undefined ? {} : { "content-type": "application/json" }), ...req.headers, ...headers },
      ...(req.body === undefined ? {} : { payload: JSON.stringify(req.body) }),
    });
  }

  /** A workspace with an owner and something of every kind a workbook route can reach. */
  async function tenant(name: string): Promise<Tenant> {
    const marker = `zz${name}${run}${randomUUID().slice(0, 6)}`;
    const ids = ghostIds();
    const userId = randomUUID();
    const email = `${marker.toLowerCase()}@example.com`;
    await db.insert(workspaces).values({ id: ids.workspace, name: marker, slug: marker.toLowerCase(), accessStatus: "active" });
    created.push(ids.workspace);
    await db.insert(users).values({ id: userId, email, fullName: marker, status: "active" });
    await db.insert(workspaceMembers).values({ workspaceId: ids.workspace, userId, role: "owner" });
    if (!(await grantSystemMemberRole(db, ids.workspace, userId, "owner"))) throw new Error("System roles are not seeded");
    await db.insert(entitlements).values({ workspaceId: ids.workspace, key: "feature.workbooks_v2", value: true, source: "test" });
    invalidateWorkspaceAccess(ids.workspace);
    await db.insert(creditBalances).values({ workspaceId: ids.workspace, balance: 500 });
    await db.insert(sequences).values({ id: ids.sequence, workspaceId: ids.workspace, name: marker });
    await db.insert(lists).values({ id: ids.list, workspaceId: ids.workspace, name: marker });
    await db.insert(crmConnections).values({ workspaceId: ids.workspace, provider: "hubspot", externalAccountId: marker });
    await db.insert(workspaceIntegrations).values({ workspaceId: ids.workspace, provider: "hunter", encryptedApiKey: marker, keyHint: marker });

    await db.insert(workbooks).values([
      { id: ids.workbook, workspaceId: ids.workspace, name: `${marker} workbook`, createdBy: userId, rowCount: 3 },
      { id: ids.deleted, workspaceId: ids.workspace, name: `${marker} deleted`, createdBy: userId, deletedAt: new Date() },
    ]);
    const column = (key: (typeof COLUMN_KEYS)[number], type: "input" | "formula" | "enrichment" | "ai" | "action", operation: string | null, config: Record<string, unknown>) => ({
      id: ids[key],
      workbookId: ids.workbook,
      name: `${marker} ${key}`,
      type,
      position: COLUMN_KEYS.indexOf(key),
      operation,
      config,
    });
    await db.insert(workbookColumns).values([
      column("input", "input", null, { dataType: "text" }),
      column("spare", "input", null, { dataType: "text" }),
      column("formula", "formula", null, formula(ids.input)),
      column("enrichment", "enrichment", "company_domain", { inputs: { companyName: { columnId: ids.input } } }),
      column("ai", "ai", null, { prompt: marker, output: { type: "text" } }),
      column("action", "action", "add_to_list", { listId: ids.list }),
      column("crm", "action", "push_to_crm", { provider: "hubspot", object: "contact", mapping: [{ crmField: "email", columnId: ids.input }] }),
    ]);
    // Rows get large, unmistakable ids, so one cannot appear in an answer by coincidence.
    for (const [position, rowId] of [ids.row1, ids.row2, ids.row3].entries()) {
      await sql`insert into workbook_rows (id, workbook_id, position, source, prospect_id, crm_ref) overriding system value
        values (${rowId}, ${ids.workbook}, ${position}, ${JSON.stringify({ type: "csv", file: `${marker}.csv` })}::text::jsonb, ${marker}, ${JSON.stringify({ provider: "hubspot", id: marker })}::text::jsonb)`;
      await db.insert(workbookCells).values([
        { workbookId: ids.workbook, rowId, columnId: ids.input, state: "found", value: `${marker} value ${position}` },
        { workbookId: ids.workbook, rowId, columnId: ids.enrichment, state: "found", value: `${marker}.example.com`, internalProvenance: { provider: marker } },
      ]);
    }
    await db.insert(workbookRuns).values({ id: ids.run, workbookId: ids.workbook, columnId: ids.enrichment, scope: "all", status: "completed", rowFilter: { note: marker }, startedBy: userId });
    await db.insert(workbookImports).values({ id: ids.import, workbookId: ids.workbook, sourceType: "csv", errorReportFile: `${marker}.csv` });
    await db.insert(workbookViews).values({ id: ids.view, workbookId: ids.workbook, name: marker, hiddenColumns: [ids.spare] });
    await db.insert(workbookWebhooks).values({ id: ids.webhook, workbookId: ids.workbook, tokenHash: `${marker}-token-hash` });
    // One log entry on each workbook, so a log that mixed workbooks up would show it.
    const entry = (entityId: string) => ({ workspaceId: ids.workspace, actorId: userId, action: "workbook.rows.added", entityType: "workbook", entityId, afterState: { source: marker, rows: 3, rowCount: 3 } });
    await db.insert(auditLogs).values([{ id: ids.activity, ...entry(ids.workbook) }, entry(ids.deleted)]);

    const resources = Object.entries(ids)
      .filter(([key]) => !key.endsWith("Key"))
      .map(([, value]) => String(value));
    return { userId, email, workspaceId: ids.workspace, ids, marker, secrets: [marker, marker.toLowerCase(), userId, ...resources] };
  }

  /** Everything a workspace stores that a workbook route could read, change or spend. */
  async function stored(t: Tenant): Promise<string> {
    const w = t.workspaceId;
    const [row] = await sql`
      with books as (select id from workbooks where workspace_id = ${w})
      select jsonb_build_object(
        'workbooks', (select jsonb_agg(x order by x.id) from workbooks x where x.workspace_id = ${w}),
        'columns', (select jsonb_agg(x order by x.id) from workbook_columns x where x.workbook_id in (select id from books)),
        'rows', (select jsonb_agg(x order by x.id) from workbook_rows x where x.workbook_id in (select id from books)),
        'cells', (select jsonb_agg(x order by x.row_id, x.column_id) from workbook_cells x where x.workbook_id in (select id from books)),
        'runs', (select jsonb_agg(x order by x.id) from workbook_runs x where x.workbook_id in (select id from books)),
        'imports', (select jsonb_agg(x order by x.id) from workbook_imports x where x.workbook_id in (select id from books)),
        'views', (select jsonb_agg(x order by x.id) from workbook_views x where x.workbook_id in (select id from books)),
        'webhooks', (select jsonb_agg(x order by x.id) from workbook_webhooks x where x.workbook_id in (select id from books)),
        'audit', (select jsonb_agg(x order by x.id) from audit_logs x where x.workspace_id = ${w}),
        'balance', (select jsonb_agg(x) from credit_balances x where x.workspace_id = ${w}),
        'credits', (select jsonb_agg(x order by x.id) from credit_transactions x where x.workspace_id = ${w}),
        'jobs', (select count(*) from async_jobs x where x.workspace_id = ${w}) + (select count(*) from enrichment_jobs x where x.workspace_id = ${w}),
        'lists', (select jsonb_agg(x order by x.id) from lists x where x.workspace_id = ${w}),
        'listMembers', (select count(*) from list_members x join lists l on l.id = x.list_id where l.workspace_id = ${w}),
        'sequences', (select jsonb_agg(x order by x.id) from sequences x where x.workspace_id = ${w}),
        'crm', (select jsonb_agg(x order by x.id) from crm_connections x where x.workspace_id = ${w}),
        'integrations', (select jsonb_agg(x order by x.id) from workspace_integrations x where x.workspace_id = ${w}),
        'idempotency', (select jsonb_agg(x order by x.key) from cops_idempotency_keys x where x.workspace_id = ${w})
      )::text as state`;
    return row!.state as string;
  }

  /** None of the victim's secrets in the answer, apart from ids the caller put in the request. */
  function expectNothingOf(victim: Tenant, req: Req, res: LightMyRequestResponse) {
    const sent = JSON.stringify(req);
    const answer = `${res.body}\n${JSON.stringify(res.headers)}`;
    for (const secret of victim.secrets) if (!sent.includes(secret)) expect(answer, `the answer contains ${secret}`).not.toContain(secret);
  }

  /** An answer with the request id removed and the named ids replaced by their role, so two answers can be compared. */
  function shape(res: LightMyRequestResponse, ids: Ids) {
    let text = "";
    if (res.body) {
      const { request_id: _requestId, ...body } = res.json() as Record<string, unknown>;
      text = JSON.stringify(body);
    }
    for (const [role, id] of Object.entries(ids)) text = text.split(String(id)).join(`<${role}>`);
    return { status: res.statusCode, text };
  }

  /**
   * The attack itself, then the same with ids that exist nowhere: identical answers, nothing of B's in either, and
   * nothing stored by either workspace changes.
   */
  async function attack(who: Person, c: Case, headers: Record<string, string> = {}) {
    const before = [await stored(A), await stored(B)];
    const real = c.send(A.ids, B.ids);
    const res = await send(who, real, headers);
    const nowhere = ghostIds();
    const madeUp = await send(who, c.send(A.ids, nowhere), headers);
    expectNothingOf(B, real, res);
    expect(shape(res, B.ids), "B's ids must be answered exactly like ids that do not exist").toEqual(shape(madeUp, nowhere));
    expect([await stored(A), await stored(B)], "nothing may change").toEqual(before);
    return res;
  }

  beforeAll(async () => {
    expect(hasDatabase, "the tenant isolation suite needs DATABASE_URL").toBe(true);
    ({ db, sql } = createDb(base.DATABASE_URL!));
    const collect = (message: unknown) =>
      (message as { fastify: FastifyInstance }).fastify.addHook("onRoute", (route) => {
        if (!route.url.startsWith(`${PREFIX}/workbooks-v2`)) return;
        for (const method of [route.method].flat()) {
          registered.add(`${method} ${route.url.slice(PREFIX.length)}`);
          if (isPublicRoute(route.url, method)) publicRoutes.push(`${method} ${route.url}`);
        }
      });
    subscribe("fastify.initialization", collect);
    try {
      app = await buildApp({ ...base, ...buildTestAuthEnv(), LOG_LEVEL: "fatal", OPENSEARCH_URL: undefined, EARLY_ACCESS_GATE_ENABLED: "true", RATE_LIMIT_MAX: 100_000, PLATFORM_ADMIN_EMAILS: [] });
      await app.ready();
    } finally {
      unsubscribe("fastify.initialization", collect);
    }
    // The global setup registers the test token verifier before each test; this hook runs before the first one.
    ensureTestAuthHarness();
    A = await tenant("A");
    B = await tenant("B");
    // Sign both in once, and let B use its idempotency keys, before anything is compared.
    expect((await send(A, { method: "GET", path: `/${A.ids.workbook}` })).statusCode).toBe(200);
    for (const req of [duplicateRequest(B.ids), rowRequest(B.ids), bulkRequest(B.ids), columnRequest(B.ids)]) {
      const res = await send(B, req);
      expect(res.statusCode, `${req.path} ${res.body}`).toBe(201);
    }
    // The copy B just made is B's too.
    const copies = await db.select({ id: workbooks.id }).from(workbooks).where(eq(workbooks.workspaceId, B.workspaceId));
    B.secrets.push(...copies.map((c) => c.id).filter((id) => !B.secrets.includes(id)));
  }, 120_000);

  afterAll(async () => {
    if (created.length) {
      // Deleting a workbook takes its columns, rows, cells, runs, imports, views and webhooks with it.
      await db.delete(workbooks).where(inArray(workbooks.workspaceId, created));
      for (const table of [lists, sequences, crmConnections, workspaceIntegrations]) await db.delete(table).where(inArray(table.workspaceId, created));
    }
    await app?.close();
    await sql?.end();
  });

  // ── The suite itself ────────────────────────────────────────────────────────

  it("has cases for every registered Workbooks V2 route, and none of them is public", () => {
    expect([...registered].sort()).toEqual(ROUTES);
    expect(publicRoutes).toEqual([]);
    // Every route that addresses a workbook is attacked directly.
    const attacked = new Set(NOT_FOUND.map((c) => c.route));
    expect(ROUTES.filter((route) => route.includes(":id") && !attacked.has(route))).toEqual([]);
  });

  it("plants B's data in workspace B, in every workbook table", async () => {
    const [counts] = await sql`
      select count(distinct w.id)::int as workbooks,
        (select count(*)::int from workbook_columns x join workbooks b on b.id = x.workbook_id where b.workspace_id = ${B.workspaceId} and x.id = ${B.ids.input}) as columns,
        (select count(*)::int from workbook_rows x join workbooks b on b.id = x.workbook_id where b.workspace_id = ${B.workspaceId} and x.id in (${B.ids.row1}, ${B.ids.row2}, ${B.ids.row3})) as rows,
        (select count(*)::int from workbook_cells x join workbooks b on b.id = x.workbook_id where b.workspace_id = ${B.workspaceId} and x.row_id = ${B.ids.row1}) as cells,
        (select count(*)::int from workbook_runs x join workbooks b on b.id = x.workbook_id where b.workspace_id = ${B.workspaceId} and x.id = ${B.ids.run}) as runs,
        (select count(*)::int from workbook_imports x join workbooks b on b.id = x.workbook_id where b.workspace_id = ${B.workspaceId} and x.id = ${B.ids.import}) as imports,
        (select count(*)::int from workbook_views x join workbooks b on b.id = x.workbook_id where b.workspace_id = ${B.workspaceId} and x.id = ${B.ids.view}) as views,
        (select count(*)::int from workbook_webhooks x join workbooks b on b.id = x.workbook_id where b.workspace_id = ${B.workspaceId} and x.id = ${B.ids.webhook}) as webhooks,
        (select count(*)::int from workspace_members m where m.workspace_id = ${B.workspaceId} and m.user_id = ${A.userId}) as a_in_b
      from workbooks w where w.workspace_id = ${B.workspaceId}`;
    expect(counts).toEqual({ workbooks: 3, columns: 1, rows: 3, cells: 2, runs: 1, imports: 1, views: 1, webhooks: 1, a_in_b: 0 });
    expect(await stored(B)).toContain(B.marker);
    expect(await stored(A)).not.toContain(B.marker);
  });

  // ── Attacks with A's session ────────────────────────────────────────────────

  describe("another workspace's workbooks, rows and columns are not found", () => {
    it.each(NOT_FOUND.map((c) => [...label(c), c] as const))("%s: %s", async (_route, _name, c) => {
      const res = await attack(A, c);
      expect(res.statusCode, res.body).toBe(404);
      if (c.send(A.ids, B.ids).method !== "HEAD") expect(res.json()).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });
  });

  describe("another workspace's ids inside a request on my own workbook are refused like made-up ids", () => {
    it.each(REFERENCES.map((c) => [...label(c), c] as const))("%s: %s", async (_route, _name, c) => {
      const res = await attack(A, c);
      expect(res.statusCode, res.body).toBe(c.status);
      expect(res.json()).toMatchObject({ ok: false, code: c.code });
    });
  });

  describe("naming a workspace in the request changes nothing", () => {
    it.each(workspaceClaims.map((c) => [...label(c), c] as const))("%s: %s", async (_route, _name, c) => {
      const res = await attack(A, c);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json()).toMatchObject({ code: "VALIDATION_FAILED" });
    });
  });

  describe("claiming their workspace in x-workspace-id is refused at sign-in", () => {
    it.each(ROUTES)("%s", async (route) => {
      const c = representative(route);
      const before = [await stored(A), await stored(B)];
      const req = c.send(A.ids, B.ids);
      const res = await send(A, req, { "x-workspace-id": B.workspaceId });
      const madeUp = await send(A, req, { "x-workspace-id": randomUUID() });
      expect(res.statusCode, res.body).toBe(403);
      if (req.method !== "HEAD") expect(res.json()).toMatchObject({ message: "Workspace access denied" });
      expectNothingOf(B, { ...req, headers: { ...req.headers, "x-workspace-id": B.workspaceId } }, res);
      expect(shape(res, B.ids)).toEqual(shape(madeUp, B.ids));
      expect([await stored(A), await stored(B)]).toEqual(before);
    });
  });

  describe("without a session nothing answers", () => {
    it.each(ROUTES)("%s", async (route) => {
      const before = await stored(B);
      const req = representative(route).send(A.ids, B.ids);
      for (const res of [await send(null, req), await send(null, req, { "x-workspace-id": B.workspaceId })]) {
        expect(res.statusCode, res.body).toBe(401);
        expectNothingOf(B, { ...req, headers: { "x-workspace-id": B.workspaceId } }, res);
      }
      expect(await stored(B)).toBe(before);
    });
  });

  describe("routes that name no resource answer for the caller's workspace only", () => {
    it.each(collectionCases.map((c) => [...label(c), c] as const))("%s: %s", async (_route, _name, c) => {
      const before = await stored(B);
      const req = c.send(A.ids, B.ids);
      const res = await send(A, req);
      expect(res.statusCode, res.body).toBeLessThan(300);
      expectNothingOf(B, req, res);
      expect(await stored(B)).toBe(before);
    });

    it("lists only the caller's workbooks, whatever the query string says", async () => {
      for (const path of ["", `?workspaceId=${B.workspaceId}`, "?page=1&pageSize=100", `?pageSize=100&workspace_id=${B.workspaceId}`]) {
        const req: Req = { method: "GET", path };
        const res = await send(A, req);
        expect(res.statusCode, res.body).toBe(200);
        const listed = (res.json().data as Array<{ id: string }>).map((w) => w.id);
        const mine = await db.select({ id: workbooks.id, deletedAt: workbooks.deletedAt }).from(workbooks).where(eq(workbooks.workspaceId, A.workspaceId));
        expect(listed.sort()).toEqual(mine.filter((w) => !w.deletedAt).map((w) => w.id).sort());
        expect(res.json().total).toBe(listed.length);
        expectNothingOf(B, req, res);
      }
    });

    it("does not replay another workspace's keyed create", async () => {
      const key = { "idempotency-key": `shared-${randomUUID()}` };
      const req: Req = { method: "POST", path: "", body: { name: "same name" } };
      const theirs = await send(B, req, key);
      expect(theirs.statusCode, theirs.body).toBe(201);
      B.secrets.push(theirs.json().data.id);
      const before = await stored(B);
      const mine = await send(A, req, key);
      expect(mine.statusCode, mine.body).toBe(201);
      expect(mine.json().data.id).not.toBe(theirs.json().data.id);
      expectNothingOf(B, req, mine);
      const [row] = await db.select().from(workbooks).where(eq(workbooks.id, mine.json().data.id));
      expect(row!.workspaceId).toBe(A.workspaceId);
      expect(await stored(B)).toBe(before);
    });

    // A query that forgot the workbook might return none of another's data yet still count, page or copy their rows,
    // so my own workbook must show exactly my columns and rows.
    it("never mixes their data into reads, searches or copies of my own workbook", async () => {
      const read = async (req: Req) => {
        const res = await send(A, req);
        expect(res.statusCode, res.body).toBeLessThan(300);
        expectNothingOf(B, req, res);
        return res.json();
      };
      const mine = `/${A.ids.workbook}`;
      const myRows = [A.ids.row1, A.ids.row2, A.ids.row3];
      const open = await read({ method: "GET", path: mine });
      expect(open.data.columns.map((c: { id: string }) => c.id)).toEqual(allColumns(A.ids));
      expect(open.data).toMatchObject({ rowCount: 3, columnCount: COLUMN_KEYS.length });

      // The filters here are also satisfied by anyone else's rows (no such cell, same source, same words).
      const queries = [
        {},
        { sort: [{ columnId: A.ids.input }] },
        { filters: [{ type: "value", columnId: A.ids.spare, op: "is_empty" }] },
        { filters: [{ type: "value", columnId: A.ids.input, op: "not_contains", value: "no such text" }] },
        { filters: [{ type: "state", states: ["found"] }] },
        { filters: [{ type: "source", sources: ["csv"] }] },
        { search: run },
      ];
      const requested: Req[] = [{ method: "GET", path: `${mine}/rows` }, ...queries.map((body): Req => ({ method: "POST", path: `${mine}/rows/query`, body }))];
      for (const req of requested) {
        const result = await read(req);
        expect(result.window, JSON.stringify(req.body)).toMatchObject({ matched: 3, total: 3, returned: 3 });
        expect(result.data.map((r: { id: number }) => r.id)).toEqual(myRows);
      }
      const log = await read({ method: "GET", path: `${mine}/activity?limit=100` });
      expect(log.data.map((e: { id: string }) => e.id)).toEqual([A.ids.activity]);

      const theirText = await send(A, { method: "POST", path: `${mine}/rows/query`, body: { search: B.marker } });
      expect(theirText.json().window).toMatchObject({ matched: 0, returned: 0, total: 3 });

      const copy = (await read({ method: "POST", path: `${mine}/duplicate`, body: { includeRows: true } })).data as { id: string };
      const copied = await read({ method: "GET", path: `/${copy.id}` });
      expect(copied.data).toMatchObject({ rowCount: 3, columnCount: COLUMN_KEYS.length });
      expect(copied.data.columns.every((c: { name: string }) => c.name.startsWith(A.marker))).toBe(true);
      expect((await read({ method: "GET", path: `/${copy.id}/rows` })).window).toMatchObject({ matched: 3, total: 3, returned: 3 });
      const [stored] = await sql`select count(*)::int as n from workbook_rows where workbook_id = ${copy.id}`;
      expect(stored!.n).toBe(3);
    });
  });

  describe("belonging to both workspaces does not widen a session", () => {
    it("acting in A, a member of both gets the same refusals for B's resources", async () => {
      const userId = randomUUID();
      const email = `both-${userId}@example.com`;
      await db.insert(users).values({ id: userId, email, fullName: "Both", status: "active" });
      for (const workspaceId of [A.workspaceId, B.workspaceId]) {
        await db.insert(workspaceMembers).values({ workspaceId, userId, role: "owner" });
        await grantSystemMemberRole(db, workspaceId, userId, "owner");
      }
      const both: Person = { userId, email, workspaceId: A.workspaceId };
      // The membership of B is real: acting in B, the same person can open B's workbook.
      expect((await send({ ...both, workspaceId: B.workspaceId }, { method: "GET", path: `/${B.ids.workbook}` })).statusCode).toBe(200);
      const cases = [...NOT_FOUND.map((c) => ({ c, status: 404 })), ...REFERENCES.map((c) => ({ c, status: c.status }))];
      for (const { c, status } of cases) {
        const res = await attack(both, c);
        expect(res.statusCode, `${c.route}: ${c.name} ${res.body}`).toBe(status);
      }
    }, 120_000);
  });

  // ── Proof the cases are real requests ───────────────────────────────────────

  describe("the same requests work for an owner on their own data", () => {
    it.each([...NOT_FOUND, ...REFERENCES.map((c) => ({ ...c, own: undefined }))].map((c) => [...label(c), c] as const))("%s: %s", async (_route, _name, c) => {
      const owner = await tenant("V");
      const res = await send(owner, c.send(owner.ids, owner.ids));
      if (c.own) expect(res.statusCode, res.body).toBe(c.own);
      else expect([200, 201], `${res.statusCode} ${res.body}`).toContain(res.statusCode);
    });
  });
});
