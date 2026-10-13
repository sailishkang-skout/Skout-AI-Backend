import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { RETENTION_CATEGORIES, type RetentionCategory } from "@skout/shared";
import { getConfig } from "./cops-admin-config.service.js";
import { writeCopsAudit } from "./cops-platform.service.js";

/**
 * COPS-07 privacy and retention (Bible p.86, Appendix F).
 *
 * Data inventory: every table is classified into one retention category from its name, and tagged
 * from its columns (personal data, tenant scoped). The inventory reads the live schema, so a new
 * table shows up without a code change.
 *
 * Retention: the workspace's `retention_policy` config gives days per category (null keeps
 * everything, which is the default). A run deletes only from RETENTION_TARGETS, the tables where
 * removing old rows is safe. Other data leaves through the DSAR delete path, not here. A run is a
 * dry run first: `apply` needs a dry run of the same policy version from the last 24 hours.
 */
const { copsRetentionRuns } = schema;

export interface RetentionContext {
  workspaceId: string;
  userId: string;
  requestId: string;
}

export class RetentionError extends Error {
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

interface RetentionTarget {
  category: RetentionCategory;
  table: string;
  /** Column holding the tenant; `tenant_id` on the outbox, `workspace_id` elsewhere. */
  tenantColumn: string;
  ageColumn: string;
  /** Extra SQL condition; rows that are still needed are never candidates. */
  where?: string;
}

/** Identifiers here are constants in this file, never user input. */
export const RETENTION_TARGETS: readonly RetentionTarget[] = [
  { category: "audit_logs", table: "audit_logs", tenantColumn: "workspace_id", ageColumn: "created_at" },
  { category: "communications", table: "cops_onboarding_email_sends", tenantColumn: "workspace_id", ageColumn: "created_at" },
  { category: "diagnostics", table: "cops_idempotency_keys", tenantColumn: "workspace_id", ageColumn: "created_at", where: "state <> 'pending'" },
  // Published events only: an unpublished or dead-lettered event is still operational state.
  { category: "diagnostics", table: "cops_outbox", tenantColumn: "tenant_id", ageColumn: "created_at", where: "published_at is not null" },
];

const DAY_MS = 86_400_000;
export const DRY_RUN_VALID_MS = 24 * 60 * 60 * 1000;

export function classifyTable(table: string): RetentionCategory {
  if (/^(audit_logs|auth_events)$/.test(table)) return "audit_logs";
  if (/(tombstone|deleted_|^dsar)/.test(table)) return "tombstones";
  if (/(attachment|document|_files?$|upload)/.test(table)) return "attachments";
  if (/(^ai_|prompt|model_version|draft|recommendation|next_best)/.test(table)) return "ai_traces";
  if (/(outbox|idempotency|processed_events|_runs$|_jobs$|^async_jobs$|webhook_deliver|tracking_events|sync_state|provider_events)/.test(table)) return "diagnostics";
  if (/(email|inbox|message|comment|notification|^activities$|^meetings$|meeting_|call)/.test(table)) return "communications";
  return "core_records";
}

export interface InventoryRow {
  table: string;
  category: RetentionCategory;
  tags: string[];
  retention: "automatic" | "dsar_only";
}

/** One row per table of the live schema, with its category and classification tags. */
export async function loadDataInventory(db: Db): Promise<InventoryRow[]> {
  const rows = (await db.execute(sql`
    select c.table_name as "table", array_agg(c.column_name::text) as columns
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.table_name not like '%drizzle%'
    group by c.table_name
    order by c.table_name`)) as unknown as Array<{ table: string; columns: string[] }>;
  const automatic = new Set(RETENTION_TARGETS.map((t) => t.table));
  return rows.map((r) => {
    const tags: string[] = [];
    if (r.columns.some((c) => c === "workspace_id" || c === "tenant_id")) tags.push("tenant_scoped");
    if (r.columns.some((c) => /(email|phone|first_name|last_name|full_name|linkedin|ip_address)/.test(c))) tags.push("personal_data");
    if (r.columns.some((c) => /(password|token|secret|credential|api_key)/.test(c))) tags.push("credentials");
    return { table: r.table, category: classifyTable(r.table), tags, retention: automatic.has(r.table) ? "automatic" : "dsar_only" };
  });
}

type Counts = Record<string, { category: RetentionCategory; days: number; rows: number }>;

async function policyOf(db: Db, workspaceId: string) {
  const config = await getConfig(db, workspaceId, "retention_policy", "default");
  const categories = ((config?.value as { categories?: Record<string, { days: number | null }> } | undefined)?.categories ?? {}) as Record<
    string,
    { days: number | null } | undefined
  >;
  return { version: config?.version ?? 0, days: Object.fromEntries(RETENTION_CATEGORIES.map((c) => [c, categories[c]?.days ?? null])) as Record<RetentionCategory, number | null> };
}

function condition(target: RetentionTarget, workspaceId: string, cutoff: Date) {
  const extra = target.where ? sql.raw(` and ${target.where}`) : sql.raw("");
  return sql`${sql.raw(`"${target.tenantColumn}"`)} = ${workspaceId} and ${sql.raw(`"${target.ageColumn}"`)} < ${cutoff.toISOString()}${extra}`;
}

function runDto(row: typeof copsRetentionRuns.$inferSelect) {
  return {
    id: row.id,
    mode: row.mode as "dry_run" | "apply",
    status: row.status,
    policy_version: row.policyVersion,
    counts: row.counts as Counts,
    total_rows: Object.values(row.counts as Counts).reduce((n, c) => n + c.rows, 0),
    dry_run_id: row.dryRunId,
    reason: row.reason,
    requested_by: row.requestedBy,
    created_at: row.createdAt.toISOString(),
  };
}

export async function listRetentionRuns(db: Db, workspaceId: string) {
  const rows = await db.select().from(copsRetentionRuns).where(eq(copsRetentionRuns.workspaceId, workspaceId)).orderBy(desc(copsRetentionRuns.createdAt)).limit(50);
  return rows.map(runDto);
}

/**
 * Runs retention for the workspace. `dry_run` only counts. `apply` deletes, and is refused unless
 * a dry run of the same policy version finished in the last 24 hours and a reason is given.
 */
export async function startRetentionRun(
  db: Db,
  ctx: RetentionContext,
  input: { mode: "dry_run" | "apply"; dry_run_id?: string; reason?: string },
  now: Date = new Date()
) {
  const policy = await policyOf(db, ctx.workspaceId);
  if (input.mode === "apply") {
    if (!input.reason?.trim()) throw new RetentionError("VALIDATION_FAILED", "A reason is required to delete data", { fields: [{ path: "reason", message: "Required" }] });
    if (!input.dry_run_id) throw new RetentionError("BUSINESS_STATE_CONFLICT", "Run a dry run first, then apply it");
    const [dry] = await db
      .select()
      .from(copsRetentionRuns)
      .where(and(eq(copsRetentionRuns.id, input.dry_run_id), eq(copsRetentionRuns.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (!dry || dry.mode !== "dry_run") throw new RetentionError("NOT_FOUND", "Dry run not found");
    if (dry.policyVersion !== policy.version) {
      throw new RetentionError("BUSINESS_STATE_CONFLICT", "The retention policy changed after this dry run; run a new dry run", { dry_run_policy_version: dry.policyVersion, policy_version: policy.version });
    }
    if (now.getTime() - dry.createdAt.getTime() > DRY_RUN_VALID_MS) {
      throw new RetentionError("BUSINESS_STATE_CONFLICT", "This dry run is older than 24 hours; run a new dry run");
    }
  }

  return db.transaction(async (tx) => {
    const counts: Counts = {};
    for (const target of RETENTION_TARGETS) {
      const days = policy.days[target.category];
      if (days == null) continue;
      const cutoff = new Date(now.getTime() - days * DAY_MS);
      const where = condition(target, ctx.workspaceId, cutoff);
      const table = sql.raw(`"${target.table}"`);
      let rows: number;
      if (input.mode === "apply") {
        const deleted = (await tx.execute(sql`with gone as (delete from ${table} where ${where} returning 1) select count(*)::int as n from gone`)) as unknown as Array<{ n: number }>;
        rows = deleted[0]?.n ?? 0;
      } else {
        const counted = (await tx.execute(sql`select count(*)::int as n from ${table} where ${where}`)) as unknown as Array<{ n: number }>;
        rows = counted[0]?.n ?? 0;
      }
      counts[target.table] = { category: target.category, days, rows };
    }
    const [run] = await tx
      .insert(copsRetentionRuns)
      .values({
        workspaceId: ctx.workspaceId,
        mode: input.mode,
        status: "completed",
        policyVersion: policy.version,
        counts,
        dryRunId: input.mode === "apply" ? input.dry_run_id! : null,
        reason: input.reason?.trim() || null,
        requestedBy: ctx.userId,
        createdAt: now,
      })
      .returning();
    // Written after the deletes, so the record of an applied run is never removed by that run.
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "cops_retention_run",
      entityId: run!.id,
      action: input.mode === "apply" ? "retention.applied" : "retention.dry_run",
      after: { policy_version: policy.version, counts },
      reason: input.reason?.trim() || undefined,
      override: input.mode === "apply",
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    return runDto(run!);
  });
}
