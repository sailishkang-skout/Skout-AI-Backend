import { count, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { loadWorkspaceAccess } from "@skout/auth";
import type { Env } from "../config/env.js";
import { earlyAccessGateEnabled } from "../config/early-access.js";
import { WorkbookV2Error, getWorkspaceRowLimit, lockLiveWorkbook } from "./workbook-v2.service.js";
import { normalizeInputValue, type CellScalar, type InputDataType } from "./workbook-cell-values.js";
import { dedupeValue, duplicateReason } from "./workbook-import-plan.js";
import { KeyIndex } from "./workbook-import-keys.js";
import { addRows, type NewRow } from "./workbook-rows.service.js";
import { auditWebhook, canHoldKey, inputColumns, tokenMatches, type WebhookDedupe } from "./workbook-webhook.service.js";
import type { ActivityActor } from "./workbook-activity-log.js";

/**
 * Receiving rows on a workbook's webhook (WB2-026). The token decides the workbook: nothing in a request can name a
 * workbook or workspace. Rows are added through the Rows API's own service, so receiving them runs nothing.
 *
 * Good rows are added and the rest are reported, as a CSV import does. What is added in one request is added in one
 * transaction: a failure part way adds nothing, so sending the request again is safe.
 */
const { workbooks, workbookRows, workbookWebhooks } = schema;

export const WEBHOOK_MAX_ROWS = 1_000;
export const WEBHOOK_BODY_LIMIT = 5 * 1024 * 1024;
export const WEBHOOK_REQUESTS_PER_MINUTE = 60;
const WINDOW_MS = 60_000;
const MAX_FIELDS_PER_ROW = 200;
const MAX_REPORTED = 100;
const MAX_IGNORED_NAMES = 50;
const NAME_SHOWN = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Compared against when there is no such webhook, so that answering takes the same work either way. */
const NO_HASH = "0".repeat(64);

export interface InboundWebhook {
  webhookId: string;
  workbookId: string;
  workspaceId: string;
  tokenHash: string;
}

const unauthorized = () => new WorkbookV2Error("INVALID_WEBHOOK_TOKEN", 401, "Missing or invalid webhook token");

/** The token from `Authorization: Bearer …`. */
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer[ ]+([A-Za-z0-9_-]{10,200})[ ]*$/i.exec(header ?? "");
  return match ? match[1]! : null;
}

/**
 * Which webhook a request is for. A wrong, old or missing token, a disabled webhook, a deleted workbook and an unknown
 * address are all answered the same way.
 */
export async function authenticateWebhook(db: Db, webhookId: string, authorization: string | undefined): Promise<InboundWebhook> {
  const token = bearerToken(authorization);
  if (!token) throw unauthorized();
  const [found] = UUID.test(webhookId)
    ? await db
        .select({
          tokenHash: workbookWebhooks.tokenHash,
          enabled: workbookWebhooks.enabled,
          workbookId: workbooks.id,
          workspaceId: workbooks.workspaceId,
          deletedAt: workbooks.deletedAt,
        })
        .from(workbookWebhooks)
        .innerJoin(workbooks, eq(workbooks.id, workbookWebhooks.workbookId))
        .where(eq(workbookWebhooks.id, webhookId))
        .limit(1)
    : [];
  const matches = tokenMatches(token, found?.tokenHash ?? NO_HASH);
  if (!found || !matches || !found.enabled || found.deletedAt) throw unauthorized();
  return { webhookId: webhookId.toLowerCase(), workbookId: found.workbookId, workspaceId: found.workspaceId, tokenHash: found.tokenHash };
}

/** The workspace must still have Skout and Workbooks V2, as for anyone using the workbook. */
export async function assertWorkspaceMayReceive(db: Db, config: Env, workspaceId: string): Promise<void> {
  const access = await loadWorkspaceAccess(db, workspaceId);
  if ((access.status !== "active" && earlyAccessGateEnabled(config)) || !access.features.workbooks_v2) {
    throw new WorkbookV2Error("feature_disabled", 403, "Workbooks V2 isn't available to this workspace.");
  }
}

