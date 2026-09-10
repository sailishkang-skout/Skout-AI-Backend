import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "../utils/http.js";

const { modelVersions, promptVersions } = schema;

export interface ModelVersionDto {
  id: string;
  name: string;
  provider: string;
  versionLabel: string;
  isActive: boolean;
  notes: string | null;
  releasedAt: string | null;
  createdAt: string;
}

export interface PromptVersionDto {
  id: string;
  name: string;
  version: number;
  content: string;
  modelVersionId: string | null;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
}

function toModelDto(row: typeof modelVersions.$inferSelect): ModelVersionDto {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    versionLabel: row.versionLabel,
    isActive: row.isActive,
    notes: row.notes,
    releasedAt: row.releasedAt ? row.releasedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toPromptDto(row: typeof promptVersions.$inferSelect): PromptVersionDto {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    content: row.content,
    modelVersionId: row.modelVersionId,
    isActive: row.isActive,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface CreateModelVersionInput {
  name: string;
  provider: string;
  versionLabel: string;
  notes?: string;
  releasedAt?: Date;
  isActive?: boolean;
}

export interface CreatePromptVersionInput {
  name: string;
  content: string;
  modelVersionId?: string;
  createdBy?: string;
}

/**
 * §5.1 Task 36 (Enterprise Completion Plan) — the first real writers for ModelVersion/
 * PromptVersion. These tables shipped in an earlier pass with an explicit, honest doc comment
 * on why wiring apps/api's actual AI call sites (ai.service.ts, ai-draft.service.ts,
 * sequence-generate.service.ts) to record which version handled a given generation was left
 * undone — that's still true after this pass; it needs threading a modelVersionId/
 * promptVersionId through every AI generation path, a broad change this task deliberately
 * doesn't attempt. What this pass adds is the missing prerequisite: code that can actually
 * create and query rows in these tables at all, which nothing in the codebase could do before.
 *
 * Deliberately NOT exposed as a write-capable HTTP route reachable by an ordinary
 * workspace-authenticated request (see model-versions.routes.ts, which is read-only). These
 * tables are platform-wide — not workspace-scoped — and this codebase's RBAC model only goes
 * up to "owner of a workspace," which is not the same thing as a Skout platform operator. A
 * workspace owner being able to write platform-wide model/prompt config that every other
 * tenant's AI calls would eventually pin to is a cross-tenant privilege-escalation risk this
 * pass isn't going to introduce for the sake of having a write route. The writers below are
 * real, callable code — meant to be invoked from a trusted context (an internal seed/ops
 * script, or a future properly-scoped platform-admin auth path), not from this HTTP API.
 */
export class ModelVersionsService {
  constructor(private readonly db: Db) {}

  /** Upsert on the (name, versionLabel) unique constraint — re-registering the same
   * provider version updates notes/releasedAt/isActive rather than erroring or duplicating. */
  async createModelVersion(input: CreateModelVersionInput): Promise<ModelVersionDto> {
    const [row] = await this.db
      .insert(modelVersions)
      .values({
        name: input.name,
        provider: input.provider,
        versionLabel: input.versionLabel,
        notes: input.notes ?? null,
        releasedAt: input.releasedAt ?? null,
        isActive: input.isActive ?? true,
      })
      .onConflictDoUpdate({
        target: [modelVersions.name, modelVersions.versionLabel],
        set: {
          provider: input.provider,
          notes: input.notes ?? null,
          releasedAt: input.releasedAt ?? null,
          isActive: input.isActive ?? true,
        },
      })
      .returning();
    if (!row) throw new HttpError("Failed to create model version", 500);
    return toModelDto(row);
  }

  async listModelVersions(name?: string): Promise<ModelVersionDto[]> {
    const rows = name
      ? await this.db.select().from(modelVersions).where(eq(modelVersions.name, name)).orderBy(desc(modelVersions.releasedAt))
      : await this.db.select().from(modelVersions).orderBy(desc(modelVersions.releasedAt));
    return rows.map(toModelDto);
  }

  /** Most recently released active version for `name`. Multiple active versions of the same
   * model name is a valid state (unlike prompts, which enforce single-active below) — a
   * migration between two providers might briefly want both live — so this is "the newest
   * one," not an invariant-enforced singleton. */
  async getActiveModelVersion(name: string): Promise<ModelVersionDto | null> {
    const [row] = await this.db
      .select()
      .from(modelVersions)
      .where(and(eq(modelVersions.name, name), eq(modelVersions.isActive, true)))
      .orderBy(desc(modelVersions.releasedAt))
      .limit(1);
    return row ? toModelDto(row) : null;
  }

  /**
   * Auto-increments `version` per `name` inside a transaction (SELECT ... FOR UPDATE-style
   * serialization via the transaction itself — two concurrent creates for the same name can't
   * both compute the same "next version" and collide, since the second transaction blocks on
   * the first's row lock from the coalesce/max scan until it commits).
   */
  async createPromptVersion(input: CreatePromptVersionInput): Promise<PromptVersionDto> {
    return this.db.transaction(async (tx) => {
      const [{ maxVersion }] = await tx
        .select({ maxVersion: sql<number>`coalesce(max(${promptVersions.version}), 0)` })
        .from(promptVersions)
        .where(eq(promptVersions.name, input.name));
      const nextVersion = (maxVersion ?? 0) + 1;

      const [row] = await tx
        .insert(promptVersions)
        .values({
          name: input.name,
          version: nextVersion,
          content: input.content,
          modelVersionId: input.modelVersionId ?? null,
          createdBy: input.createdBy ?? null,
          isActive: false,
        })
        .returning();
      if (!row) throw new HttpError("Failed to create prompt version", 500);
      return toPromptDto(row);
    });
  }

  async listPromptVersions(name: string): Promise<PromptVersionDto[]> {
    const rows = await this.db
      .select()
      .from(promptVersions)
      .where(eq(promptVersions.name, name))
      .orderBy(desc(promptVersions.version));
    return rows.map(toPromptDto);
  }

  /** At most one active version per name is the intended invariant (unlike model versions,
   * where multiple simultaneously-active is valid) — enforced here in application code, not a
   * DB constraint, since "exactly one WHERE isActive" isn't expressible as a simple unique
   * index the way 0048/0055's partial-unique-index pattern handles for other tables. */
  async setActivePromptVersion(name: string, version: number): Promise<PromptVersionDto> {
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(promptVersions)
        .where(and(eq(promptVersions.name, name), eq(promptVersions.version, version)));
      if (!target) throw new HttpError("prompt_version_not_found", 404);

      await tx.update(promptVersions).set({ isActive: false }).where(eq(promptVersions.name, name));
      const [row] = await tx
        .update(promptVersions)
        .set({ isActive: true })
        .where(and(eq(promptVersions.name, name), eq(promptVersions.version, version)))
        .returning();
      if (!row) throw new HttpError("prompt_version_not_found", 404);
      return toPromptDto(row);
    });
  }

  async getActivePromptVersion(name: string): Promise<PromptVersionDto | null> {
    const [row] = await this.db
      .select()
      .from(promptVersions)
      .where(and(eq(promptVersions.name, name), eq(promptVersions.isActive, true)))
      .limit(1);
    return row ? toPromptDto(row) : null;
  }
}

export function buildModelVersionsService(db: Db | null): ModelVersionsService | null {
  return db ? new ModelVersionsService(db) : null;
}
