import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { PipelineCreateInput, PipelineStageCreateInput } from "@skout/shared";
import { HttpError } from "@skout/auth";
import { pgErrorCode } from "../utils/http.js";

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
  constructor(private readonly db: Db) {}

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
    const rows = await this.db.select().from(pipelines).where(eq(pipelines.workspaceId, workspaceId));
    return Promise.all(rows.map((row) => this.withStages(row)));
  }

  async getById(workspaceId: string, id: string): Promise<PipelineDto | null> {
    const [row] = await this.db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.id, id), eq(pipelines.workspaceId, workspaceId)))
      .limit(1);
    return row ? this.withStages(row) : null;
  }

  async create(workspaceId: string, input: PipelineCreateInput): Promise<PipelineDto> {
    const [row] = await this.db.insert(pipelines).values({ workspaceId, name: input.name }).returning();
    return this.withStages(row);
  }

  async addStage(workspaceId: string, pipelineId: string, input: PipelineStageCreateInput): Promise<PipelineStageDto> {
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
        throw new HttpError("stage_order_conflict", 409, { orderIndex: input.orderIndex });
      }
      throw err;
    }
    return stageToDto(row);
  }

  /** Idempotent: returns the workspace's default pipeline, creating it + standard stages if none exists yet. */
  async ensureDefaultPipeline(workspaceId: string): Promise<PipelineDto> {
    const [existing] = await this.db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.workspaceId, workspaceId), eq(pipelines.isDefault, true)))
      .limit(1);
    if (existing) return this.withStages(existing);

    return this.db.transaction(async (tx) => {
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
  }
}

export function buildPipelinesService(db: Db | null): PipelinesService | null {
  return db ? new PipelinesService(db) : null;
}
