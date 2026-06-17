import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { FieldResult, AttemptLog, AttemptStatus } from "@skout/pal";
import {
  InsufficientCreditsError,
  type ActivationRecord,
  type EnrichmentBatch,
  type EnrichmentJob,
  type EnrichmentStore,
  type JobStatus,
  type ProspectList,
  type ProspectScore,
} from "./types.js";

const {
  creditBalances,
  creditTransactions,
  prospectActivations,
  lists,
  listMembers,
  enrichmentJobs,
  enrichmentResults,
  enrichmentAttempts,
  enrichmentBatches,
  prospectScores,
} = schema;

/** Drizzle/PostgreSQL implementation — used when DATABASE_URL is configured. */
export class DbStore implements EnrichmentStore {
  constructor(private readonly db: Db) {}

  async getCreditBalance(workspaceId: string): Promise<number> {
    const [row] = await this.db
      .select()
      .from(creditBalances)
      .where(eq(creditBalances.workspaceId, workspaceId));
    return row?.balance ?? 0;
  }

  async addCredits(workspaceId: string, amount: number, action: string, ref?: string): Promise<number> {
    const current = await this.getCreditBalance(workspaceId);
    const next = current + amount;
    await this.db
      .insert(creditBalances)
      .values({ workspaceId, balance: next })
      .onConflictDoUpdate({ target: creditBalances.workspaceId, set: { balance: next, updatedAt: new Date() } });
    await this.db.insert(creditTransactions).values({ workspaceId, amount, action, referenceId: ref });
    return next;
  }

  async deductCredits(workspaceId: string, amount: number, action: string, ref?: string): Promise<number> {
    const current = await this.getCreditBalance(workspaceId);
    if (current < amount) throw new InsufficientCreditsError(amount, current);
    return this.addCredits(workspaceId, -amount, action, ref);
  }

  async upsertActivation(
    workspaceId: string,
    prospectId: string,
    companyId: string,
    snapshot: Record<string, unknown>
  ): Promise<ActivationRecord> {
    const [row] = await this.db
      .insert(prospectActivations)
      .values({ workspaceId, prospectId, companyId, snapshot })
      .onConflictDoUpdate({
        target: [prospectActivations.workspaceId, prospectActivations.prospectId],
        set: { snapshot, companyId, updatedAt: new Date() },
      })
      .returning();
    return this.toActivation(row);
  }

  async listActivations(workspaceId: string): Promise<ActivationRecord[]> {
    const rows = await this.db
      .select()
      .from(prospectActivations)
      .where(eq(prospectActivations.workspaceId, workspaceId))
      .orderBy(desc(prospectActivations.updatedAt));
    return rows.map((r) => this.toActivation(r));
  }

  async getActivation(workspaceId: string, prospectId: string): Promise<ActivationRecord | null> {
    const [row] = await this.db
      .select()
      .from(prospectActivations)
      .where(
        and(eq(prospectActivations.workspaceId, workspaceId), eq(prospectActivations.prospectId, prospectId))
      );
    return row ? this.toActivation(row) : null;
  }

