/** Workspace & RBAC — PostgreSQL with RLS (activated records only in OLTP) */
export class WorkspaceService {
  async listWorkspaces() {
    return [
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Demo Workspace",
        slug: "demo",
        createdAt: new Date().toISOString(),
      },
    ];
  }
}

export const workspaceService = new WorkspaceService();
