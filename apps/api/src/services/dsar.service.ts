import { and, desc, eq, or, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "../utils/http.js";

const { dataSubjectRequests, consents } = schema;

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
          .where(and(eq(dataSubjectRequests.workspaceId, workspaceId), eq(dataSubjectRequests.status, status)))
          .orderBy(desc(dataSubjectRequests.createdAt))
      : await this.db
          .select()
          .from(dataSubjectRequests)
          .where(eq(dataSubjectRequests.workspaceId, workspaceId))
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
      .where(and(eq(dataSubjectRequests.id, id), eq(dataSubjectRequests.workspaceId, workspaceId)))
      .returning();
    if (!row) throw new HttpError("dsar_not_found", 404);
    return toDto(row);
  }

  /** Auto-export package for access/portability — consents + request metadata (expandable). */
  async runAutoExport(workspaceId: string, id: string): Promise<DsarDto> {
    const [existing] = await this.db
      .select()
      .from(dataSubjectRequests)
      .where(and(eq(dataSubjectRequests.id, id), eq(dataSubjectRequests.workspaceId, workspaceId)))
      .limit(1);
    if (!existing) throw new HttpError("dsar_not_found", 404);

    const consentRows = await this.db
      .select()
      .from(consents)
      .where(
        and(
          eq(consents.workspaceId, workspaceId),
          or(
            eq(consents.subjectId, existing.subjectId ?? existing.subjectEmail),
            sql`lower(${consents.subjectId}) = ${existing.subjectEmail.toLowerCase()}`
          )
        )
      )
      .limit(200);

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
      note: "Auto-export v1: consents + request metadata. Expand to CRM/inbox in later passes.",
    };

    const [row] = await this.db
      .update(dataSubjectRequests)
      .set({
        status: "completed",
        exportPayload: JSON.stringify(payload),
        exportCompletedAt: new Date(),
        completedAt: new Date(),
        notes: existing.notes ?? "Auto-export completed under 30-day SLA policy.",
        updatedAt: new Date(),
      })
      .where(and(eq(dataSubjectRequests.id, id), eq(dataSubjectRequests.workspaceId, workspaceId)))
      .returning();
    if (!row) throw new HttpError("dsar_not_found", 404);
    return toDto(row);
  }
}

export function buildDsarService(db: Db | null): DsarService | null {
  return db ? new DsarService(db) : null;
}
