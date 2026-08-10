import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { DealCreateInput, DealUpdateInput } from "@skout/shared";
import { HttpError } from "@skout/auth";
import type { CompaniesService } from "./companies.service.js";
import type { PipelinesService } from "./pipelines.service.js";
import type { ActivitiesService } from "./activities.service.js";
import type { AuditService } from "./audit.service.js";
import { serviceLog } from "../lib/obs.js";
import {
  asFieldSourcesMap,
  filterAutoFillablePatch,
  mergeAutoFillSources,
  type FieldSource,
  type FieldSourcesMap,
} from "../utils/field-sources.js";

const log = serviceLog("deals");
const { deals, pipelineStages } = schema;

export interface DealDto {
  id: string;
  workspaceId: string;
  companyId: string | null;
  pipelineId: string;
  stageId: string;
  ownerId: string | null;
  name: string;
  amount: number | null;
  currency: string;
  closeDate: string | null;
  probability: number | null;
  status: string;
  fieldSources: FieldSourcesMap;
  createdAt: string;
  updatedAt: string;
}

/** R16.3 — fields an LLM transcript extraction (or other auto-fill source) may set: budget → amount, timeline → closeDate. */
export interface DealAutoFillPatch {
  amount?: number;
  closeDate?: string;
}

export interface DealsSummaryDto {
  workspaceId: string;
  openDeals: number;
  pipelineValue: number;
  currency: string;
  stages: { stageId: string; name: string; count: number; value: number }[];
}

