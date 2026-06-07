export class SequenceService {
  async list(workspaceId: string) {
    return { workspaceId, data: [], total: 0 };
  }

  async enroll(sequenceId: string, workspaceId: string) {
    return {
      sequenceId,
      workspaceId,
      status: "accepted" as const,
      message: "Enrollment workflow queued (Temporal stub)",
    };
  }
}

export const sequenceService = new SequenceService();
