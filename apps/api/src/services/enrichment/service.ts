import { EnrichmentEngine, type EnrichField } from "@skout/pal";
import { generateCompanyId, generateProspectId } from "@skout/shared";
import { scoreProspect, type IcpConfig, type ScoreInput } from "./ai-client.js";
import {
  InsufficientCreditsError,
  type EnrichmentBatch,
  type EnrichmentJob,
  type EnrichmentStore,
  type ListDetail,
  type ProspectList,
  type ProspectScore,
} from "./types.js";
import { HttpError } from "../../utils/http.js";
import { isIcpConfigured } from "../icp.service.js";

export interface ProspectSnapshot {
  prospectId?: string;
  companyId?: string;
  fullName?: string;
  title?: string;
  seniority?: string;
  industry?: string;
  country?: string;
  companyDomain: string;
  email?: string;
  linkedinUrl?: string;
  employeeCount?: number;
  signals?: string[];
}

export interface EnrichOptions {
  fields?: EnrichField[];
  trigger?: string;
  batchId?: string;
  icp?: IcpConfig;
}

function inferSeniorityFromTitle(title?: string): string | undefined {
  if (!title?.trim()) return undefined;
  const t = title.toLowerCase();
  if (/\b(cto|ceo|cfo|coo|chief|founder|president|vp|vice president|director|head of)\b/.test(t)) {
    return "Executive";
  }
  if (/\bmanager|lead\b/.test(t)) return "Manager";
  return undefined;
}

function scoreSnapshot(snapshot: ProspectSnapshot): ProspectSnapshot {
  return {
    ...snapshot,
    seniority: snapshot.seniority ?? inferSeniorityFromTitle(snapshot.title),
  };
}

/**
 * Orchestrates Tier-2 activation: activate → score → PAL waterfall → persist,
 * with credit gating and the phone score-gate (strategy §8). Storage and
 * scoring are injected so it works with or without a DB / AI service.
 */
export class EnrichmentService {
  constructor(
    private readonly store: EnrichmentStore,
    private readonly resolveEngine: (workspaceId: string) => Promise<EnrichmentEngine>,
    private readonly aiServiceUrl?: string,
    private readonly aiTimeoutMs?: number,
    private readonly loadIcp?: (workspaceId: string) => Promise<IcpConfig>,
    private readonly beforeWrite?: (workspaceId: string) => Promise<void>
  ) {}

  private async prepareWorkspace(workspaceId: string): Promise<void> {
    if (this.beforeWrite) await this.beforeWrite(workspaceId);
  }

  private resolveIds(s: ProspectSnapshot) {
    const companyId = s.companyId ?? generateCompanyId(s.companyDomain);
    const prospectId =
      s.prospectId ?? (s.email ? generateProspectId(s.companyDomain, s.email) : generateCompanyId(`${s.companyDomain}:${s.fullName ?? ""}`));
    return { companyId, prospectId };
  }

  /** Stable id from domain/name/email — used to link scores across URL aliases (e.g. domain as id). */
  private scoreProspectId(snapshot: ProspectSnapshot): string {
    return this.resolveIds({ ...snapshot, prospectId: undefined }).prospectId;
  }

  private async getStoredScore(workspaceId: string, snapshot: ProspectSnapshot) {
    const { prospectId } = this.resolveIds(snapshot);
    const contentId = this.scoreProspectId(snapshot);
    return (
      (await this.store.getScore(workspaceId, prospectId)) ??
      (contentId !== prospectId ? await this.store.getScore(workspaceId, contentId) : null)
    );
  }

  /** Add corpus prospects to the workspace (OLTP activation). No external spend. */
  async activate(workspaceId: string, prospects: ProspectSnapshot[]): Promise<number> {
    await this.prepareWorkspace(workspaceId);
    for (const p of prospects) {
      const { companyId, prospectId } = this.resolveIds(p);
      await this.store.upsertActivation(workspaceId, prospectId, companyId, { ...p, prospectId, companyId });
    }
    return prospects.length;
  }

  async createList(workspaceId: string, name: string, prospects: ProspectSnapshot[]): Promise<ProspectList> {
    await this.activate(workspaceId, prospects);
    const ids = prospects.map((p) => this.resolveIds(p).prospectId);
    return this.store.createList(workspaceId, name, ids);
  }

  async addListMembers(
    workspaceId: string,
    listId: string,
    prospects: ProspectSnapshot[]
  ): Promise<ProspectList | null> {
    await this.activate(workspaceId, prospects);
    const ids = prospects.map((p) => this.resolveIds(p).prospectId);
    return this.store.addListMembers(workspaceId, listId, ids);
  }

  async listActivations(workspaceId: string) {
    return this.store.listActivations(workspaceId);
  }