/**
 * Counts a request against the webhook's last minute. The count lives in the database and uses its clock, so the limit
 * holds however many API instances receive requests. A refused request is not counted.
 */
export async function admitRequest(db: Db, hook: InboundWebhook, requestId: string): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const [row] = (await tx.execute(sql`
      SELECT recent_requests AS recent, (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now,
             rate_limit_noted_at IS NULL OR rate_limit_noted_at < clock_timestamp() - interval '1 minute' AS unnoted
      FROM workbook_webhooks WHERE id = ${hook.webhookId}::uuid FOR UPDATE`)) as unknown as Array<{ recent: number[]; now: string | number; unnoted: boolean }>;
    if (!row) throw unauthorized();
    // The clock is read after the row is locked, so requests are counted in the order they got it.
    const now = Number(row.now);
    const recent = row.recent.filter((at) => at > now - WINDOW_MS);
    if (recent.length >= WEBHOOK_REQUESTS_PER_MINUTE) {
      if (row.unnoted) {
        await tx.update(workbookWebhooks).set({ rateLimitNotedAt: sql`clock_timestamp()` }).where(eq(workbookWebhooks.id, hook.webhookId));
        await auditWebhook(tx, { workspaceId: hook.workspaceId, userId: null, requestId }, hook.workbookId, "rate_limited", { webhookId: hook.webhookId, limit: WEBHOOK_REQUESTS_PER_MINUTE });
      }
      return { allowed: false as const, retryAfterSeconds: Math.max(1, Math.ceil((Math.min(...recent) + WINDOW_MS - now) / 1000)) };
    }
    await tx
      .update(workbookWebhooks)
      .set({ recentRequests: [...recent, now], lastUsedAt: sql`clock_timestamp()` })
      .where(eq(workbookWebhooks.id, hook.webhookId));
    return { allowed: true as const };
  });
}

