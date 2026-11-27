import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import type { Env } from "../config/env.js";
import { WorkbookV2Error, findLiveWorkbook, lockLiveWorkbook, type WorkbookActor } from "./workbook-v2.service.js";
import { inputDataType } from "./workbook-cell-values.js";
import { DEDUPE_KEYS, KEY_COLUMN_TYPES, type MatchKey } from "./workbook-import-plan.js";
import { writeCopsAudit } from "./cops-platform.service.js";
import { WORKBOOK_ENTITY, type ActivityActor } from "./workbook-activity-log.js";

/**
 * A workbook's inbound webhook (WB2-026, PRD ROW-7 and SEC-5): its address, its secret token and its settings. The
 * address only says which webhook; the token, sent in a header, is what lets rows in. Only a hash of the token is
 * kept, so it can be shown when it is made and never again.
 */
const { workbookColumns, workbookWebhooks } = schema;

export const TOKEN_PREFIX = "skwh_";

/** A new token: 256 bits of randomness. */
export const newWebhookToken = () => `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
const digest = (token: string) => createHash("sha256").update(token).digest();
export const tokenHashOf = (token: string) => digest(token).toString("hex");

/** Compared in constant time. */
export function tokenMatches(token: string, storedHash: string): boolean {
  const stored = Buffer.from(storedHash, "hex");
  const given = digest(token);
  return stored.length === given.length && timingSafeEqual(given, stored);
}

export function webhookUrl(config: Env, webhookId: string): string {
  const base = (config.API_PUBLIC_URL ?? `http://localhost:${config.PORT}`).replace(/\/+$/, "");
  return `${base}/api/v1/webhooks/workbooks/${webhookId}`;
}

export type WebhookDedupe = { key: "none" } | { key: MatchKey; columnId: string };

export interface WebhookDto {
  id: string;
  url: string;
  enabled: boolean;
  dedupe: WebhookDedupe;
  createdAt: string;
  tokenCreatedAt: string;
  lastUsedAt: string | null;
  /** What the last request that reached the rows did. */
  lastResult: Record<string, unknown> | null;
}

type Record_ = typeof workbookWebhooks.$inferSelect;

function toDto(config: Env, record: Record_): WebhookDto {
  return {
    id: record.id,
    url: webhookUrl(config, record.id),
    enabled: record.enabled,
    dedupe: record.dedupe as WebhookDedupe,
    createdAt: record.createdAt.toISOString(),
    tokenCreatedAt: record.tokenCreatedAt.toISOString(),
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
    lastResult: record.lastResult,
  };
}

export type WebhookAuditAction = "created" | "token_regenerated" | "enabled" | "disabled" | "settings_changed" | "request_accepted" | "request_rejected" | "rate_limited";

/** Webhook changes and requests in the audit log (PRD SEC-11). Never a token, its hash or anything that was sent. */
export async function auditWebhook(db: Db, actor: ActivityActor, workbookId: string, action: WebhookAuditAction, after: Record<string, unknown>): Promise<void> {
  await writeCopsAudit(db, {
    tenantId: actor.workspaceId,
    actor: actor.userId ? { type: "user", id: actor.userId } : { type: "integration", id: null },
    entityType: WORKBOOK_ENTITY,
    entityId: workbookId,
    action: `workbook.webhook.${action}`,
    after,
    correlationId: actor.requestId || randomUUID(),
    sourceChannel: "api",
  });
}

async function find(db: Db, workbookId: string) {
  const [record] = await db.select().from(workbookWebhooks).where(eq(workbookWebhooks.workbookId, workbookId)).limit(1);
  return record ?? null;
}

const missing = () => new WorkbookV2Error("NOT_FOUND", 404, "This workbook has no webhook yet");

export async function getWebhook(db: Db, config: Env, workspaceId: string, workbookId: string): Promise<WebhookDto | null> {
  await findLiveWorkbook(db, workspaceId, workbookId);
  const record = await find(db, workbookId);
  return record ? toDto(config, record) : null;
}

/** Runs a change under the workbook's lock, which a request being received also takes. */
const underLock = <T>(db: Db, actor: WorkbookActor, workbookId: string, work: (tx: Db) => Promise<T>) =>
  db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await lockLiveWorkbook(tx, actor.workspaceId, workbookId);
    return work(tx);
  });

