import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { COPS_CONFIG_DEFAULTS, COPS_CONFIG_KEY, COPS_CONFIG_SCHEMAS, type CopsConfigKind } from "@skout/shared";
import { writeCopsAudit } from "./cops-platform.service.js";

/**
 * COPS-07 admin configuration store. Every save is a new immutable version, written with its audit
 * row in one transaction. A workspace that has saved nothing reads the built-in default as version 0.
 */
const { copsConfigVersions } = schema;

export interface AdminConfigContext {
  workspaceId: string;
  userId: string;
  requestId: string;
}

export class AdminConfigError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "VALIDATION_FAILED" | "BUSINESS_STATE_CONFLICT",
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
  get status(): number {
    return { NOT_FOUND: 404, VALIDATION_FAILED: 422, BUSINESS_STATE_CONFLICT: 409 }[this.code];
  }
}

type Row = typeof copsConfigVersions.$inferSelect;

function dto(row: Row) {
  return {
    kind: row.kind as CopsConfigKind,
    key: row.key,
    version: row.version,
    value: row.value,
    reason: row.reason as string | null,
    restored_from_version: row.restoredFromVersion,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString() as string | null,
    is_system_default: false,
  };
}
export type ConfigVersionDto = ReturnType<typeof dto>;

function defaultDto(kind: CopsConfigKind, key: string, value: unknown): ConfigVersionDto {
  return { kind, key, version: 0, value: value as Record<string, unknown>, reason: null, restored_from_version: null, created_by: null, created_at: null, is_system_default: true };
}

function validate(kind: CopsConfigKind, key: string, value: unknown): Record<string, unknown> {
  if (!COPS_CONFIG_KEY.test(key)) {
    throw new AdminConfigError("VALIDATION_FAILED", "The key may use lowercase letters, digits, - and _", { fields: [{ path: "key", message: "Invalid key" }] });
  }
  const parsed = COPS_CONFIG_SCHEMAS[kind].safeParse(value);
  if (!parsed.success) {
    throw new AdminConfigError("VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "Invalid value", {
      fields: parsed.error.issues.map((i) => ({ path: ["value", ...i.path].join("."), code: i.code, message: i.message })),
    });
  }
  return parsed.data as Record<string, unknown>;
}

/** Latest version of every key of a kind; built-in defaults fill keys the workspace has not saved. */
export async function listConfig(db: Db, workspaceId: string, kind: CopsConfigKind): Promise<ConfigVersionDto[]> {
  const rows = await db
    .selectDistinctOn([copsConfigVersions.key])
    .from(copsConfigVersions)
    .where(and(eq(copsConfigVersions.workspaceId, workspaceId), eq(copsConfigVersions.kind, kind)))
    .orderBy(copsConfigVersions.key, desc(copsConfigVersions.version));
  const saved = rows.map(dto);
  const defaults = Object.entries(COPS_CONFIG_DEFAULTS[kind] ?? {})
    .filter(([key]) => !saved.some((s) => s.key === key))
    .map(([key, value]) => defaultDto(kind, key, value));
  return [...saved, ...defaults].sort((a, b) => a.key.localeCompare(b.key));
}

/** The value in force for one key: the latest saved version, else the built-in default, else null. */
export async function getConfig(db: Db, workspaceId: string, kind: CopsConfigKind, key: string): Promise<ConfigVersionDto | null> {
  const [row] = await db
    .select()
    .from(copsConfigVersions)
    .where(and(eq(copsConfigVersions.workspaceId, workspaceId), eq(copsConfigVersions.kind, kind), eq(copsConfigVersions.key, key)))
    .orderBy(desc(copsConfigVersions.version))
    .limit(1);
  if (row) return dto(row);
  const fallback = COPS_CONFIG_DEFAULTS[kind]?.[key];
  return fallback === undefined ? null : defaultDto(kind, key, fallback);
}

export async function listConfigVersions(db: Db, workspaceId: string, kind: CopsConfigKind, key: string): Promise<ConfigVersionDto[]> {
  const rows = await db
    .select()
    .from(copsConfigVersions)
    .where(and(eq(copsConfigVersions.workspaceId, workspaceId), eq(copsConfigVersions.kind, kind), eq(copsConfigVersions.key, key)))
    .orderBy(desc(copsConfigVersions.version));
  return rows.map(dto);
}

async function insertVersion(
  db: Db,
  ctx: AdminConfigContext,
  kind: CopsConfigKind,
  key: string,
  value: Record<string, unknown>,
  opts: { reason: string; expectedVersion?: number; restoredFrom?: number }
): Promise<ConfigVersionDto> {
  return db.transaction(async (tx) => {
    // One writer per key at a time, so two saves cannot both take the same next version.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${ctx.workspaceId}:${kind}:${key}`}))`);
    const [latest] = await tx
      .select()
      .from(copsConfigVersions)
      .where(and(eq(copsConfigVersions.workspaceId, ctx.workspaceId), eq(copsConfigVersions.kind, kind), eq(copsConfigVersions.key, key)))
      .orderBy(desc(copsConfigVersions.version))
      .limit(1);
    const current = latest?.version ?? 0;
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== current) {
      throw new AdminConfigError("BUSINESS_STATE_CONFLICT", "This configuration was changed by someone else; reload and try again", {
        expected_version: opts.expectedVersion,
        current_version: current,
      });
    }
    const [row] = await tx
      .insert(copsConfigVersions)
      .values({
        workspaceId: ctx.workspaceId,
        kind,
        key,
        version: current + 1,
        value,
        reason: opts.reason,
        restoredFromVersion: opts.restoredFrom ?? null,
        createdBy: ctx.userId,
      })
      .returning();
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "cops_config",
      entityId: row!.id,
      action: opts.restoredFrom ? "admin_config.rolled_back" : "admin_config.saved",
      before: latest ? { version: latest.version, value: latest.value } : null,
      after: { kind, key, version: row!.version, value },
      reason: opts.reason,
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    return dto(row!);
  });
}

/** Saves a value as the next version. Never edits a version in place. */
export async function saveConfig(
  db: Db,
  ctx: AdminConfigContext,
  kind: CopsConfigKind,
  key: string,
  input: { value: unknown; reason: string; expected_version?: number }
): Promise<ConfigVersionDto> {
  const value = validate(kind, key, input.value);
  return insertVersion(db, ctx, kind, key, value, { reason: input.reason, expectedVersion: input.expected_version });
}

/** Restores an earlier version by writing its value as a new version; history is kept. */
export async function rollbackConfig(
  db: Db,
  ctx: AdminConfigContext,
  kind: CopsConfigKind,
  key: string,
  input: { version: number; reason: string }
): Promise<ConfigVersionDto> {
  const [target] = await db
    .select()
    .from(copsConfigVersions)
    .where(
      and(
        eq(copsConfigVersions.workspaceId, ctx.workspaceId),
        eq(copsConfigVersions.kind, kind),
        eq(copsConfigVersions.key, key),
        eq(copsConfigVersions.version, input.version)
      )
    )
    .limit(1);
  if (!target) throw new AdminConfigError("NOT_FOUND", "That version does not exist");
  // A schema change since that version was saved must not bring back a value that no longer validates.
  const value = validate(kind, key, target.value);
  return insertVersion(db, ctx, kind, key, value, { reason: input.reason, restoredFrom: target.version });
}
