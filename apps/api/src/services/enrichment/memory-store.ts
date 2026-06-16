import { randomUUID } from "node:crypto";
import {
  InsufficientCreditsError,
  type ActivationRecord,
  type EnrichmentBatch,
  type EnrichmentJob,
  type EnrichmentStore,
  type ProspectList,
  type ProspectScore,
} from "./types.js";

interface WorkspaceData {
  credits: number;
  activations: Map<string, ActivationRecord>;
  lists: Map<string, ProspectList>;
  listMembers: Map<string, Set<string>>;
  scores: Map<string, ProspectScore>;
}

/**
 * In-memory implementation — the default when DATABASE_URL is not set (local
 * dev, tests, CI). State is per-process and resets on restart. The Drizzle
 * store is used when a database is configured.
 */
export class MemoryStore implements EnrichmentStore {
  private workspaces = new Map<string, WorkspaceData>();
  private jobs = new Map<string, EnrichmentJob>();
  private batches = new Map<string, EnrichmentBatch>();

  private ws(id: string): WorkspaceData {
    let w = this.workspaces.get(id);
    if (!w) {
      w = {
        credits: 500, // seed demo credits
        activations: new Map(),
        lists: new Map(),
        listMembers: new Map(),
        scores: new Map(),
      };
      this.workspaces.set(id, w);
    }
    return w;
  }

  async getCreditBalance(workspaceId: string): Promise<number> {
    return this.ws(workspaceId).credits;
  }

  async addCredits(workspaceId: string, amount: number): Promise<number> {
    const w = this.ws(workspaceId);
    w.credits += amount;
    return w.credits;
  }

  async deductCredits(workspaceId: string, amount: number): Promise<number> {
    const w = this.ws(workspaceId);
    if (w.credits < amount) throw new InsufficientCreditsError(amount, w.credits);
    w.credits -= amount;
    return w.credits;
  }

  async upsertActivation(
    workspaceId: string,
    prospectId: string,
    companyId: string,
    snapshot: Record<string, unknown>
  ): Promise<ActivationRecord> {
    const w = this.ws(workspaceId);
    const now = new Date().toISOString();
    const existing = w.activations.get(prospectId);
    const record: ActivationRecord = existing
      ? { ...existing, snapshot: { ...existing.snapshot, ...snapshot }, companyId, updatedAt: now }
      : { id: randomUUID(), workspaceId, prospectId, companyId, snapshot, activatedAt: now, updatedAt: now };
    w.activations.set(prospectId, record);
    return record;
  }

  async listActivations(workspaceId: string): Promise<ActivationRecord[]> {
    return [...this.ws(workspaceId).activations.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt)
    );
  }

  async getActivation(workspaceId: string, prospectId: string): Promise<ActivationRecord | null> {
    return this.ws(workspaceId).activations.get(prospectId) ?? null;
  }

  async createList(workspaceId: string, name: string, prospectIds: string[]): Promise<ProspectList> {
    const w = this.ws(workspaceId);
    const list: ProspectList = {
      id: randomUUID(),
      workspaceId,
      name,
      prospectCount: prospectIds.length,
      createdAt: new Date().toISOString(),
    };
    w.lists.set(list.id, list);
    w.listMembers.set(list.id, new Set(prospectIds));
    return list;
  }

  async addListMembers(
    workspaceId: string,
    listId: string,
    prospectIds: string[]
  ): Promise<ProspectList | null> {
    const w = this.ws(workspaceId);
    const list = w.lists.get(listId);
    if (!list || list.workspaceId !== workspaceId) return null;
    const set = w.listMembers.get(listId) ?? new Set<string>();
    for (const id of prospectIds) set.add(id);
    w.listMembers.set(listId, set);
    const updated = { ...list, prospectCount: set.size };
    w.lists.set(listId, updated);
    return updated;
  }

  async listLists(workspaceId: string): Promise<ProspectList[]> {
    return [...this.ws(workspaceId).lists.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  }

  async getListMemberIds(workspaceId: string, listId: string): Promise<string[]> {
    return [...(this.ws(workspaceId).listMembers.get(listId) ?? [])];
  }

  async createJob(job: Omit<EnrichmentJob, "id">): Promise<EnrichmentJob> {
    const full: EnrichmentJob = { ...job, id: randomUUID() };
    this.jobs.set(full.id, full);
    return full;
  }

  async updateJob(id: string, patch: Partial<EnrichmentJob>): Promise<EnrichmentJob | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    const updated = { ...job, ...patch };
    this.jobs.set(id, updated);
    return updated;
  }

  async getJob(workspaceId: string, id: string): Promise<EnrichmentJob | null> {
    const job = this.jobs.get(id);
    return job && job.workspaceId === workspaceId ? job : null;
  }

  async listJobs(workspaceId: string): Promise<EnrichmentJob[]> {
    return [...this.jobs.values()]
      .filter((j) => j.workspaceId === workspaceId)
      .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
  }

  async createBatch(batch: Omit<EnrichmentBatch, "id">): Promise<EnrichmentBatch> {
    const full: EnrichmentBatch = { ...batch, id: randomUUID() };
    this.batches.set(full.id, full);
    return full;
  }

  async updateBatch(id: string, patch: Partial<EnrichmentBatch>): Promise<EnrichmentBatch | null> {
    const batch = this.batches.get(id);
    if (!batch) return null;
    const updated = { ...batch, ...patch };
    this.batches.set(id, updated);
    return updated;
  }

  async getBatch(workspaceId: string, id: string): Promise<EnrichmentBatch | null> {
    const batch = this.batches.get(id);
    return batch && batch.workspaceId === workspaceId ? batch : null;
  }

  async setScore(score: ProspectScore): Promise<ProspectScore> {
    this.ws(score.workspaceId).scores.set(score.prospectId, score);
    return score;
  }

  async getScore(workspaceId: string, prospectId: string): Promise<ProspectScore | null> {
    return this.ws(workspaceId).scores.get(prospectId) ?? null;
  }

  async getScoresForProspects(workspaceId: string, prospectIds: string[]): Promise<ProspectScore[]> {
    const w = this.ws(workspaceId);
    return prospectIds
      .map((id) => w.scores.get(id))
      .filter((s): s is ProspectScore => s != null);
  }

  async getList(workspaceId: string, listId: string): Promise<ProspectList | null> {
    const w = this.ws(workspaceId);
    const list = w.lists.get(listId);
    if (!list || list.workspaceId !== workspaceId) return null;
    const count = w.listMembers.get(listId)?.size ?? 0;
    return { ...list, prospectCount: count };
  }
}
