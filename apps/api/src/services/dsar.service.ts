import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedById, scopedTo } from "@skout/db";
import { HttpError } from "../utils/http.js";

const { dataSubjectRequests, consents, suppressions } = schema;

export type DsarRequestType = "access" | "erasure" | "rectification" | "portability";
export type DsarStatus = "received" | "in_progress" | "completed" | "rejected";
export type DsarFulfillmentMode = "manual" | "auto";

const DEFAULT_SLA_DAYS = 30;

export interface DsarDto {
  id: string;
  workspaceId: string;
  requestType: string;
  subjectEmail: string;
  subjectType: string;
  subjectId: string | null;
  status: string;
  fulfillmentMode: string;
  slaDueAt: string | null;
  exportPayload: string | null;
  exportCompletedAt: string | null;
  notes: string | null;
  requestedBy: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toDto(row: typeof dataSubjectRequests.$inferSelect): DsarDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    requestType: row.requestType,
    subjectEmail: row.subjectEmail,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    status: row.status,
    fulfillmentMode: row.fulfillmentMode,
    slaDueAt: row.slaDueAt ? row.slaDueAt.toISOString() : null,
    exportPayload: row.exportPayload,
    exportCompletedAt: row.exportCompletedAt ? row.exportCompletedAt.toISOString() : null,
    notes: row.notes,
    requestedBy: row.requestedBy,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function slaDueFrom(now = new Date()): Date {
  return new Date(now.getTime() + DEFAULT_SLA_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * §16 DSAR — intake + dual fulfillment:
 * - manual: legal/ops queue with 30-day SLA (default per product)
 * - auto: for access/portability, assemble a JSON export package immediately
 */
export class DsarService {
  constructor(private readonly db: Db) {}

  async create(
    workspaceId: string,
    input: {
      requestType: DsarRequestType;
      subjectEmail: string;
      subjectType?: string;
      subjectId?: string;
      notes?: string;
      requestedBy?: string;
      fulfillmentMode?: DsarFulfillmentMode;
    }
  ): Promise<DsarDto> {
    const mode: DsarFulfillmentMode =
      input.fulfillmentMode ??
      (input.requestType === "access" || input.requestType === "portability" ? "auto" : "manual");

    const email = input.subjectEmail.toLowerCase();
    const [open] = await this.db
      .select({ id: dataSubjectRequests.id })
      .from(dataSubjectRequests)
      .where(
        scopedTo(
          dataSubjectRequests,
          workspaceId,
          and(
            eq(dataSubjectRequests.subjectEmail, email),
            eq(dataSubjectRequests.requestType, input.requestType),
            inArray(dataSubjectRequests.status, ["received", "in_progress"])
          )
        )
      )
      .limit(1);
    if (open) throw new HttpError("dsar_already_open", 409);

    const [row] = await this.db
      .insert(dataSubjectRequests)
      .values({
        workspaceId,
        requestType: input.requestType,
        subjectEmail: input.subjectEmail.toLowerCase(),
        subjectType: input.subjectType ?? "prospect",
        subjectId: input.subjectId ?? null,
        notes: input.notes ?? null,
        requestedBy: input.requestedBy ?? null,
        status: "received",
        fulfillmentMode: mode,
        slaDueAt: slaDueFrom(),
      })
      .returning();
    if (!row) throw new HttpError("Failed to create DSAR", 500);

    if (mode === "auto" && (input.requestType === "access" || input.requestType === "portability")) {
      return this.runAutoExport(workspaceId, row.id);
    }
    return toDto(row);
  }

  async list(workspaceId: string, status?: string): Promise<DsarDto[]> {
    const rows = status
      ? await this.db
          .select()
          .from(dataSubjectRequests)
          .where(scopedTo(dataSubjectRequests, workspaceId, eq(dataSubjectRequests.status, status)))
          .orderBy(desc(dataSubjectRequests.createdAt))
      : await this.db
          .select()
          .from(dataSubjectRequests)
          .where(scopedTo(dataSubjectRequests, workspaceId))
          .orderBy(desc(dataSubjectRequests.createdAt));
    return rows.map(toDto);
  }

  async updateStatus(
    workspaceId: string,
    id: string,
    status: DsarStatus,
    notes?: string
  ): Promise<DsarDto> {
    const [row] = await this.db
      .update(dataSubjectRequests)
      .set({
        status,
        notes: notes ?? undefined,
        completedAt: status === "completed" || status === "rejected" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(scopedById(dataSubjectRequests, workspaceId, id))
      .returning();
    if (!row) throw new HttpError("dsar_not_found", 404);
    return toDto(row);
  }

  /** Auto-export package for access/portability — consents + request metadata (expandable). */
  async runAutoExport(workspaceId: string, id: string): Promise<DsarDto> {
    const [existing] = await this.db
      .select()
      .from(dataSubjectRequests)
      .where(scopedById(dataSubjectRequests, workspaceId, id))
      .limit(1);
    if (!existing) throw new HttpError("dsar_not_found", 404);

    const consentRows = await this.db
      .select()
      .from(consents)
      .where(
        scopedTo(
          consents,
          workspaceId,
          or(
            eq(consents.subjectId, existing.subjectId ?? existing.subjectEmail),
            sql`lower(${consents.subjectId}) = ${existing.subjectEmail.toLowerCase()}`
          )
        )
      )
      .limit(200);

    const [suppressionRow] = await this.db
      .select()
      .from(suppressions)
      .where(scopedTo(suppressions, workspaceId, eq(suppressions.email, existing.subjectEmail.toLowerCase())))
      .limit(1);
    const hasData = consentRows.length > 0 || !!suppressionRow;

    const payload = {
      requestId: existing.id,
      requestType: existing.requestType,
      subjectEmail: existing.subjectEmail,
      subjectType: existing.subjectType,
      subjectId: existing.subjectId,
      exportedAt: new Date().toISOString(),
      slaDueAt: existing.slaDueAt?.toISOString() ?? null,
      consents: consentRows.map((c) => ({
        id: c.id,
        type: c.type,
        basis: c.basis,
        grantedAt: c.grantedAt?.toISOString?.() ?? c.grantedAt,
        revokedAt: c.revokedAt?.toISOString?.() ?? c.revokedAt,
      })),
      suppression: suppressionRow
        ? { reason: suppressionRow.reason, createdAt: suppressionRow.createdAt.toISOString() }
        : null,
      note: hasData
        ? "Auto-export v1: consents + suppression + request metadata. CRM/inbox records are not included yet."
        : "No consent or suppression records are keyed to this email. CRM/inbox records are not covered by auto-export — manual review required.",
    };

    const [row] = await this.db
      .update(dataSubjectRequests)
      .set({
        // Nothing found != nothing exists (CRM/inbox aren't searched) — keep it open for a human.
        status: hasData ? "completed" : "in_progress",
        exportPayload: JSON.stringify(payload),
        exportCompletedAt: hasData ? new Date() : null,
        completedAt: hasData ? new Date() : null,
        notes:
          existing.notes ??
          (hasData
            ? "Auto-export completed under 30-day SLA policy."
            : "Auto-export found no records; manual review required."),
        updatedAt: new Date(),
      })
      .where(scopedById(dataSubjectRequests, workspaceId, id))
      .returning();
    if (!row) throw new HttpError("dsar_not_found", 404);
    return toDto(row);
  }
}

export function buildDsarService(db: Db | null): DsarService | null {
  return db ? new DsarService(db) : null;
}
