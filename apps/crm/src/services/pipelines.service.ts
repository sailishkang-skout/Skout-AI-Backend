import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { PipelineCreateInput, PipelineStageCreateInput, PipelineUpdateInput } from "@skout/shared";
import { HttpError } from "@skout/auth";
import { pgErrorCode } from "../utils/http.js";
import type { AuditService } from "./audit.service.js";
import { logAndCapture, serviceLog } from "../lib/obs.js";

const log = serviceLog("pipelines");
const { pipelines, pipelineStages } = schema;

export interface PipelineStageDto {
  id: string;
  pipelineId: string;
  name: string;
  orderIndex: number;
  probability: number;
  isClosedWon: boolean;
  isClosedLost: boolean;
}

export interface PipelineDto {
  id: string;
  workspaceId: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  stages: PipelineStageDto[];
}

const DEFAULT_STAGES: Omit<PipelineStageCreateInput, "orderIndex">[] = [
  { name: "New", probability: 10, isClosedWon: false, isClosedLost: false },
  { name: "Qualified", probability: 25, isClosedWon: false, isClosedLost: false },
  { name: "Proposal", probability: 50, isClosedWon: false, isClosedLost: false },
  { name: "Negotiation", probability: 75, isClosedWon: false, isClosedLost: false },
  { name: "Closed Won", probability: 100, isClosedWon: true, isClosedLost: false },
  { name: "Closed Lost", probability: 0, isClosedWon: false, isClosedLost: true },
];

function stageToDto(row: typeof pipelineStages.$inferSelect): PipelineStageDto {
  return {
    id: row.id,
    pipelineId: row.pipelineId,
    name: row.name,
    orderIndex: row.orderIndex,
    probability: row.probability,
    isClosedWon: row.isClosedWon,
    isClosedLost: row.isClosedLost,
  };
}

export class PipelinesService {
  constructor(
    private readonly db: Db,
    private readonly auditService: AuditService
  ) {}

  private async withStages(row: typeof pipelines.$inferSelect): Promise<PipelineDto> {
    const stageRows = await this.db
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, row.id))
      .orderBy(asc(pipelineStages.orderIndex));
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      isDefault: row.isDefault,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      stages: stageRows.map(stageToDto),
    };
  }

  async list(workspaceId: string): Promise<PipelineDto[]> {
    await this.ensureDefaultPipeline(workspaceId);
    const rows = await this.db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.workspaceId, workspaceId), isNull(pipelines.deletedAt)));
    return Promise.all(rows.map((row) => this.withStages(row)));
  }

  async getById(workspaceId: string, id: string): Promise<PipelineDto | null> {
    const [row] = await this.db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.id, id), eq(pipelines.workspaceId, workspaceId), isNull(pipelines.deletedAt)))
      .limit(1);
    return row ? this.withStages(row) : null;
  }

  async create(workspaceId: string, actorId: string | undefined, input: PipelineCreateInput): Promise<PipelineDto> {
    const [row] = await this.db.insert(pipelines).values({ workspaceId, name: input.name }).returning();
    const dto = await this.withStages(row);
    await this.auditService.record(workspaceId, actorId, "create", "pipeline", dto.id, null, dto);
    log.info("pipeline created", { workspaceId, pipelineId: row.id, name: row.name });
    return dto;
  }

  async addStage(
    workspaceId: string,
    pipelineId: string,
    input: PipelineStageCreateInput,
    actorId?: string
  ): Promise<PipelineStageDto> {
    const pipeline = await this.getById(workspaceId, pipelineId);
    if (!pipeline) throw new HttpError("pipeline_not_found", 404);

    let row: typeof pipelineStages.$inferSelect;
    try {
      [row] = await this.db
        .insert(pipelineStages)
        .values({
          pipelineId,
          name: input.name,
          orderIndex: input.orderIndex,
          probability: input.probability,
          isClosedWon: input.isClosedWon,
          isClosedLost: input.isClosedLost,
        })
        .returning();
    } catch (err) {
      // Postgres unique_violation on (pipeline_id, order_index) — surface as a clean
      // conflict instead of letting the raw DB error bubble up as a 500.
      if (pgErrorCode(err) === "23505") {
        log.warn("pipeline stage order conflict", { workspaceId, pipelineId, orderIndex: input.orderIndex });
        throw new HttpError("stage_order_conflict", 409, { orderIndex: input.orderIndex });
      }
      logAndCapture(log, err, "pipeline stage create failed", { workspaceId, pipelineId });
      throw err;
    }
    const dto = stageToDto(row);
    await this.auditService.record(workspaceId, actorId, "create", "pipeline_stage", dto.id, null, dto);
    log.info("pipeline stage added", { workspaceId, pipelineId, stageId: row.id, name: row.name });
    return dto;
  }

  async update(
    workspaceId: string,
    id: string,
    actorId: string | undefined,
    input: PipelineUpdateInput
  ): Promise<PipelineDto | null> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return null;

    const [row] = await this.db
      .update(pipelines)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(pipelines.id, id), eq(pipelines.workspaceId, workspaceId)))
      .returning();

    if (!row) return null;
    const dto = await this.withStages(row);
    await this.auditService.record(workspaceId, actorId, "update", "pipeline", id, existing, dto);
    log.info("pipeline updated", { workspaceId, pipelineId: id });
    return dto;
  }

  async softDelete(workspaceId: string, id: string, actorId: string | undefined): Promise<boolean> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return false;

    const [row] = await this.db
      .update(pipelines)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(pipelines.id, id), eq(pipelines.workspaceId, workspaceId)))
      .returning();

    if (!row) return false;
    const dto = await this.withStages(row);
    await this.auditService.record(workspaceId, actorId, "delete", "pipeline", id, existing, dto);
    log.info("pipeline soft-deleted", { workspaceId, pipelineId: id });
    return true;
  }

  /** Idempotent: returns the workspace's default pipeline, creating it + standard stages if none exists yet. */
  async ensureDefaultPipeline(workspaceId: string): Promise<PipelineDto> {
    const [existing] = await this.db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.workspaceId, workspaceId), eq(pipelines.isDefault, true)))
      .limit(1);
    if (existing) return this.withStages(existing);

    const created = await this.db.transaction(async (tx) => {
      const [pipeline] = await tx
        .insert(pipelines)
        .values({ workspaceId, name: "Sales Pipeline", isDefault: true })
        .returning();

      const stageRows = await tx
        .insert(pipelineStages)
        .values(
          DEFAULT_STAGES.map((stage, index) => ({
            pipelineId: pipeline.id,
            name: stage.name,
            orderIndex: index,
            probability: stage.probability,
            isClosedWon: stage.isClosedWon,
            isClosedLost: stage.isClosedLost,
          }))
        )
        .returning();

      return {
        id: pipeline.id,
        workspaceId: pipeline.workspaceId,
        name: pipeline.name,
        isDefault: pipeline.isDefault,
        createdAt: pipeline.createdAt.toISOString(),
        updatedAt: pipeline.updatedAt.toISOString(),
        stages: stageRows
          .sort((a, b) => a.orderIndex - b.orderIndex)
          .map(stageToDto),
      };
    });
    log.info("default pipeline ensured", { workspaceId, pipelineId: created.id });
    return created;
  }
}

export function buildPipelinesService(db: Db | null, auditService: AuditService | null): PipelinesService | null {
  return db && auditService ? new PipelinesService(db, auditService) : null;
}
