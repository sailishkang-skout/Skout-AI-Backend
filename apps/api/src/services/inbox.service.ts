export class InboxService {
  async listInboxes(workspaceId: string) {
    return { workspaceId, data: [], total: 0 };
  }

  async listThreads(workspaceId: string) {
    return { workspaceId, data: [], total: 0 };
  }
}

export const inboxService = new InboxService();
