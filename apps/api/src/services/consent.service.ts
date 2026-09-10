import { desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedById, scopedTo } from "@skout/db";
import { HttpError } from "../utils/http.js";

const { consents } = schema;

export interface ConsentDto {
  id: string;
  workspaceId: string;
  subjectType: string;
  subjectId: string;
  type: string;
  basis: string;
  grantedAt: string;
  revokedAt: string | null;
  recordedBy: string | null;
}

export interface RecordConsentInput {
  workspaceId: string;
  subjectType: string;
  subjectId: string;
  type: string;
  basis: string;
  recordedBy?: string;
}

function toDto(row: typeof consents.$inferSelect): ConsentDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    type: row.type,
    basis: row.basis,
    grantedAt: row.grantedAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    recordedBy: row.recordedBy,
  };
}

/**
 * §5.1 (Enterprise Completion Plan) — consent capture. The `consents` table
 * (packages/db/src/schema/tenancy.ts) has existed since the tenancy/RBAC pass that added
 * `entitlements` alongside it, but nothing in the running system ever wrote to or read from it
 * — the same "table exists, nothing calls it" shape as identity-merge proposals before Task 28.
 * This is a real capture-and-check API, not a write-only sink: recordConsent() is the capture
 * half; hasActiveConsent() is what a sending path (sequence enrollment, SMS/WhatsApp outreach,
 * a future data-processing gate) is meant to call before acting on a subject.
 *
 * A consent row is never mutated once granted except to set revokedAt — revoking creates no new
 * row and deletes nothing, so listConsents() returning every row (granted and revoked) is a
 * genuine audit trail of what consent existed when, which is what a compliance question about
 * "did we have consent to email this person on March 3rd" actually needs.
 */
export class ConsentService {
  constructor(private readonly db: Db) {}

  async record(input: RecordConsentInput): Promise<ConsentDto> {
    const [row] = await this.db
      .insert(consents)
      .values({
        workspaceId: input.workspaceId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        type: input.type,
        basis: input.basis,
        recordedBy: input.recordedBy ?? null,
      })
      .returning();
    if (!row) throw new HttpError("Failed to record consent", 500);
    return toDto(row);
  }

  async revoke(workspaceId: string, id: string): Promise<ConsentDto> {
    const [existing] = await this.db
      .select()
      .from(consents)
      .where(scopedById(consents, workspaceId, id));
    if (!existing) throw new HttpError("consent_not_found", 404);
    if (existing.revokedAt) throw new HttpError("consent_already_revoked", 409);

    const [row] = await this.db
      .update(consents)
      .set({ revokedAt: new Date() })
      .where(scopedById(consents, workspaceId, id))
      .returning();
    if (!row) throw new HttpError("consent_not_found", 404);
    return toDto(row);
  }

  /** Workspace-wide consent audit trail (most recent first). */
  async listWorkspace(
    workspaceId: string,
    options: { limit?: number; offset?: number; subjectType?: string } = {}
  ): Promise<{ data: ConsentDto[]; total: number }> {
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = options.offset ?? 0;
    const extra = options.subjectType ? eq(consents.subjectType, options.subjectType) : undefined;

    const rows = await this.db
      .select()
      .from(consents)
      .where(scopedTo(consents, workspaceId, extra))
      .orderBy(desc(consents.grantedAt))
      .limit(limit)
      .offset(offset);

    const all = await this.db
      .select({ id: consents.id })
      .from(consents)
      .where(scopedTo(consents, workspaceId, extra));

    return { data: rows.map(toDto), total: all.length };
  }

  /** Full history (granted and revoked) for one subject, most recent grant first. */
  async list(workspaceId: string, subjectType: string, subjectId: string): Promise<ConsentDto[]> {
    const rows = await this.db
      .select()
      .from(consents)
      .where(
        scopedTo(consents, workspaceId, eq(consents.subjectType, subjectType), eq(consents.subjectId, subjectId))
      )
      .orderBy(desc(consents.grantedAt));
    return rows.map(toDto);
  }

  /**
   * The check a sending/processing path actually needs: does this subject have an
   * unrevoked consent row for `type`, as of now. Returns false (not an error) when the subject
   * has no consent history at all — "never asked" and "explicitly revoked" both resolve to "no,
   * don't act," which is the fail-closed behavior a consent gate needs by default.
   */
  async hasActive(workspaceId: string, subjectType: string, subjectId: string, type: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: consents.id })
      .from(consents)
      .where(
        scopedTo(
          consents,
          workspaceId,
          eq(consents.subjectType, subjectType),
          eq(consents.subjectId, subjectId),
          eq(consents.type, type),
          isNull(consents.revokedAt)
        )
      )
      .limit(1);
    return !!row;
  }
}

export function buildConsentService(db: Db | null): ConsentService | null {
  return db ? new ConsentService(db) : null;
}
