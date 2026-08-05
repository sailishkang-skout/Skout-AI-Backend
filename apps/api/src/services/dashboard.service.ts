import { workspaceService } from "./workspace.service.js";
import { listService } from "./list.service.js";

/** True once the workspace ICP has usable lead-scoring fields. */
function isIcpConfigured(config: Record<string, unknown> | null | undefined): boolean {
  if (!config) return false;
  return Boolean(
    (config.industries as unknown[])?.length ||
      (config.countries as unknown[])?.length ||
      (config.seniorities as unknown[])?.length ||
      (config.titles as unknown[])?.length ||
      (config.keywords as unknown[])?.length ||
      (config.customerPainPoints as unknown[])?.length ||
      config.companyName ||
      config.productDescription ||
      config.minEmployees != null ||
      config.maxEmployees != null
  );
}

export class DashboardService {
  async getSummary(workspaceId: string) {
    const [workspaces, listResult, icp] = await Promise.all([
      workspaceService.listWorkspaces(),
      listService.list(workspaceId),
      workspaceService.getWorkspaceIcp(),
    ]);

    const workspace = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0];

    return {
      workspaceName: workspace?.name ?? "Demo Workspace",
      credits: 0,
      listCount: listResult.data.length,
      totalProspectsInLists: listResult.data.reduce(
        (sum: number, l: { prospectCount?: number }) => sum + (l.prospectCount ?? 0),
        0
      ),
      icpConfigured: isIcpConfigured(icp.config as Record<string, unknown>),
      recentJobs: [],
    };
  }
}

export const dashboardService = new DashboardService();
