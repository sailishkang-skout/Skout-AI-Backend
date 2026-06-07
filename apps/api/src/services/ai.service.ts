export class AiService {
  async listDrafts(workspaceId: string) {
    return { workspaceId, data: [], total: 0 };
  }
}

export const aiService = new AiService();