  async createList(workspaceId: string, name: string, prospectIds: string[]): Promise<ProspectList> {
    const [row] = await this.db.insert(lists).values({ workspaceId, name }).returning();
    if (prospectIds.length) {
      await this.db
        .insert(listMembers)
        .values(prospectIds.map((prospectId) => ({ listId: row.id, prospectId })))
        .onConflictDoNothing();
    }
    return {
      id: row.id,
      workspaceId,
      name: row.name,
      prospectCount: prospectIds.length,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async addListMembers(
    workspaceId: string,
    listId: string,
    prospectIds: string[]
  ): Promise<ProspectList | null> {
    const [list] = await this.db
      .select()
      .from(lists)
      .where(and(eq(lists.id, listId), eq(lists.workspaceId, workspaceId)));
    if (!list) return null;
    if (prospectIds.length) {
      await this.db
        .insert(listMembers)
        .values(prospectIds.map((prospectId) => ({ listId, prospectId })))
        .onConflictDoNothing();
    }
    const members = await this.db.select().from(listMembers).where(eq(listMembers.listId, listId));
    return {
      id: list.id,
      workspaceId,
      name: list.name,
      prospectCount: members.length,
      createdAt: list.createdAt.toISOString(),
    };
  }

  async listLists(workspaceId: string): Promise<ProspectList[]> {
    const rows = await this.db
      .select()
      .from(lists)
      .where(eq(lists.workspaceId, workspaceId))
      .orderBy(desc(lists.createdAt));
    const out: ProspectList[] = [];
    for (const r of rows) {
      const members = await this.db.select().from(listMembers).where(eq(listMembers.listId, r.id));
      out.push({
        id: r.id,
        workspaceId,
        name: r.name,
        prospectCount: members.length,
        createdAt: r.createdAt.toISOString(),
      });
    }
    return out;
  }

  async renameList(workspaceId: string, listId: string, name: string): Promise<ProspectList | null> {
    const [row] = await this.db
      .update(lists)
      .set({ name, updatedAt: new Date() })
      .where(and(eq(lists.id, listId), eq(lists.workspaceId, workspaceId)))
      .returning();
    if (!row) return null;
    const members = await this.db.select().from(listMembers).where(eq(listMembers.listId, listId));
    return { id: row.id, workspaceId, name: row.name, prospectCount: members.length, createdAt: row.createdAt.toISOString() };
  }

  async deleteList(workspaceId: string, listId: string): Promise<boolean> {
    const result = await this.db
      .delete(lists)
      .where(and(eq(lists.id, listId), eq(lists.workspaceId, workspaceId)))
      .returning({ id: lists.id });
    return result.length > 0;
  }

  async removeMembersFromList(workspaceId: string, listId: string, prospectIds: string[]): Promise<ProspectList | null> {
    const [list] = await this.db
      .select()
      .from(lists)
      .where(and(eq(lists.id, listId), eq(lists.workspaceId, workspaceId)));
    if (!list) return null;
    await this.db
      .delete(listMembers)
      .where(and(eq(listMembers.listId, listId), inArray(listMembers.prospectId, prospectIds)));
    const members = await this.db.select().from(listMembers).where(eq(listMembers.listId, listId));
    return { id: list.id, workspaceId, name: list.name, prospectCount: members.length, createdAt: list.createdAt.toISOString() };
  }

  async getListMemberIds(workspaceId: string, listId: string): Promise<string[]> {
    const [list] = await this.db
      .select()
      .from(lists)
      .where(and(eq(lists.id, listId), eq(lists.workspaceId, workspaceId)));
    if (!list) return [];
    const rows = await this.db.select().from(listMembers).where(eq(listMembers.listId, listId));
    return rows.map((r) => r.prospectId);
  }

  async createJob(job: Omit<EnrichmentJob, "id">): Promise<EnrichmentJob> {
    const [row] = await this.db
      .insert(enrichmentJobs)
      .values({
        workspaceId: job.workspaceId,
        prospectId: job.prospectId,
        activationId: job.activationId!,
        batchId: job.batchId ?? undefined,
        status: job.status,
        trigger: job.trigger,
        fieldsRequested: job.fieldsRequested,
        creditsUsed: job.creditsUsed,
      })
      .returning();
    return { ...job, id: row.id };
  }

  async updateJob(id: string, patch: Partial<EnrichmentJob>): Promise<EnrichmentJob | null> {
    const set: Record<string, unknown> = {};
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.creditsUsed !== undefined) set.creditsUsed = patch.creditsUsed;
    if (patch.errorMessage !== undefined) set.errorMessage = patch.errorMessage;
    if (patch.startedAt !== undefined) set.startedAt = patch.startedAt ? new Date(patch.startedAt) : null;
    if (patch.completedAt !== undefined) set.completedAt = patch.completedAt ? new Date(patch.completedAt) : null;

    if (Object.keys(set).length) {
      await this.db.update(enrichmentJobs).set(set).where(eq(enrichmentJobs.id, id));
    }

    if (patch.results !== undefined) {
      const [job] = await this.db.select().from(enrichmentJobs).where(eq(enrichmentJobs.id, id));
      if (job) {
        await this.db.delete(enrichmentResults).where(eq(enrichmentResults.enrichmentJobId, id));
        if (patch.results.length) {
          await this.db.insert(enrichmentResults).values(
            patch.results.map((r) => this.toResultRow(id, job.workspaceId, job.prospectId, r))
          );
        }
      }
    }

    if (patch.attempts !== undefined) {
      await this.db.delete(enrichmentAttempts).where(eq(enrichmentAttempts.enrichmentJobId, id));
      if (patch.attempts.length) {
        await this.db.insert(enrichmentAttempts).values(
          patch.attempts.map((a) => ({
            enrichmentJobId: id,
            attemptOrder: a.order,
            provider: a.provider,
            operation: a.operation,
            status: a.status,
            latencyMs: a.latencyMs,
            errorMessage: a.detail ?? null,
            requestInput: {},
            completedAt: new Date(),
          }))
        );
      }
    }

    const [updated] = await this.db.select().from(enrichmentJobs).where(eq(enrichmentJobs.id, id));
    return updated
      ? this.toJob(updated, await this.loadResults(id), await this.loadAttempts(id))
      : null;
  }

  async getJob(workspaceId: string, id: string): Promise<EnrichmentJob | null> {
    const [row] = await this.db
      .select()
      .from(enrichmentJobs)
      .where(and(eq(enrichmentJobs.id, id), eq(enrichmentJobs.workspaceId, workspaceId)));
    return row ? this.toJob(row, await this.loadResults(id), await this.loadAttempts(id)) : null;
  }

  async listJobs(workspaceId: string): Promise<EnrichmentJob[]> {
    const rows = await this.db
      .select()
      .from(enrichmentJobs)
      .where(eq(enrichmentJobs.workspaceId, workspaceId))
      .orderBy(desc(enrichmentJobs.queuedAt));
    return Promise.all(
      rows.map(async (row) => this.toJob(row, await this.loadResults(row.id), await this.loadAttempts(row.id)))
    );
  }

  async createBatch(batch: Omit<EnrichmentBatch, "id">): Promise<EnrichmentBatch> {
    const [row] = await this.db
      .insert(enrichmentBatches)
      .values({
        workspaceId: batch.workspaceId,
        listId: batch.listId ?? undefined,
        total: batch.total,
        done: batch.done,
        failed: batch.failed,
        status: batch.status,
      })
      .returning();
    return { ...batch, id: row.id };
  }

  async updateBatch(id: string, patch: Partial<EnrichmentBatch>): Promise<EnrichmentBatch | null> {
    const set: Record<string, unknown> = {};
    if (patch.done !== undefined) set.done = patch.done;
    if (patch.failed !== undefined) set.failed = patch.failed;
    if (patch.status !== undefined) set.status = patch.status;
    if (Object.keys(set).length) {
      await this.db.update(enrichmentBatches).set(set).where(eq(enrichmentBatches.id, id));
    }
    const [row] = await this.db.select().from(enrichmentBatches).where(eq(enrichmentBatches.id, id));
    return row ? this.toBatch(row) : null;
  }

  async getBatch(workspaceId: string, id: string): Promise<EnrichmentBatch | null> {
    const [row] = await this.db
      .select()
      .from(enrichmentBatches)
      .where(and(eq(enrichmentBatches.id, id), eq(enrichmentBatches.workspaceId, workspaceId)));
    if (!row) return null;
    const jobs = await this.db.select().from(enrichmentJobs).where(eq(enrichmentJobs.batchId, id));
    return { ...this.toBatch(row), jobIds: jobs.map((j) => j.id) };
  }

  async setScore(score: ProspectScore): Promise<ProspectScore> {
    await this.db
      .insert(prospectScores)
      .values({
        workspaceId: score.workspaceId,
        prospectId: score.prospectId,
        score: score.score,
        reasoning: score.reasoning,
        priority: score.priority,
      })
      .onConflictDoUpdate({
        target: [prospectScores.workspaceId, prospectScores.prospectId],
        set: { score: score.score, reasoning: score.reasoning, priority: score.priority, scoredAt: new Date() },
      });
    return score;
  }

  async getScore(workspaceId: string, prospectId: string): Promise<ProspectScore | null> {
    const [row] = await this.db
      .select()
      .from(prospectScores)
      .where(and(eq(prospectScores.workspaceId, workspaceId), eq(prospectScores.prospectId, prospectId)));
    return row
      ? {
          workspaceId,
          prospectId,
          score: row.score,
          priority: row.priority,
          reasoning: row.reasoning,
          scoredAt: row.scoredAt.toISOString(),
        }
      : null;
  }

  async getScoresForProspects(workspaceId: string, prospectIds: string[]): Promise<ProspectScore[]> {
    if (!prospectIds.length) return [];
    const rows = await this.db
      .select()
      .from(prospectScores)
      .where(
        and(eq(prospectScores.workspaceId, workspaceId), inArray(prospectScores.prospectId, prospectIds))
      );
    return rows.map((row) => ({
      workspaceId,
      prospectId: row.prospectId,
      score: row.score,
      priority: row.priority,
      reasoning: row.reasoning,
      scoredAt: row.scoredAt.toISOString(),
    }));
  }

  async getList(workspaceId: string, listId: string): Promise<ProspectList | null> {
    const [list] = await this.db
      .select()
      .from(lists)
      .where(and(eq(lists.id, listId), eq(lists.workspaceId, workspaceId)));
    if (!list) return null;
    const members = await this.db.select().from(listMembers).where(eq(listMembers.listId, listId));
    return {
      id: list.id,
      workspaceId,
      name: list.name,
      prospectCount: members.length,
      createdAt: list.createdAt.toISOString(),
    };
  }

  // --- mappers -------------------------------------------------------------

  private async loadAttempts(jobId: string): Promise<AttemptLog[]> {
    const rows = await this.db
      .select()
      .from(enrichmentAttempts)
      .where(eq(enrichmentAttempts.enrichmentJobId, jobId))
      .orderBy(enrichmentAttempts.attemptOrder);
    return rows.map((r) => ({
      order: r.attemptOrder,
      provider: r.provider,
      operation: r.operation,
      status: r.status as AttemptStatus,
      latencyMs: r.latencyMs ?? 0,
      detail: r.errorMessage ?? undefined,
    }));
  }

  private async loadResults(jobId: string): Promise<FieldResult[]> {
    const rows = await this.db
      .select()
      .from(enrichmentResults)
      .where(eq(enrichmentResults.enrichmentJobId, jobId));
    return rows.map((r) => ({
      field: r.fieldName,
      value: r.fieldValue ?? undefined,
      valueJson: r.fieldValueJson ?? undefined,
      provider: r.sourceProvider,
      confidence: r.confidence ? Number(r.confidence) : undefined,
      validationStatus: r.validationStatus ?? undefined,
      isPrimary: r.isPrimary,
    }));
  }

  private toResultRow(
    jobId: string,
    workspaceId: string,
    prospectId: string,
    r: FieldResult
  ) {
    return {
      enrichmentJobId: jobId,
      workspaceId,
      prospectId,
      fieldName: r.field,
      fieldValue: r.value ?? null,
      fieldValueJson: r.valueJson ?? null,
      sourceProvider: r.provider,
      confidence: r.confidence != null ? r.confidence.toFixed(4) : null,
      validationStatus: r.validationStatus ?? null,
      isPrimary: r.isPrimary ?? false,
    };
  }

  private toActivation(row: typeof prospectActivations.$inferSelect): ActivationRecord {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      prospectId: row.prospectId,
      companyId: row.companyId,
      snapshot: (row.snapshot ?? {}) as Record<string, unknown>,
      activatedAt: row.activatedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toJob(
    row: typeof enrichmentJobs.$inferSelect,
    results: FieldResult[],
    attempts: EnrichmentJob["attempts"] = []
  ): EnrichmentJob {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      prospectId: row.prospectId,
      activationId: row.activationId,
      batchId: row.batchId ?? null,
      status: row.status as JobStatus,
      trigger: row.trigger,
      fieldsRequested: row.fieldsRequested,
      results,
      attempts,
      creditsUsed: row.creditsUsed,
      errorMessage: row.errorMessage ?? null,
      queuedAt: row.queuedAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }

  private toBatch(row: typeof enrichmentBatches.$inferSelect): EnrichmentBatch {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      listId: row.listId ?? null,
      total: row.total,
      done: row.done,
      failed: row.failed,
      status: row.status as JobStatus,
      jobIds: [],
      createdAt: row.createdAt.toISOString(),
    };
  }
}
