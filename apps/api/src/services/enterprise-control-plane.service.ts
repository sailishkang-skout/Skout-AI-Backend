import { desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { IntegrationService } from "./integration.service.js";
import { buildIncidentsService } from "./incidents.service.js";
import { getDexterCommandCenter } from "./dexter-command-center.service.js";
import { journeyMetricsSnapshot } from "./journey-metrics.js";

const { auditLogs } = schema;

/** §17.18 — Enterprise Control Plane aggregate read model. */
export async function getEnterpriseControlPlane(db: Db, config: Env, workspaceId: string) {
  const integrationSvc = new IntegrationService(db, config);
  const incidentsSvc = buildIncidentsService(db);

  const [auditRows, integrations, openIncidents, dexterCenter, journeyMetrics] = await Promise.all([
    db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.workspaceId, workspaceId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(40),
    integrationSvc.list(workspaceId),
    incidentsSvc?.list(workspaceId, "open") ?? Promise.resolve([]),
    getDexterCommandCenter(db, workspaceId),
    Promise.resolve(journeyMetricsSnapshot()),
  ]);

  const connected = integrations.data.filter((i) => i.connected).length;
  const degraded = integrations.data.filter((i) => i.connected && i.status && i.status !== "active").length;

  return {
    summary: {
      auditEventsRecent: auditRows.length,
      integrationsConnected: connected,
      integrationsTotal: integrations.data.length,
      integrationsDegraded: degraded,
      openIncidents: openIncidents.length,
      dexterPendingApprovals: dexterCenter.summary.pendingPlanApprovals,
      dexterPolicyBlocks: dexterCenter.summary.policyBlocks,
    },
    auditLogs: auditRows.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      actorId: row.actorId,
      createdAt: row.createdAt.toISOString(),
    })),
    integrations: integrations.data,
    openIncidents,
    dexter: {
      summary: dexterCenter.summary,
      pendingApprovals: dexterCenter.pendingApprovals,
      policyBlocks: dexterCenter.policyBlocks.slice(0, 8),
    },
    journeyMetrics,
  };
}