/** The rows of a request body: a JSON array of up to 1,000 entries. */
export function parseRows(body: unknown): unknown[] {
  if (typeof body !== "string" || !body.trim()) throw new WorkbookV2Error("INVALID_JSON", 400, "Send a JSON array of row objects.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.replace(/^\uFEFF/, ""));
  } catch {
    // The parser's own words quote the body, which must not reach a log.
    throw new WorkbookV2Error("INVALID_JSON", 400, "The body isn't valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new WorkbookV2Error("INVALID_PAYLOAD", 422, "The body must be a JSON array of row objects.");
  if (!parsed.length) throw new WorkbookV2Error("INVALID_PAYLOAD", 422, "The array holds no rows.");
  if (parsed.length > WEBHOOK_MAX_ROWS) {
    throw new WorkbookV2Error("TOO_MANY_ROWS", 413, `A request can carry at most ${WEBHOOK_MAX_ROWS.toLocaleString("en-US")} rows.`, { limit: WEBHOOK_MAX_ROWS, rows: parsed.length });
  }
  return parsed;
}

type Column = { id: string; name: string; dataType: InputDataType };
type Prepared = { kind: "ready"; cells: Record<string, CellScalar> } | { kind: "skipped" | "rejected"; code: string; reason: string };

const TYPE_LABEL: Record<InputDataType, string> = {
  text: "text",
  number: "number",
  email: "email address",
  url: "web address",
  linkedin_url: "LinkedIn URL",
  domain: "domain",
  phone: "phone number",
  date: "date (YYYY-MM-DD)",
  checkbox: "true or false value",
};
const fieldKey = (name: string) => name.trim().toLowerCase();
const shown = (name: string) => (name.length > NAME_SHOWN ? `${name.slice(0, NAME_SHOWN)}…` : name);

/**
 * Matches one row object's fields to input columns by name, ignoring letter case. Fields that name no input column are
 * left out and noted. A row is added only when every value it has for a column fits that column. Reasons name fields and
 * columns, never values.
 */
export function prepareRow(row: unknown, columns: Map<string, Column[]>, ignored: Set<string>): Prepared {
  const reject = (code: string, reason: string): Prepared => ({ kind: "rejected", code, reason });
  if (!row || typeof row !== "object" || Array.isArray(row)) return reject("NOT_AN_OBJECT", "A row must be a JSON object");
  const fields = Object.entries(row);
  if (fields.length > MAX_FIELDS_PER_ROW) return reject("TOO_MANY_FIELDS", `A row can have at most ${MAX_FIELDS_PER_ROW} fields`);
  const cells: Record<string, CellScalar> = {};
  const seen = new Set<string>();
  const problems: string[] = [];
  let unmatched = 0;
  for (const [name, raw] of fields) {
    const matches = columns.get(fieldKey(name));
    if (!matches) {
      unmatched += 1;
      if (ignored.size < MAX_IGNORED_NAMES) ignored.add(shown(name));
      continue;
    }
    if (matches.length > 1) return reject("AMBIGUOUS_FIELD", `More than one column is named “${shown(name)}”`);
    const column = matches[0]!;
    if (seen.has(column.id)) return reject("REPEATED_FIELD", `Two fields name the column “${column.name}”`);
    seen.add(column.id);
    const cell = normalizeInputValue(raw, column.dataType);
    if (cell.kind === "rejected") problems.push(`${column.name}: ${cell.reason}`);
    else if (cell.kind === "value") {
      if (cell.errorCode) problems.push(`${column.name}: not a valid ${TYPE_LABEL[column.dataType]}`);
      else cells[column.id] = cell.value;
    }
  }
  if (problems.length) return reject("INVALID_VALUE", problems.join("; "));
  // Something was sent and none of it has anywhere to go, such as misspelt names: not an empty row.
  if (unmatched && !seen.size) return reject("NO_MATCHING_FIELDS", "No field matches an input column");
  if (!Object.keys(cells).length) return { kind: "skipped", code: "EMPTY_ROW", reason: "No value for any input column" };
  return { kind: "ready", cells };
}

export interface WebhookResult {
  received: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  rejected: number;
  rowCount: number;
  /** Field names that match no input column. */
  ignoredFields: string[];
  /** Why rows were not added, by their place in the array from 1: the first hundred. */
  errors: Array<{ row: number; code: string; message: string }>;
}

/**
 * Adds a request's rows to the webhook's workbook. `settle` runs last inside the same transaction, so what it records
 * about the request is saved exactly when the rows are.
 */
export async function receiveRows(
  db: Db,
  hook: InboundWebhook,
  rows: unknown[],
  requestId: string,
  settle?: (tx: Db, result: WebhookResult) => Promise<void>
): Promise<WebhookResult> {
  const actor: ActivityActor = { workspaceId: hook.workspaceId, userId: null, requestId };
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await lockLiveWorkbook(tx, hook.workspaceId, hook.workbookId).catch((error) => {
      if (error instanceof WorkbookV2Error && error.code === "NOT_FOUND") throw unauthorized();
      throw error;
    });
    // Under the lock every change to the webhook also takes: a token replaced or a webhook turned off while this
    // request was on its way lets nothing in.
    const [current] = await tx.select().from(workbookWebhooks).where(eq(workbookWebhooks.id, hook.webhookId)).limit(1);
    if (!current || !current.enabled || current.tokenHash !== hook.tokenHash) throw unauthorized();

    const found = await inputColumns(tx, hook.workbookId);
    const byName = new Map<string, Column[]>();
    for (const column of found) byName.set(fieldKey(column.name), [...(byName.get(fieldKey(column.name)) ?? []), column]);

    const dedupe = current.dedupe as WebhookDedupe;
    let keys: KeyIndex | null = null;
    if (dedupe.key !== "none") {
      const column = found.find((c) => c.id === dedupe.columnId);
      if (!column || !canHoldKey(dedupe.key, column.dataType)) {
        throw new WorkbookV2Error("DEDUPE_COLUMN_INVALID", 422, "The column this webhook checks for duplicates was deleted or changed. Update the webhook's settings in Skout.");
      }
      keys = new KeyIndex(hook.workbookId, column.id, dedupe.key);
      await keys.refresh(tx);
    }

    const limit = await getWorkspaceRowLimit(tx, hook.workspaceId);
    const [counted] = await tx.select({ n: count() }).from(workbookRows).where(eq(workbookRows.workbookId, hook.workbookId));
    const existing = counted?.n ?? 0;

    const result: WebhookResult = { received: rows.length, inserted: 0, duplicates: 0, skipped: 0, rejected: 0, rowCount: existing, ignoredFields: [], errors: [] };
    const note = (row: number, code: string, message: string) => {
      if (result.errors.length < MAX_REPORTED) result.errors.push({ row, code, message });
    };
    const ignored = new Set<string>();
    const source = { type: "webhook", webhookId: hook.webhookId, receivedAt: new Date().toISOString() };
    const accepted: NewRow[] = [];
    rows.forEach((raw, index) => {
      const row = index + 1;
      const prepared = prepareRow(raw, byName, ignored);
      if (prepared.kind !== "ready") {
        result[prepared.kind] += 1;
        return note(row, prepared.code, prepared.reason);
      }
      let key: string | null = null;
      if (keys && dedupe.key !== "none") {
        const value = prepared.cells[dedupe.columnId];
        // A row without the key matches nothing, so it is added.
        if (value !== undefined && String(value).trim()) {
          key = dedupeValue(dedupe.key, String(value));
          if (key === null) {
            result.rejected += 1;
            return note(row, "INVALID_VALUE", "The duplicate key can't be read from this row's value");
          }
          if (keys.has(key)) {
            result.duplicates += 1;
            return note(row, "DUPLICATE", duplicateReason(dedupe.key));
          }
        }
      }
      if (existing + accepted.length >= limit) {
        result.rejected += 1;
        return note(row, "ROW_LIMIT_EXCEEDED", `The workbook reached its limit of ${limit.toLocaleString("en-US")} rows`);
      }
      if (key !== null) keys!.add(key);
      accepted.push({ cells: prepared.cells, source });
    });
    result.ignoredFields = [...ignored];

    if (accepted.length) {
      const added = await addRows(tx, { workspaceId: hook.workspaceId, userId: null, requestId }, hook.workbookId, accepted, {
        duplicates: result.duplicates,
        skipped: result.skipped,
        rejected: result.rejected,
      });
      result.inserted = added.added;
      result.rowCount = added.rowCount;
    }
    const counts = { received: result.received, inserted: result.inserted, duplicates: result.duplicates, skipped: result.skipped, rejected: result.rejected };
    await tx
      .update(workbookWebhooks)
      .set({ lastResult: { at: source.receivedAt, ...counts } })
      .where(eq(workbookWebhooks.id, hook.webhookId));
    await auditWebhook(tx, actor, hook.workbookId, "request_accepted", { webhookId: hook.webhookId, ...counts });
    await settle?.(tx, result);
    return result;
  });
}

/** Records a request that was authenticated and then refused as a whole. */
export async function noteRefusal(db: Db, hook: InboundWebhook, requestId: string, code: string): Promise<void> {
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await tx
      .update(workbookWebhooks)
      .set({ lastResult: { at: new Date().toISOString(), refused: code } })
      .where(eq(workbookWebhooks.id, hook.webhookId));
    await auditWebhook(tx, { workspaceId: hook.workspaceId, userId: null, requestId }, hook.workbookId, "request_rejected", { webhookId: hook.webhookId, code });
  });
}
