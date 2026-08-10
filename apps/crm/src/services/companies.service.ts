import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { CompanyCreateInput, CompanyUpdateInput } from "@skout/shared";
import { buildAuditService, type AuditService } from "./audit.service.js";
import { serviceLog } from "../lib/obs.js";
import {
  asFieldSourcesMap,
  filterAutoFillablePatch,
  markManualSources,
  mergeAutoFillSources,
  type FieldSource,
  type FieldSourcesMap,
} from "../utils/field-sources.js";
import { HttpError } from "@skout/auth";

const log = serviceLog("companies");
const { companies } = schema;

export interface CompanyDto {
  id: string;
  workspaceId: string;
  name: string;
  domain: string | null;
  industry: string | null;
  employeeCount: number | null;
  revenue: number | null;
  location: string | null;
  ownerId: string | null;
  status: string;
  sourceProspectCompanyId: string | null;
  fieldSources: FieldSourcesMap;
  createdAt: string;
  updatedAt: string;
}

/** Fields eligible for auto-fill — deliberately excludes identity/ownership fields. */
export interface CompanyAutoFillPatch {
  industry?: string;
  employeeCount?: number;
  revenue?: number;
  location?: string;
}
const AUTO_FILLABLE_COMPANY_FIELDS = ["industry", "employeeCount", "revenue", "location"] as const;

type CompanyDbUpdatePatch = Partial<{
  name: string;
  domain: string | null;
  industry: string | null;
  employeeCount: number | null;
  revenue: string | null;
  location: string | null;
  ownerId: string | null;
  status: string;
  sourceProspectCompanyId: string | null;
}>;

function toDto(row: typeof companies.$inferSelect): CompanyDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    domain: row.domain,
    industry: row.industry,
    employeeCount: row.employeeCount,
    revenue: row.revenue === null ? null : Number(row.revenue),
    location: row.location,
    ownerId: row.ownerId,
    status: row.status,
    sourceProspectCompanyId: row.sourceProspectCompanyId,
    fieldSources: asFieldSourcesMap(row.fieldSources),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function hasMeaningfulChanges(existing: CompanyDto, patch: CompanyDbUpdatePatch): boolean {
  return Object.entries(patch).some(([key, value]) => {
    const existingValue = existing[key as keyof CompanyDto];
    const normalizedExisting = key === "revenue" && typeof existingValue === "number" ? existingValue.toString() : existingValue;
    const normalizedValue = key === "revenue" && value !== null ? value.toString() : value;
    return JSON.stringify(normalizedExisting) !== JSON.stringify(normalizedValue);
  });
}

export class CompaniesService {
  constructor(
    private readonly db: Db,
    private readonly auditService: AuditService
  ) {}

  async list(
    workspaceId: string,
    options: { limit: number; offset: number; ownerId?: string }
  ): Promise<{ data: CompanyDto[]; total: number }> {
    const conditions = [eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt)];
    if (options.ownerId) conditions.push(eq(companies.ownerId, options.ownerId));

    const rows = await this.db
      .select()
      .from(companies)
      .where(and(...conditions))
      .limit(options.limit)
      .offset(options.offset);

    const all = await this.db
      .select({ id: companies.id })
      .from(companies)
      .where(and(...conditions));