  async listLists(workspaceId: string) {
    return this.store.listLists(workspaceId);
  }

  async renameList(workspaceId: string, listId: string, name: string) {
    return this.store.renameList(workspaceId, listId, name);
  }

  async deleteList(workspaceId: string, listId: string) {
    return this.store.deleteList(workspaceId, listId);
  }

  async removeMembersFromList(workspaceId: string, listId: string, prospectIds: string[]) {
    return this.store.removeMembersFromList(workspaceId, listId, prospectIds);
  }

  async getCredits(workspaceId: string) {
    return this.store.getCreditBalance(workspaceId);
  }

  async score(workspaceId: string, snapshot: ProspectSnapshot, icp?: IcpConfig) {
    const { prospectId } = this.resolveIds(snapshot);
    const resolvedIcp = icp ?? (this.loadIcp ? await this.loadIcp(workspaceId) : {});
    if (!isIcpConfigured(resolvedIcp)) {
      throw new HttpError("ICP_NOT_CONFIGURED", 400);
    }
    const scored = scoreSnapshot(snapshot);
    const input: ScoreInput = {
      prospectId,
      title: scored.title,
      seniority: scored.seniority,
      industry: scored.industry,
      country: scored.country,
      employeeCount: scored.employeeCount,
      companyDomain: scored.companyDomain,
      signals: scored.signals,
    };
    const result = await scoreProspect(this.aiServiceUrl, input, resolvedIcp, this.aiTimeoutMs);
    await this.store.setScore({
      workspaceId,
      prospectId,
      score: result.icpScore,
      priority: result.outreachReadiness,
      reasoning: result.reasoning,
      scoredAt: new Date().toISOString(),
    });
    return result;
  }

