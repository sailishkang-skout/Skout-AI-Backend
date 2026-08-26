import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "../utils/http.js";

const { entitlements } = schema;

export interface EntitlementDto {
  id: string;
  workspaceId: string;
  key: string;
  value: unknown;
  source: string;
  updatedAt: string;
}

function toDto(row: typeof entitlements.$inferSelect): EntitlementDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    key: row.key,
    value: row.value,
    source: row.source,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * §5.1 / §11.1 / §16 Task 35 (Enterprise Completion Plan) — the real read/write API for the
 * `entitlements` table this codebase's own doc comment on it had, until this pass, wrongly
 * claimed already existed. See the doc comment on `entitlements` in
 * packages/db/src/schema/tenancy.ts for the full scope note (this is deliberately narrow and
 * additive-only — it does not touch the credit ledger or any deduction logic).
 */
export class EntitlementsService {
  constructor(private readonly db: Db) {}

  async list(workspaceId: string): Promise<EntitlementDto[]> {
    const rows = await this.db.select().from(entitlements).where(eq(entitlements.workspaceId, workspaceId));
    return rows.map(toDto);
  }

  async get(workspaceId: string, key: string): Promise<EntitlementDto | null> {
    const [row] = await this.db
      .select()
      .from(entitlements)
      .where(and(eq(entitlements.workspaceId, workspaceId), eq(entitlements.key, key)))
      .limit(1);
    return row ? toDto(row) : null;
  }

  /**
   * Typed convenience for a call site that just wants "the override, or my existing default."
   * Never throws — a malformed/missing entitlement resolves to `fallback`, so a bad write here
   * can never be the reason a real request fails; it can only fail to apply an override.
   */
  async getValueOr<T>(workspaceId: string, key: string, fallback: T): Promise<T> {
    try {
      const row = await this.get(workspaceId, key);
      if (!row) return fallback;
      return row.value as T;
    } catch {
      return fallback;
    }
  }

  /** Upsert on (workspaceId, key) — see 0055_entitlements_unique.sql for the DB-level unique
   * index this relies on as a real conflict target. */
  async set(workspaceId: string, key: string, value: unknown, source = "manual"): Promise<EntitlementDto> {
    const [row] = await this.db
      .insert(entitlements)
      .values({ workspaceId, key, value: value === undefined ? null : value, source, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [entitlements.workspaceId, entitlements.key],
        set: { value: value === undefined ? null : value, source, updatedAt: new Date() },
      })
      .returning();
    if (!row) throw new HttpError("Failed to set entitlement", 500);
    return toDto(row);
  }

  async remove(workspaceId: string, key: string): Promise<void> {
    await this.db.delete(entitlements).where(and(eq(entitlements.workspaceId, workspaceId), eq(entitlements.key, key)));
  }
}

export function buildEntitlementsService(db: Db | null): EntitlementsService | null {
  return db ? new EntitlementsService(db) : null;
}