    return { data: rows.map(toDto), total: all.length };
  }

  async getById(workspaceId: string, id: string): Promise<CompanyDto | null> {
    const [row] = await this.db
      .select()
      .from(companies)
      .where(and(eq(companies.id, id), eq(companies.workspaceId, workspaceId), isNull(companies.deletedAt)))
      .limit(1);
    return row ? toDto(row) : null;
  }

  async create(workspaceId: string, actorId: string | undefined, input: CompanyCreateInput): Promise<CompanyDto> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(companies)
        .values({
          workspaceId,
          name: input.name,
          domain: input.domain,
          industry: input.industry,
          employeeCount: input.employeeCount,
          revenue: input.revenue?.toString(),
          location: input.location,
          ownerId: input.ownerId,
          status: input.status,
          sourceProspectCompanyId: input.sourceProspectCompanyId,
        })
        .returning();

      const dto = toDto(row);
      const txAuditService = buildAuditService(tx as never);
      await txAuditService?.record(workspaceId, actorId, "create", "company", dto.id, null, dto);
      log.info("company created", { workspaceId, companyId: row.id });
      return dto;
    });
  }

  async update(
    workspaceId: string,
    id: string,
    actorId: string | undefined,
    input: CompanyUpdateInput
  ): Promise<CompanyDto | null> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return null;

    const patch: CompanyDbUpdatePatch = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.domain !== undefined ? { domain: input.domain } : {}),
      ...(input.industry !== undefined ? { industry: input.industry } : {}),
      ...(input.employeeCount !== undefined ? { employeeCount: input.employeeCount } : {}),
      ...(input.revenue !== undefined ? { revenue: input.revenue.toString() } : {}),
      ...(input.location !== undefined ? { location: input.location } : {}),
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.sourceProspectCompanyId !== undefined
        ? { sourceProspectCompanyId: input.sourceProspectCompanyId }
        : {}),
    };

    // R13.3: a human editing an auto-fillable field via this endpoint marks it "manual" —
    // auto-fill can never overwrite it again after this.
    const editedAutoFillable = AUTO_FILLABLE_COMPANY_FIELDS.filter((field) => input[field] !== undefined);
    const nextFieldSources =
      editedAutoFillable.length > 0
        ? markManualSources(asFieldSourcesMap(existing.fieldSources), editedAutoFillable)
        : undefined;

    if (!hasMeaningfulChanges(existing, patch) && !nextFieldSources) {
      return existing;
    }

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(companies)
        .set({
          ...patch,
          ...(nextFieldSources !== undefined ? { fieldSources: nextFieldSources } : {}),
          updatedAt: new Date(),
        } satisfies Partial<typeof companies.$inferInsert>)
        .where(and(eq(companies.id, id), eq(companies.workspaceId, workspaceId)))
        .returning();

      const dto = row ? toDto(row) : null;
      if (dto) {
        const txAuditService = buildAuditService(tx as never);
        await txAuditService?.record(workspaceId, actorId, "update", "company", id, existing, dto);
      }
      if (row) log.info("company updated", { workspaceId, companyId: id });
      return dto;
    });
  }

  /**
   * R13.3 — auto-fill fields from enrichment. Fields a human has already manually edited are
   * silently skipped (never overwritten); returns which fields were applied vs. skipped.
   */
  async autoFill(
    workspaceId: string,
    id: string,
    patch: CompanyAutoFillPatch,
    source: FieldSource,
    confidence?: number
  ): Promise<{ company: CompanyDto; applied: string[]; skipped: string[] } | null> {
    if (source === "manual") {
      throw new HttpError("invalid_auto_fill_source", 400, { reason: "use update() for manual edits" });
    }
    const existing = await this.getById(workspaceId, id);
    if (!existing) return null;

    const { applied, skipped } = filterAutoFillablePatch(patch, existing.fieldSources);
    const appliedFields = Object.keys(applied);
    if (appliedFields.length === 0) {
      return { company: existing, applied: [], skipped };
    }

    const nextFieldSources = mergeAutoFillSources(existing.fieldSources, appliedFields, source, confidence);
    const dbPatch: CompanyDbUpdatePatch = {
      ...(applied.industry !== undefined ? { industry: applied.industry } : {}),
      ...(applied.employeeCount !== undefined ? { employeeCount: applied.employeeCount } : {}),
      ...(applied.revenue !== undefined ? { revenue: String(applied.revenue) } : {}),
      ...(applied.location !== undefined ? { location: applied.location } : {}),
    };

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(companies)
        .set({ ...dbPatch, fieldSources: nextFieldSources, updatedAt: new Date() })
        .where(and(eq(companies.id, id), eq(companies.workspaceId, workspaceId)))
        .returning();

      const dto = toDto(row);
      const txAuditService = buildAuditService(tx as never);
      await txAuditService?.record(workspaceId, undefined, "update", "company", id, existing, dto);
      log.info("company auto-filled", { workspaceId, companyId: id, source, applied: appliedFields, skipped });
      return { company: dto, applied: appliedFields, skipped };
    });
  }

  async softDelete(workspaceId: string, id: string, actorId: string | undefined): Promise<boolean> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return false;

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(companies)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(companies.id, id), eq(companies.workspaceId, workspaceId)))
        .returning();

      const dto = row ? toDto(row) : null;
      if (dto) {
        const txAuditService = buildAuditService(tx as never);
        await txAuditService?.record(workspaceId, actorId, "delete", "company", id, existing, dto);
      }
      if (row) log.info("company soft-deleted", { workspaceId, companyId: id });
      return Boolean(row);
    });
  }

  /** Confirms a company id belongs to the given workspace (used by contacts/deals create). */
  async existsInWorkspace(workspaceId: string, id: string): Promise<boolean> {
    return (await this.getById(workspaceId, id)) !== null;
  }
}

export function buildCompaniesService(db: Db | null, auditService: AuditService | null): CompaniesService | null {
  return db && auditService ? new CompaniesService(db, auditService) : null;
}
