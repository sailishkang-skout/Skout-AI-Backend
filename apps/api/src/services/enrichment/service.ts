import { EnrichmentEngine, type EnrichField } from "@skout/pal";
import { generateCompanyId, generateProspectId } from "@skout/shared";
import { createLogger, captureException } from "@skout/observability";
import { scoreProspectIcp, type IcpConfig, type ScoreInput, type ScoreResult } from "../intelligence-layer.service.js";
import {
  InsufficientCreditsError,
  type EnrichmentBatch,
  type EnrichmentJob,
  type EnrichmentStore,
  type ListDetail,
  type ProspectList,
  type ProspectScore,
} from "./types.js";
import { HttpError, isDatabaseError } from "../../utils/http.js";
import { isIcpConfigured } from "../icp.service.js";
import { isVerifiedEmailStatus, stripUnverifiedEmail } from "../../utils/verified-email.js";
import type { CompanyData } from "@skout/pal";

const log = createLogger("enrichment.service");

export const SCORE_CREDIT_COST = 2;

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
  companyName?: string;
  hubspotContactId?: string;
  phone?: string;
  emailStatus?: string;
  company?: CompanyData;
  headline?: string;
  location?: string;
  city?: string;
  state?: string;
  about?: string;
  connections?: string;
  followers?: string;
  photoUrl?: string;
}

