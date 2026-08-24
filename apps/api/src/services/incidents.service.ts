import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "../utils/http.js";

const { incidents } = schema;

export interface IncidentDto {
  id: string;
  workspaceId: string;
  title: string;
  severity: string;
  status: string;
  source: string;
  description: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  detectedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNotes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateIncidentInput {
  workspaceId: string;
  title: string;
  severity?: string;
  source: string;
  description?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

function toDto(row: typeof incidents.$inferSelect): IncidentDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    severity: row.severity,
    status: row.status,
    source: row.source,
    description: row.description,
    relatedEntityType: row.relatedEntityType,
    relatedEntityId: row.relatedEntityId,
    detectedAt: row.detectedAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolvedBy: row.resolvedBy,
    resolutionNotes: row.resolutionNotes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * §5.1 / §11.3 Task 36 (Enterprise Completion Plan) — the first real writer for Incident. The
 * table (packages/db/src/schema/incidents.ts) shipped in an earlier pass as "the durable
 * record an alert (Sentry, Datadog, a future OTel-based anomaly detector) resolves into" — but
 * nothing in the codebase ever created one. This is that missing writer: a normal
 * workspace-scoped service, unlike ModelVersion/PromptVersion in the same task (see
 * model-versions.service.ts's doc comment for why those are deliberately NOT given an
 * HTTP-write route) — an Incident is workspace-scoped data with no cross-tenant blast radius,
 * so it gets the same open-to-any-workspace-member write posture evidence.routes.ts and
 * consent.routes.ts already use for provenance/operational bookkeeping.
 */
export class IncidentsService {
  constructor(private readonly db: Db) {}

  async create(input: CreateIncidentInput): Promise<IncidentDto> {
    const [row] = await this.db
      .insert(incidents)
      .values({
        workspaceId: input.workspaceId,
        title: input.title,
        severity: input.severity ?? "medium",
        source: input.source,
        description: input.description ?? null,
        relatedEntityType: input.relatedEntityType ?? null,
        relatedEntityId: input.relatedEntityId ?? null,
      })
      .returning();
    if (!row) throw new HttpError("Failed to create incident", 500);
    return toDto(row);
  }

  async list(workspaceId: string, status?: string): Promise<IncidentDto[]> {
    const conditions = [eq(incidents.workspaceId, workspaceId)];
    if (status) conditions.push(eq(incidents.status, status));
    const rows = await this.db
      .select()
      .from(incidents)
      .where(and(...conditions))
      .orderBy(desc(incidents.detectedAt));
    return rows.map(toDto);
  }

  async get(workspaceId: string, id: string): Promise<IncidentDto | null> {
    const [row] = await this.db
      .select()
      .from(incidents)
      .where(and(eq(incidents.id, id), eq(incidents.workspaceId, workspaceId)));
    return row ? toDto(row) : null;
  }

  /** Moves status to "investigating" without resolving — a lighter-weight update than
   * resolve(), for "someone is looking at this" without claiming it's fixed. */
  async acknowledge(workspaceId: string, id: string): Promise<IncidentDto> {
    const [row] = await this.db
      .update(incidents)
      .set({ status: "investigating", updatedAt: new Date() })
      .where(and(eq(incidents.id, id), eq(incidents.workspaceId, workspaceId)))
      .returning();
    if (!row) throw new HttpError("incident_not_found", 404);
    return toDto(row);
  }

  async resolve(workspaceId: string, id: string, resolvedBy: string | undefined, resolutionNotes?: string): Promise<IncidentDto> {
    const [existing] = await this.db
      .select()
      .from(incidents)
      .where(and(eq(incidents.id, id), eq(incidents.workspaceId, workspaceId)));
    if (!existing) throw new HttpError("incident_not_found", 404);
    if (existing.status === "resolved") throw new HttpError("incident_already_resolved", 409);

    const [row] = await this.db
      .update(incidents)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        resolvedBy: resolvedBy ?? null,
        resolutionNotes: resolutionNotes ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(incidents.id, id), eq(incidents.workspaceId, workspaceId)))
      .returning();
    if (!row) throw new HttpError("incident_not_found", 404);
    return toDto(row);
  }
}

export function buildIncidentsService(db: Db | null): IncidentsService | null {
  return db ? new IncidentsService(db) : null;
}
