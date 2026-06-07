export class ListService {
  async list(workspaceId: string) {
    return { workspaceId, data: [], total: 0 };
  }

  async create(workspaceId: string, name: string, prospectIds?: string[]) {
    return {
      id: crypto.randomUUID(),
      workspaceId,
      name,
      prospectCount: prospectIds?.length ?? 0,
      createdAt: new Date().toISOString(),
    };
  }
}

export const listService = new ListService();