export interface EnrichOptions {
  fields?: EnrichField[];
  trigger?: string;
  batchId?: string;
  icp?: IcpConfig;
  /** 8.3 workbook quality threshold — passed straight through to the engine. */
  emailQualityThreshold?: number;
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
    private readonly beforeWrite?: (workspaceId: string) => Promise<void>,
    private readonly afterScore?: (result: ScoreResult, workspaceId: string) => Promise<void>,
    private readonly openrouterApiKey?: string,
    /** R13.3 — best-effort CRM auto-fill hook, called per-prospect after `activate` upserts its
     * snapshot. Failures here must never fail activation — see call site. */
    private readonly afterActivate?: (workspaceId: string, snapshot: ProspectSnapshot) => Promise<void>
  ) {}

  private async prepareWorkspace(workspaceId: string): Promise<void> {
    if (this.beforeWrite) await this.beforeWrite(workspaceId);
  }

  /** Read a single stored activation (snapshot) for a prospect in this workspace. */
  async getActivation(workspaceId: string, prospectId: string) {
    return this.store.getActivation(workspaceId, prospectId);
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
      const snapshot = stripUnverifiedEmail({ ...p, prospectId, companyId });
      await this.store.upsertActivation(workspaceId, prospectId, companyId, snapshot);
      if (this.afterActivate) {
        try {
          await this.afterActivate(workspaceId, snapshot);
        } catch (err) {
          // R13.3 — auto-fill is a nice-to-have side effect of activation, never a blocker.
          log.error("enrichment auto-fill hook failed", err, { workspaceId, prospectId });
        }
      }
    }
    log.info("prospects activated", { workspaceId, count: prospects.length });
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

  async deductExportCredits(workspaceId: string, amount: number, listId: string) {
    return this.store.deductCredits(workspaceId, amount, "export_csv", listId);
  }

  /** Re-run a failed or completed enrichment job using the stored activation snapshot. */
  async retryJob(workspaceId: string, jobId: string): Promise<EnrichmentJob> {
    const existing = await this.store.getJob(workspaceId, jobId);
    if (!existing) throw new HttpError("job_not_found", 404);
    if (existing.status === "running" || existing.status === "queued") {
      throw new HttpError("job_still_active", 409);
    }

    const activation = await this.store.getActivation(workspaceId, existing.prospectId);
    if (!activation) throw new HttpError("activation_not_found", 404);

    const snap = activation.snapshot as Partial<ProspectSnapshot>;
    return this.enrichProspect(
      workspaceId,
      {
        ...snap,
        prospectId: existing.prospectId,
        companyDomain: snap.companyDomain ?? "",
      },
      {
        fields: existing.fieldsRequested as EnrichField[],
        trigger: existing.trigger ?? "retry",
      }
    );
  }

  async score(workspaceId: string, snapshot: ProspectSnapshot, icp?: IcpConfig, creditCost = SCORE_CREDIT_COST) {
    await this.prepareWorkspace(workspaceId);
    const { prospectId } = this.resolveIds(snapshot);
    const resolvedIcp = icp ?? (this.loadIcp ? await this.loadIcp(workspaceId) : {});
    if (!isIcpConfigured(resolvedIcp)) {
      throw new HttpError("ICP_NOT_CONFIGURED", 400);
    }

    const balance = await this.store.getCreditBalance(workspaceId);
    if (balance < creditCost) {
      throw new InsufficientCreditsError(creditCost, balance);
    }

    const scored = scoreSnapshot(snapshot);
    const input: ScoreInput = {
      prospectId,
      fullName: scored.fullName,
      title: scored.title,
      seniority: scored.seniority,
      industry: scored.industry,
      country: scored.country,
      employeeCount: scored.employeeCount,
      companyDomain: scored.companyDomain,
      signals: scored.signals,
    };
    const result = await scoreProspectIcp(
      this.aiServiceUrl,
      input,
      resolvedIcp,
      this.aiTimeoutMs ?? 5000,
      this.openrouterApiKey
    );
    await this.store.deductCredits(workspaceId, creditCost, "ai_score", prospectId);
    await this.store.setScore({
      workspaceId,
      prospectId,
      score: result.icpScore,
      priority: result.outreachReadiness,
      reasoning: result.reasoning,
      painPoints: result.painPoints,
      painPointsRationale: result.painPointsRationale ?? null,
      scoredAt: new Date().toISOString(),
    });
    if (this.afterScore) await this.afterScore(result, workspaceId);
    return { ...result, creditsUsed: creditCost };
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
      status: "queued",
      trigger: opts.trigger ?? "manual",
      fieldsRequested: fields,
      results: [],
      creditsUsed: 0,
      errorMessage: null,
      queuedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    });

    const startedAt = new Date().toISOString();
    await this.store.updateJob(job.id, { status: "running", startedAt });

    try {
      const icp = opts.icp ?? (this.loadIcp ? await this.loadIcp(workspaceId) : {});
      const scoredSnapshot = scoreSnapshot(snapshot);
      const existingScore = await this.getStoredScore(workspaceId, snapshot);
      let leadScore =
        existingScore?.score ?? (await this.score(workspaceId, scoredSnapshot, icp)).icpScore;

      const engine = await this.resolveEngine(workspaceId);
      const activationSnap: Partial<ProspectSnapshot> =
        activation.snapshot && typeof activation.snapshot === "object"
          ? (activation.snapshot as Partial<ProspectSnapshot>)
          : {};
      const cachedEmail =
        activationSnap.email && isVerifiedEmailStatus(activationSnap.emailStatus)
          ? activationSnap.email
          : undefined;
      const cachedCompany = activationSnap.company;

      const outcome = await engine.enrich({
        prospectId,
        companyDomain: snapshot.companyDomain,
        companyName: snapshot.companyName,
        fullName: snapshot.fullName,
        title: snapshot.title,
        email: snapshot.email,
        linkedinUrl: snapshot.linkedinUrl,
        cachedEmail,
        cachedCompany,
        leadScore,
        fields,
        emailQualityThreshold: opts.emailQualityThreshold,
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

      // Fold enriched primary fields back into the activation snapshot (merge, do not replace).
      const enriched: Record<string, unknown> = {
        ...(activation.snapshot && typeof activation.snapshot === "object" ? activation.snapshot : {}),
      };
      for (const r of outcome.results) {
        if (r.field === "email" && r.isPrimary && r.value) enriched.email = r.value;
        if (r.field === "email_status") enriched.emailStatus = r.value;
        if (r.field === "phone" && r.isPrimary) enriched.phone = r.value;
        if (r.field === "company") {
          const firm = r.valueJson as {
            companyName?: string;
            industry?: string;
            employeeCount?: number;
          };
          const existingName =
            typeof enriched.companyName === "string" ? enriched.companyName.trim() : "";
          const firmName = firm.companyName?.trim() ?? "";
          const useFirmName =
            firmName.length > 0 &&
            firmName.toLowerCase() !== "name" &&
            (!existingName || existingName.toLowerCase() === "name");
          enriched.company = {
            ...firm,
            companyName: useFirmName ? firmName : existingName || firmName || undefined,
          };
          if (useFirmName && !enriched.companyName) enriched.companyName = firmName;
          if (firm.industry && !enriched.industry) enriched.industry = firm.industry;
          if (firm.employeeCount != null && enriched.employeeCount == null) {
            enriched.employeeCount = firm.employeeCount;
          }
        }
      }
      // Identity fields only — never restore unverified emails after validation.
      if (snapshot.fullName && !enriched.fullName) enriched.fullName = snapshot.fullName;
      if (snapshot.title && !enriched.title) enriched.title = snapshot.title;
      if (snapshot.companyDomain && !enriched.companyDomain) enriched.companyDomain = snapshot.companyDomain;
      if (snapshot.companyName && !enriched.companyName) enriched.companyName = snapshot.companyName;
      if (snapshot.hubspotContactId && !enriched.hubspotContactId) {
        enriched.hubspotContactId = snapshot.hubspotContactId;
      }
      if (Object.keys(enriched).length) {
        await this.store.upsertActivation(workspaceId, prospectId, companyId, enriched);
      }

      log.info("prospect enrichment completed", {
        workspaceId,
        prospectId,
        jobId: job.id,
        creditsUsed: outcome.creditsUsed,
        trigger: opts.trigger ?? "manual",
      });

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
      const raw = err instanceof Error ? err.message : String(err);
      const message =
        isDatabaseError(err) || /failed query:/i.test(raw)
          ? "Enrichment failed due to a server error"
          : raw;
      log.error("prospect enrichment failed", err, { workspaceId, prospectId, jobId: job.id });
      captureException(err, { module: "enrichment.service", workspaceId, prospectId, jobId: job.id });
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
    log.info("list enrichment started", { workspaceId, listId, total: memberIds.length });
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

    const status = failed === memberIds.length && memberIds.length > 0 ? "failed" : "completed";
    log.info("list enrichment finished", {
      workspaceId,
      listId,
      batchId: batch.id,
      done,
      failed,
      total: memberIds.length,
      status,
    });

    return (
      (await this.store.updateBatch(batch.id, {
        done,
        failed,
        status,
      })) ?? batch
    );
  }

  async getBatch(workspaceId: string, batchId: string) {
    return this.store.getBatch(workspaceId, batchId);
  }

  async getListMemberIds(workspaceId: string, listId: string): Promise<string[]> {
    return this.store.getListMemberIds(workspaceId, listId);
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

  async prepareListScore(workspaceId: string, listId: string) {
    await this.prepareWorkspace(workspaceId);
    const list = await this.store.getList(workspaceId, listId);
    if (!list) throw new HttpError("list_not_found", 404);
    const icp = this.loadIcp ? await this.loadIcp(workspaceId) : {};
    if (!isIcpConfigured(icp)) {
      throw new HttpError("ICP_NOT_CONFIGURED", 400);
    }

    const memberIds = await this.store.getListMemberIds(workspaceId, listId);
    const snapshots: ProspectSnapshot[] = [];
    for (const prospectId of memberIds) {
      const activation = await this.store.getActivation(workspaceId, prospectId);
      const snap = (activation?.snapshot ?? {}) as Partial<ProspectSnapshot>;
      if (snap.companyDomain) {
        snapshots.push({ ...snap, companyDomain: snap.companyDomain, prospectId });
      }
    }

    const totalCost = snapshots.length * SCORE_CREDIT_COST;
    const balance = await this.store.getCreditBalance(workspaceId);
    if (totalCost > 0 && balance < totalCost) {
      throw new InsufficientCreditsError(totalCost, balance);
    }

    return { list, icp, snapshots, totalCost };
  }

  async runListScore(
    workspaceId: string,
    listId: string,
    opts?: {
      onProgress?: (progress: {
        scored: number;
        total: number;
        creditsUsed: number;
        results: Array<{ prospectId: string; icpScore: number; icpBand: string }>;
      }) => Promise<void>;
    }
  ) {
    const { icp, snapshots } = await this.prepareListScore(workspaceId, listId);

    const results: Array<{ prospectId: string; icpScore: number; icpBand: string }> = [];
    let creditsUsed = 0;
    let skipped = 0;

    for (const snap of snapshots) {
      const result = await this.score(workspaceId, snap, icp);
      creditsUsed += result.creditsUsed ?? SCORE_CREDIT_COST;
      results.push({
        prospectId: result.prospectId,
        icpScore: result.icpScore,
        icpBand: result.icpBand,
      });
      if (opts?.onProgress) {
        await opts.onProgress({
          scored: results.length,
          total: snapshots.length,
          creditsUsed,
          results,
        });
      }
    }

    const memberCount = (await this.store.getListMemberIds(workspaceId, listId)).length;
    skipped = memberCount - snapshots.length;

    return { listId, scored: results.length, skipped, results, creditsUsed };
  }

  async prepareCorpusScore(workspaceId: string, snapshots: ProspectSnapshot[]) {
    await this.prepareWorkspace(workspaceId);
    const icp = this.loadIcp ? await this.loadIcp(workspaceId) : {};
    if (!isIcpConfigured(icp)) {
      throw new HttpError("ICP_NOT_CONFIGURED", 400);
    }
    const eligible = snapshots.filter((s) => s.companyDomain);
    const totalCost = eligible.length * SCORE_CREDIT_COST;
    const balance = await this.store.getCreditBalance(workspaceId);
    if (totalCost > 0 && balance < totalCost) {
      throw new InsufficientCreditsError(totalCost, balance);
    }
    return { icp, snapshots: eligible, totalCost };
  }

  async runCorpusScore(
    workspaceId: string,
    snapshots: ProspectSnapshot[],
    opts?: {
      onProgress?: (progress: {
        scored: number;
        total: number;
        creditsUsed: number;
        results: Array<{ prospectId: string; icpScore: number; icpBand: string }>;
      }) => Promise<void>;
    }
  ) {
    const { icp, snapshots: eligible } = await this.prepareCorpusScore(workspaceId, snapshots);
    const results: Array<{ prospectId: string; icpScore: number; icpBand: string }> = [];
    let creditsUsed = 0;

    for (const snap of eligible) {
      const result = await this.score(workspaceId, snap, icp);
      creditsUsed += result.creditsUsed ?? SCORE_CREDIT_COST;
      results.push({
        prospectId: result.prospectId,
        icpScore: result.icpScore,
        icpBand: result.icpBand,
      });
      if (opts?.onProgress) {
        await opts.onProgress({
          scored: results.length,
          total: eligible.length,
          creditsUsed,
          results,
        });
      }
    }

    return { scored: results.length, skipped: snapshots.length - eligible.length, results, creditsUsed };
  }

  async prepareWorkspaceRescore(workspaceId: string) {
    await this.prepareWorkspace(workspaceId);
    const icp = this.loadIcp ? await this.loadIcp(workspaceId) : {};
    if (!isIcpConfigured(icp)) {
      throw new HttpError("ICP_NOT_CONFIGURED", 400);
    }

    const activations = await this.store.listActivations(workspaceId);
    const snapshots: ProspectSnapshot[] = [];
    const seen = new Set<string>();
    for (const activation of activations) {
      const snap = (activation.snapshot ?? {}) as Partial<ProspectSnapshot>;
      const prospectId = activation.prospectId;
      if (!snap.companyDomain || seen.has(prospectId)) continue;
      seen.add(prospectId);
      snapshots.push({ ...snap, companyDomain: snap.companyDomain, prospectId });
    }

    const totalCost = snapshots.length * SCORE_CREDIT_COST;
    const balance = await this.store.getCreditBalance(workspaceId);
    if (totalCost > 0 && balance < totalCost) {
      throw new InsufficientCreditsError(totalCost, balance);
    }

    return { icp, snapshots, totalCost };
  }

  async runWorkspaceRescore(
    workspaceId: string,
    icpVersion: number,
    opts?: {
      onProgress?: (progress: {
        scored: number;
        total: number;
        creditsUsed: number;
        results: Array<{ prospectId: string; icpScore: number; icpBand: string }>;
      }) => Promise<void>;
    }
  ) {
    const { icp, snapshots } = await this.prepareWorkspaceRescore(workspaceId);

    const results: Array<{ prospectId: string; icpScore: number; icpBand: string }> = [];
    let creditsUsed = 0;

    for (const snap of snapshots) {
      const result = await this.score(workspaceId, snap, icp);
      creditsUsed += result.creditsUsed ?? SCORE_CREDIT_COST;
      results.push({
        prospectId: result.prospectId,
        icpScore: result.icpScore,
        icpBand: result.icpBand,
      });
      if (opts?.onProgress) {
        await opts.onProgress({
          scored: results.length,
          total: snapshots.length,
          creditsUsed,
          results,
        });
      }
    }

    return {
      scored: results.length,
      skipped: 0,
      results,
      creditsUsed,
      icpVersion,
    };
  }

  /** @deprecated Use ListScoreService.start — kept for direct sync calls in tests */
  async scoreList(workspaceId: string, listId: string) {
    return this.runListScore(workspaceId, listId);
  }
}
