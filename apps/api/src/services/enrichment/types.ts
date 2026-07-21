import type { AttemptLog, FieldResult } from "@skout/pal";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface ActivationRecord {
  id: string;
  workspaceId: string;
  prospectId: string;
  companyId: string;
  snapshot: Record<string, unknown>;
  activatedAt: string;
  updatedAt: string;
}

export interface ProspectListMember {
  prospectId: string;
  companyId: string;
  snapshot: Record<string, unknown>;
  addedAt: string;
}

export interface ProspectList {
  id: string;
  workspaceId: string;
  name: string;
  prospectCount: number;
  createdAt: string;
  members?: ProspectListMember[];
}

export interface EnrichmentJob {
  id: string;
  workspaceId: string;
  prospectId: string;
  activationId: string | null;
  batchId: string | null;
  status: JobStatus;
  trigger: string;
  fieldsRequested: string[];
  results: FieldResult[];
  attempts?: AttemptLog[];
  creditsUsed: number;
  errorMessage: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface EnrichmentBatch {
  id: string;
  workspaceId: string;
  listId: string | null;
  total: number;
  done: number;
  failed: number;
  status: JobStatus;
  jobIds: string[];
  createdAt: string;
}

export interface ProspectScore {
  workspaceId: string;
  prospectId: string;
  score: number;
  priority: string | null;
  reasoning: string | null;
  painPoints: string[];
  painPointsRationale: string | null;
  scoredAt: string;
}

/** Thrown when a paid step is requested with insufficient credits. */
export class InsufficientCreditsError extends Error {
  constructor(public readonly required: number, public readonly available: number) {
    super(`Insufficient credits: need ${required}, have ${available}`);
    this.name = "InsufficientCreditsError";
  }
}

export interface EnrichmentStore {
  getCreditBalance(workspaceId: string): Promise<number>;
  addCredits(workspaceId: string, amount: number, action: string, ref?: string): Promise<number>;
  deductCredits(workspaceId: string, amount: number, action: string, ref?: string): Promise<number>;

  upsertActivation(
    workspaceId: string,
    prospectId: string,
    companyId: string,
    snapshot: Record<string, unknown>
  ): Promise<ActivationRecord>;
  listActivations(workspaceId: string): Promise<ActivationRecord[]>;
  getActivation(workspaceId: string, prospectId: string): Promise<ActivationRecord | null>;

  createList(workspaceId: string, name: string, prospectIds: string[]): Promise<ProspectList>;
  addListMembers(workspaceId: string, listId: string, prospectIds: string[]): Promise<ProspectList | null>;
  listLists(workspaceId: string): Promise<ProspectList[]>;
  getListMemberIds(workspaceId: string, listId: string): Promise<string[]>;
  renameList(workspaceId: string, listId: string, name: string): Promise<ProspectList | null>;
  deleteList(workspaceId: string, listId: string): Promise<boolean>;
  removeMembersFromList(workspaceId: string, listId: string, prospectIds: string[]): Promise<ProspectList | null>;

  createJob(job: Omit<EnrichmentJob, "id">): Promise<EnrichmentJob>;
  updateJob(id: string, patch: Partial<EnrichmentJob>): Promise<EnrichmentJob | null>;
  getJob(workspaceId: string, id: string): Promise<EnrichmentJob | null>;
  listJobs(workspaceId: string): Promise<EnrichmentJob[]>;

  createBatch(batch: Omit<EnrichmentBatch, "id">): Promise<EnrichmentBatch>;
  updateBatch(id: string, patch: Partial<EnrichmentBatch>): Promise<EnrichmentBatch | null>;
  getBatch(workspaceId: string, id: string): Promise<EnrichmentBatch | null>;

  setScore(score: ProspectScore): Promise<ProspectScore>;
  getScore(workspaceId: string, prospectId: string): Promise<ProspectScore | null>;
  getScoresForProspects(workspaceId: string, prospectIds: string[]): Promise<ProspectScore[]>;
  getList(workspaceId: string, listId: string): Promise<ProspectList | null>;
}

export interface ListMemberDetail {
  prospectId: string;
  snapshot: Record<string, unknown>;
  score: ProspectScore | null;
}

export interface ListDetail {
  list: ProspectList;
  members: ListMemberDetail[];
}
