interface EnrichmentJobRecord {
  id: string;
  workspaceId: string;
  prospectId: string;
  status: "queued" | "running" | "completed" | "failed";
  trigger: string;
  fieldsRequested: string[];
  results: Array<{ field: string; value?: string; provider: string }>;
  creditsUsed: number;
  errorMessage: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Prospect activation — async Kafka job in production; sync stub for MVP skeleton.
 *  Keeps an in-memory store of enrichment jobs so the frontend's "Recent jobs"
 *  panel (GET /enrichment/jobs) has data to render. */
export class ProspectService {
  private jobs: EnrichmentJobRecord[] = [];

  async listActivated(workspaceId: string) {
    return { workspaceId, data: [], total: 0 };
  }

  async listJobs(workspaceId: string) {
    const data = this.jobs
      .filter((j) => j.workspaceId === workspaceId)
      .sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
    return { workspaceId, data, total: data.length };
  }

  async getJob(workspaceId: string, jobId: string) {
    const job = this.jobs.find((j) => j.id === jobId && j.workspaceId === workspaceId);
    return job ?? null;
  }

  async retryJob(workspaceId: string, jobId: string) {
    const prev = await this.getJob(workspaceId, jobId);
    if (!prev) return null;
    const jobIdOut = `enrich-${jobId.slice(-8)}`;
    const job: EnrichmentJobRecord = {
      ...prev,
      id: jobIdOut,
      status: "queued",
      results: [],
      creditsUsed: 0,
      errorMessage: null,
      queuedAt: nowIso(),
      startedAt: null,
      completedAt: null,
    };
    this.jobs.push(job);
    return {
      jobId: job.id,
      status: job.status,
      creditsUsed: 0,
      results: job.results,
      queuedAt: job.queuedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    };
  }

  async enrich(prospectId: string, workspaceId: string) {
    const jobId = `enrich-${prospectId.slice(0, 8)}-${Date.now().toString(36)}`;
    const queuedAt = nowIso();
    const job: EnrichmentJobRecord = {
      id: jobId,
      workspaceId,
      prospectId,
      status: "completed",
      trigger: "manual",
      fieldsRequested: ["company", "email", "validation"],
      results: [
        { field: "company", provider: "demo" },
        { field: "email", value: `contact@${prospectId.replace(/^.*@?/, "")}.com`, provider: "demo" },
        { field: "validation", value: "valid", provider: "demo" },
      ],
      creditsUsed: 1,
      errorMessage: null,
      queuedAt,
      startedAt: queuedAt,
      completedAt: nowIso(),
    };
    this.jobs.push(job);
    return {
      jobId,
      status: "completed" as const,
      workspaceId,
      creditsUsed: 1,
      results: job.results,
      queuedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      message: "RefreshAndVerifyWorkflow queued (Temporal stub)",
    };
  }
}

export const prospectService = new ProspectService();