  /**
   * Enrich a single prospect. Activates if needed, scores (for the phone gate),
   * runs the PAL waterfall, deducts credits, and persists results.
   */
  async enrichProspect(
    workspaceId: string,
    snapshot: ProspectSnapshot,
    opts: EnrichOptions = {}
  ): Promise<EnrichmentJob> {
    await this.prepareWorkspace(workspaceId);
    const { companyId, prospectId } = this.resolveIds(snapshot);

    // Activate first so the job has an activation to attach to.
    const activation = await this.store.upsertActivation(workspaceId, prospectId, companyId, {
      ...snapshot,
      prospectId,
      companyId,
    });

    // Credit pre-check (need at least one outcome's worth).
    const balance = await this.store.getCreditBalance(workspaceId);
    if (balance < 1) throw new InsufficientCreditsError(1, balance);

    const fields = opts.fields ?? ["company", "email", "validation"];
    const job = await this.store.createJob({
      workspaceId,
      prospectId,
      activationId: activation.id,
      batchId: opts.batchId ?? null,
      status: "running",
      trigger: opts.trigger ?? "manual",
      fieldsRequested: fields,
      results: [],
      creditsUsed: 0,
      errorMessage: null,
      queuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
    });

    try {
      const icp = opts.icp ?? (this.loadIcp ? await this.loadIcp(workspaceId) : {});
      const scoredSnapshot = scoreSnapshot(snapshot);
      const existingScore = await this.getStoredScore(workspaceId, snapshot);
      let leadScore =
        existingScore?.score ?? (await this.score(workspaceId, scoredSnapshot, icp)).icpScore;

      const engine = await this.resolveEngine(workspaceId);
      const outcome = await engine.enrich({
        prospectId,
        companyDomain: snapshot.companyDomain,
        fullName: snapshot.fullName,
        title: snapshot.title,
        email: snapshot.email,
        linkedinUrl: snapshot.linkedinUrl,
        leadScore,
        fields,
        resolveLeadScoreForPhone: fields.includes("phone")
          ? async (company) => {
              if (company) {
                const enriched: ProspectSnapshot = {
                  ...scoredSnapshot,
                  industry: scoredSnapshot.industry ?? company.industry,
                  country: scoredSnapshot.country ?? company.hqCountry,
                  employeeCount: scoredSnapshot.employeeCount ?? company.employeeCount,
                };
                const addsData =
                  enriched.industry !== scoredSnapshot.industry ||
                  enriched.country !== scoredSnapshot.country ||
                  enriched.employeeCount !== scoredSnapshot.employeeCount;
                if (addsData) {
                  const result = await this.score(workspaceId, enriched, icp);
                  leadScore = result.icpScore;
                  return result.icpScore;
                }
              }
              return leadScore;
            }
          : undefined,
      });

      if (outcome.creditsUsed > 0) {
        await this.store.deductCredits(workspaceId, outcome.creditsUsed, "enrichment", job.id);
      }

      // Fold enriched primary fields back into the activation snapshot.
      const enriched: Record<string, unknown> = {};
      for (const r of outcome.results) {
        if (r.field === "email" && r.isPrimary) enriched.email = r.value;
        if (r.field === "email_status") enriched.emailStatus = r.value;
        if (r.field === "phone" && r.isPrimary) enriched.phone = r.value;
        if (r.field === "company") enriched.company = r.valueJson;
      }
      if (Object.keys(enriched).length) {
        await this.store.upsertActivation(workspaceId, prospectId, companyId, enriched);
      }

      return (
        (await this.store.updateJob(job.id, {
          status: "completed",
          results: outcome.results,
          creditsUsed: outcome.creditsUsed,
          attempts: outcome.attempts,
          completedAt: new Date().toISOString(),
        })) ?? job
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return (
        (await this.store.updateJob(job.id, {
          status: "failed",
          errorMessage: message,
          completedAt: new Date().toISOString(),
        })) ?? job
      );
    }
  }

  async getJob(workspaceId: string, jobId: string) {
    return this.store.getJob(workspaceId, jobId);
  }

  async listJobs(workspaceId: string) {
    return this.store.listJobs(workspaceId);
  }

  /** Bulk-enrich every activated member of a list under one batch. */
  async enrichList(workspaceId: string, listId: string, opts: EnrichOptions = {}): Promise<EnrichmentBatch> {
    const memberIds = await this.store.getListMemberIds(workspaceId, listId);
    const batch = await this.store.createBatch({
      workspaceId,
      listId,
      total: memberIds.length,
      done: 0,
      failed: 0,
      status: "running",
      jobIds: [],
      createdAt: new Date().toISOString(),
    });

    let done = 0;
    let failed = 0;
    for (const prospectId of memberIds) {
      const activation = await this.store.getActivation(workspaceId, prospectId);
      if (!activation) {
        failed += 1;
        continue;
      }
      const snap = activation.snapshot as Partial<ProspectSnapshot>;
      try {
        const job = await this.enrichProspect(
          workspaceId,
          { ...snap, companyDomain: snap.companyDomain ?? "", prospectId },
          { ...opts, batchId: batch.id, trigger: "bulk" }
        );
        if (job.status === "completed") done += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
      await this.store.updateBatch(batch.id, { done, failed });
    }

    return (
      (await this.store.updateBatch(batch.id, {
        done,
        failed,
        status: failed === memberIds.length && memberIds.length > 0 ? "failed" : "completed",
      })) ?? batch
    );
  }

  async getBatch(workspaceId: string, batchId: string) {
    return this.store.getBatch(workspaceId, batchId);
  }

  async getListDetail(workspaceId: string, listId: string): Promise<ListDetail | null> {
    const list = await this.store.getList(workspaceId, listId);
    if (!list) return null;
    const memberIds = await this.store.getListMemberIds(workspaceId, listId);
    const scores = await this.store.getScoresForProspects(workspaceId, memberIds);
    const scoreById = new Map(scores.map((s) => [s.prospectId, s]));

    const members = await Promise.all(
      memberIds.map(async (prospectId) => {
        const activation = await this.store.getActivation(workspaceId, prospectId);
        return {
          prospectId,
          snapshot: activation?.snapshot ?? {},
          score: scoreById.get(prospectId) ?? null,
        };
      })
    );

    return { list, members };
  }

  async lookupScores(workspaceId: string, prospectIds: string[]) {
    const scores = await this.store.getScoresForProspects(workspaceId, prospectIds);
    return Object.fromEntries(scores.map((s) => [s.prospectId, s]));
  }

  async scoreList(workspaceId: string, listId: string) {
    const list = await this.store.getList(workspaceId, listId);
    if (!list) throw new HttpError("list_not_found", 404);
    const icp = this.loadIcp ? await this.loadIcp(workspaceId) : {};
    if (!isIcpConfigured(icp)) {
      throw new HttpError("ICP_NOT_CONFIGURED", 400);
    }

    const memberIds = await this.store.getListMemberIds(workspaceId, listId);
    const results: Array<{ prospectId: string; icpScore: number; icpBand: string }> = [];

    for (const prospectId of memberIds) {
      const activation = await this.store.getActivation(workspaceId, prospectId);
      const snap = (activation?.snapshot ?? {}) as Partial<ProspectSnapshot>;
      if (!snap.companyDomain) continue;
      const result = await this.score(
        workspaceId,
        { ...snap, companyDomain: snap.companyDomain, prospectId },
        icp
      );
      results.push({
        prospectId,
        icpScore: result.icpScore,
        icpBand: result.icpBand,
      });
    }

    return { listId, scored: results.length, results };
  }
}
