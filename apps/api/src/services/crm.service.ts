export class CrmService {
  async listConnections(workspaceId: string) {
    return { workspaceId, data: [], total: 0 };
  }
}

export const crmService = new CrmService();
