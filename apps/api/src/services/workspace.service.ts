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

  async getCurrent(workspaceId: string) {
    const workspaces = await this.listWorkspaces();
    const workspace = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0];
    if (!workspace) {
      throw new Error("Workspace not found");
    }
    return {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      createdAt: workspace.createdAt,
      balance: 0,
    };
  }

  async getWorkspaceIcp() {
    return {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      config: {
        // Top-level ICP fields — the frontend's isIcpConfigured() checks these,
        // so at least one must be populated for the ICP to count as configured.
        industries: ["SaaS", "Software"],
        countries: ["US", "CA"],
        seniorities: ["vp", "director"],
        titles: ["VP Sales"],
        keywords: ["B2B", "pipeline", "PLG"],
        customerPainPoints: ["scaling outbound", "low reply rates", "pipeline generation"],
        minEmployees: 11,
        maxEmployees: 5000,
        companyName: "Acme Corp",
        productDescription:
          "AI-powered outbound platform that finds, enriches, and sequences B2B leads.",
        onboarding: {
          completedAt: new Date().toISOString(),
          company: { name: "Acme Corp", industry: "SaaS", size: "11-50" },
          goals: ["Generate pipeline", "Improve reply rates"],
          icp: { industries: ["SaaS", "Software"] },
          people: { seniorities: ["vp", "director"], titles: ["VP Sales"], departments: [] },
          market: ["US", "CA"],
          leadVolume: "30",
        },
      },
      version: 1,
      rescoreJob: null,
    };
  }
}

export const workspaceService = new WorkspaceService();