export function createWebhook(db: Db, config: Env, actor: WorkbookActor, workbookId: string): Promise<{ webhook: WebhookDto; token: string }> {
  return underLock(db, actor, workbookId, async (tx) => {
    const token = newWebhookToken();
    const [record] = await tx.insert(workbookWebhooks).values({ workbookId, tokenHash: tokenHashOf(token) }).onConflictDoNothing({ target: workbookWebhooks.workbookId }).returning();
    if (!record) throw new WorkbookV2Error("WEBHOOK_EXISTS", 409, "This workbook already has a webhook. Regenerate its token to get a new one.");
    await auditWebhook(tx, actor, workbookId, "created", { webhookId: record.id });
    return { webhook: toDto(config, record), token };
  });
}

/** A new token in place of the old one, which stops working at once. Whether the webhook is enabled doesn't change. */
export function regenerateWebhookToken(db: Db, config: Env, actor: WorkbookActor, workbookId: string): Promise<{ webhook: WebhookDto; token: string }> {
  return underLock(db, actor, workbookId, async (tx) => {
    const token = newWebhookToken();
    const [record] = await tx
      .update(workbookWebhooks)
      .set({ tokenHash: tokenHashOf(token), tokenCreatedAt: new Date(), updatedAt: new Date() })
      .where(eq(workbookWebhooks.workbookId, workbookId))
      .returning();
    if (!record) throw missing();
    await auditWebhook(tx, actor, workbookId, "token_regenerated", { webhookId: record.id });
    return { webhook: toDto(config, record), token };
  });
}

export interface WebhookChange {
  enabled?: boolean;
  dedupe?: { key: (typeof DEDUPE_KEYS)[number]; columnId?: string };
}

const invalidDedupe = (message: string) => new WorkbookV2Error("DEDUPE_COLUMN_INVALID", 422, message);

/** The columns of a workbook that values can be sent to, in order. */
export async function inputColumns(db: Db, workbookId: string) {
  const found = await db
    .select({ id: workbookColumns.id, name: workbookColumns.name, type: workbookColumns.type, config: workbookColumns.config })
    .from(workbookColumns)
    .where(eq(workbookColumns.workbookId, workbookId))
    .orderBy(asc(workbookColumns.position), asc(workbookColumns.id));
  return found.filter((c) => c.type === "input").map((c) => ({ id: c.id, name: c.name, dataType: inputDataType(c.config) }));
}

/** Whether a column can hold a duplicate key. */
export const canHoldKey = (key: MatchKey, dataType: ReturnType<typeof inputDataType>) => KEY_COLUMN_TYPES[key].includes(dataType);

async function checkDedupe(db: Db, workbookId: string, dedupe: NonNullable<WebhookChange["dedupe"]>): Promise<WebhookDedupe> {
  if (dedupe.key === "none") {
    if (dedupe.columnId !== undefined) throw invalidDedupe("No column is needed without a duplicate check.");
    return { key: "none" };
  }
  const column = (await inputColumns(db, workbookId)).find((c) => c.id === dedupe.columnId?.toLowerCase());
  if (!column) throw invalidDedupe("Choose the input column that holds the duplicate key.");
  if (!canHoldKey(dedupe.key, column.dataType)) throw invalidDedupe(`The column “${column.name}” can't hold that duplicate key.`);
  return { key: dedupe.key, columnId: column.id };
}

/** Turns the webhook on or off, or changes how duplicates are found. What is already so is not recorded again. */
export function updateWebhook(db: Db, config: Env, actor: WorkbookActor, workbookId: string, change: WebhookChange): Promise<WebhookDto> {
  return underLock(db, actor, workbookId, async (tx) => {
    const before = await find(tx, workbookId);
    if (!before) throw missing();
    const dedupe = change.dedupe ? await checkDedupe(tx, workbookId, change.dedupe) : null;
    const settingsChanged = dedupe !== null && JSON.stringify([dedupe.key, "columnId" in dedupe ? dedupe.columnId : null]) !== JSON.stringify([before.dedupe.key, before.dedupe.columnId ?? null]);
    const turned = change.enabled !== undefined && change.enabled !== before.enabled;
    if (!settingsChanged && !turned) return toDto(config, before);
    const [record] = await tx
      .update(workbookWebhooks)
      .set({ ...(turned ? { enabled: change.enabled } : {}), ...(settingsChanged ? { dedupe: dedupe! } : {}), updatedAt: new Date() })
      .where(eq(workbookWebhooks.id, before.id))
      .returning();
    if (turned) await auditWebhook(tx, actor, workbookId, change.enabled ? "enabled" : "disabled", { webhookId: before.id });
    if (settingsChanged) await auditWebhook(tx, actor, workbookId, "settings_changed", { webhookId: before.id, dedupe: dedupe!.key });
    return toDto(config, record!);
  });
}

