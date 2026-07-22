import { createLogger } from "@skout/observability";

const log = createLogger("prospect.service");

/** Prospect activation — async Kafka job in production; sync stub for MVP skeleton */
export class ProspectService {
  async listActivated(workspaceId: string) {
    return { workspaceId, data: [], total: 0 };
  }

  async enrich(prospectId: string, workspaceId: string) {
    log.info("prospect enrich queued (stub)", { workspaceId, prospectId });
    return {
      jobId: `enrich-${prospectId.slice(0, 8)}`,
      status: "accepted" as const,
      workspaceId,
      message: "RefreshAndVerifyWorkflow queued (Temporal stub)",
    };
  }
}

export const prospectService = new ProspectService();