function toDto(row: typeof deals.$inferSelect): DealDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    companyId: row.companyId,
    pipelineId: row.pipelineId,
    stageId: row.stageId,
    ownerId: row.ownerId,
    name: row.name,
    amount: row.amount === null ? null : Number(row.amount),
    currency: row.currency,
    closeDate: row.closeDate,
    probability: row.probability,
    status: row.status,
    fieldSources: asFieldSourcesMap(row.fieldSources),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class DealsService {
  constructor(
    private readonly db: Db,
    private readonly companiesService: CompaniesService,
    private readonly pipelinesService: PipelinesService,
    private readonly activitiesService: ActivitiesService,
    private readonly auditService: AuditService
  ) {}

  async list(
    workspaceId: string,
    options: { limit: number; offset: number; stageId?: string; status?: string; ownerId?: string }
  ): Promise<{ data: DealDto[]; total: number }> {
    const conditions = [eq(deals.workspaceId, workspaceId), isNull(deals.deletedAt)];
    if (options.stageId) conditions.push(eq(deals.stageId, options.stageId));
    if (options.status) conditions.push(eq(deals.status, options.status));
    if (options.ownerId) conditions.push(eq(deals.ownerId, options.ownerId));

    const rows = await this.db
      .select()
      .from(deals)
      .where(and(...conditions))
      .limit(options.limit)
      .offset(options.offset);

    const all = await this.db
      .select({ id: deals.id })
      .from(deals)
      .where(and(...conditions));

    return { data: rows.map(toDto), total: all.length };
  }

  async getById(workspaceId: string, id: string): Promise<DealDto | null> {
    const [row] = await this.db
      .select()
      .from(deals)
      .where(and(eq(deals.id, id), eq(deals.workspaceId, workspaceId), isNull(deals.deletedAt)))
      .limit(1);
    return row ? toDto(row) : null;
  }

  /**
   * R16.3 — auto-fill budget/timeline (amount/closeDate) extracted from a meeting transcript.
   * Same provenance rules as R13.3's contact/company autoFill: a manually-edited field is never
   * overwritten, and every applied field carries a confidence value.
   */
  async autoFill(
    workspaceId: string,
    id: string,
    patch: DealAutoFillPatch,
    source: FieldSource,
    confidence?: number
  ): Promise<{ deal: DealDto; applied: string[]; skipped: string[] } | null> {
    if (source === "manual") {
      throw new HttpError("invalid_auto_fill_source", 400, { reason: "use update() for manual edits" });
    }
    const existing = await this.getById(workspaceId, id);
    if (!existing) return null;

    const { applied, skipped } = filterAutoFillablePatch(patch, existing.fieldSources);
    const appliedFields = Object.keys(applied);
    if (appliedFields.length === 0) {
      return { deal: existing, applied: [], skipped };
    }

    const nextFieldSources = mergeAutoFillSources(existing.fieldSources, appliedFields, source, confidence);

    const [row] = await this.db
      .update(deals)
      .set({
        ...(applied.amount !== undefined ? { amount: String(applied.amount) } : {}),
        ...(applied.closeDate !== undefined ? { closeDate: applied.closeDate } : {}),
        fieldSources: nextFieldSources,
        updatedAt: new Date(),
      })
      .where(and(eq(deals.id, id), eq(deals.workspaceId, workspaceId)))
      .returning();

    const dto = toDto(row);
    await this.auditService.record(workspaceId, undefined, "update", "deal", id, existing, dto);
    log.info("deal auto-filled", { workspaceId, dealId: id, source, applied: appliedFields, skipped });
    return { deal: dto, applied: appliedFields, skipped };
  }

  async create(workspaceId: string, ownerId: string | undefined, input: DealCreateInput): Promise<DealDto> {
    if (!(await this.companiesService.existsInWorkspace(workspaceId, input.companyId))) {
      throw new HttpError("company_not_found", 404);
    }

    let pipelineId = input.pipelineId;
    let stageId = input.stageId;
    if (!pipelineId || !stageId) {
      const defaultPipeline = await this.pipelinesService.ensureDefaultPipeline(workspaceId);
      pipelineId = pipelineId ?? defaultPipeline.id;
      stageId = stageId ?? defaultPipeline.stages[0]?.id;
    }
    if (!stageId) throw new HttpError("pipeline_stage_required", 400);

    const [row] = await this.db
      .insert(deals)
      .values({
        workspaceId,
        companyId: input.companyId,
        pipelineId,
        stageId,
        ownerId: input.ownerId ?? ownerId,
        name: input.name,
        amount: input.amount?.toString(),
        currency: input.currency,
        closeDate: input.closeDate,
        probability: input.probability,
      })
      .returning();

    const dto = toDto(row);
    await this.auditService.record(workspaceId, ownerId, "create", "deal", dto.id, null, dto);
    log.info("deal created", { workspaceId, dealId: row.id });
    return dto;
  }

  async update(workspaceId: string, id: string, input: DealUpdateInput, actorId: string | undefined): Promise<DealDto | null> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return null;

    if (input.companyId && !(await this.companiesService.existsInWorkspace(workspaceId, input.companyId))) {
      throw new HttpError("company_not_found", 404);
    }

    // R16.3 — a human editing amount/closeDate via this endpoint marks it "manual" so a later
    // transcript-extraction auto-fill can never silently overwrite it again.
    const editedAutoFillable = (["amount", "closeDate"] as const).filter((field) => input[field] !== undefined);
    const nextFieldSources =
      editedAutoFillable.length > 0
        ? Object.fromEntries(
            Object.entries(asFieldSourcesMap(existing.fieldSources)).concat(
              editedAutoFillable.map((field) => [field, { source: "manual" as const, setAt: new Date().toISOString() }])
            )
          )
        : undefined;

    const [row] = await this.db
      .update(deals)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.companyId !== undefined ? { companyId: input.companyId } : {}),
        ...(input.pipelineId !== undefined ? { pipelineId: input.pipelineId } : {}),
        ...(input.stageId !== undefined ? { stageId: input.stageId } : {}),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
        ...(input.amount !== undefined ? { amount: input.amount.toString() } : {}),
        ...(input.currency !== undefined ? { currency: input.currency } : {}),
        ...(input.closeDate !== undefined ? { closeDate: input.closeDate } : {}),
        ...(input.probability !== undefined ? { probability: input.probability } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(nextFieldSources !== undefined ? { fieldSources: nextFieldSources } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(deals.id, id), eq(deals.workspaceId, workspaceId)))
      .returning();

    const dto = row ? toDto(row) : null;
    if (dto) {
      await this.auditService.record(workspaceId, actorId, "update", "deal", id, existing, dto);
    }

    if (row && input.stageId && input.stageId !== existing.stageId) {
      const [oldStage] = await this.db
        .select({ name: pipelineStages.name })
        .from(pipelineStages)
        .where(eq(pipelineStages.id, existing.stageId))
        .limit(1);
      const [newStage] = await this.db
        .select({ name: pipelineStages.name })
        .from(pipelineStages)
        .where(eq(pipelineStages.id, input.stageId))
        .limit(1);

      await this.activitiesService.record(
        workspaceId,
        actorId,
        "deal",
        id,
        "stage_change",
        "Stage changed",
        `${oldStage?.name ?? "Unknown"} → ${newStage?.name ?? "Unknown"}`
      );
    }

    if (row) log.info("deal updated", { workspaceId, dealId: id });
    return dto;
  }

  async softDelete(workspaceId: string, id: string, actorId: string | undefined): Promise<boolean> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return false;

    const [row] = await this.db
      .update(deals)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(deals.id, id), eq(deals.workspaceId, workspaceId)))
      .returning();

    const dto = row ? toDto(row) : null;
    if (dto) {
      await this.auditService.record(workspaceId, actorId, "delete", "deal", id, existing, dto);
    }
    log.info("deal soft-deleted", { workspaceId, dealId: id });
    return true;
  }

  async summary(workspaceId: string): Promise<DealsSummaryDto> {
    const rows = await this.db
      .select({
        stageId: deals.stageId,
        stageName: pipelineStages.name,
        count: sql<number>`count(${deals.id})`,
        value: sql<string>`coalesce(sum(${deals.amount}), 0)`,
      })
      .from(deals)
      .innerJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
      .where(and(eq(deals.workspaceId, workspaceId), eq(deals.status, "open"), isNull(deals.deletedAt)))
      .groupBy(deals.stageId, pipelineStages.name);

    const stages = rows.map((r) => ({
      stageId: r.stageId,
      name: r.stageName,
      count: Number(r.count),
      value: Number(r.value),
    }));

    const openDeals = stages.reduce((sum, s) => sum + s.count, 0);
    const pipelineValue = stages.reduce((sum, s) => sum + s.value, 0);

    return { workspaceId, openDeals, pipelineValue, currency: "USD", stages };
  }
}

export function buildDealsService(
  db: Db | null,
  companiesService: CompaniesService | null,
  pipelinesService: PipelinesService | null,
  activitiesService: ActivitiesService | null,
  auditService: AuditService | null
): DealsService | null {
  return db && companiesService && pipelinesService && activitiesService && auditService
    ? new DealsService(db, companiesService, pipelinesService, activitiesService, auditService)
    : null;
}
