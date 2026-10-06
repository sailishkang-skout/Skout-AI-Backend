import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { AuditService } from "./audit.service.js";
import { serviceLog } from "../lib/obs.js";
import { HttpError } from "@skout/auth";

const log = serviceLog("enrichment");
const { 
  enrichedPeople, 
  enrichedCompanies, 
  jobChangeEvents, 
  enrichmentCampaigns,
  workspaces 
} = schema;

export interface EnrichmentService {
  listPeople(workspaceId: string): Promise<{ people: typeof enrichedPeople.$inferSelect[] }>;
  listCompanies(workspaceId: string): Promise<{ companies: typeof enrichedCompanies.$inferSelect[] }>;
  listJobChanges(workspaceId: string): Promise<{ jobChanges: typeof jobChangeEvents.$inferSelect[] }>;
  listCampaigns(workspaceId: string): Promise<{ campaigns: typeof enrichmentCampaigns.$inferSelect[] }>;
  getCredits(workspaceId: string): Promise<number>;
  exportData(workspaceId: string, filters: unknown): Promise<unknown>;
  deleteProspect(workspaceId: string, prospectId: string): Promise<void>;
}

export function buildEnrichmentService(
  db: Db | null,
  auditService: AuditService | null
): EnrichmentService | null {
  if (!db || !auditService) return null;

  return {
    async listPeople(workspaceId: string) {
      const people = await db.query.enrichedPeople.findMany({
        where: (person, { eq }) => eq(person.workspaceId, workspaceId),
        orderBy: (person, { desc }) => desc(person.createdAt)
      });
      return { people };
    },

    async listCompanies(workspaceId: string) {
      const companies = await db.query.enrichedCompanies.findMany({
        where: (company, { eq }) => eq(company.workspaceId, workspaceId),
        orderBy: (company, { desc }) => desc(company.createdAt)
      });
      return { companies };
    },

    async listJobChanges(workspaceId: string) {
      const jobChanges = await db.query.jobChangeEvents.findMany({
        where: (event, { eq }) => eq(event.workspaceId, workspaceId),
        orderBy: (event, { desc }) => desc(event.detectedAt)
      });
      return { jobChanges };
    },

    async listCampaigns(workspaceId: string) {
      const campaigns = await db.query.enrichmentCampaigns.findMany({
        where: (campaign, { eq }) => eq(campaign.workspaceId, workspaceId),
        orderBy: (campaign, { desc }) => desc(campaign.createdAt)
      });
      return { campaigns };
    },

    async getCredits(workspaceId: string) {
      const workspace = await db.query.workspaces.findFirst({
        where: (ws, { eq }) => eq(ws.id, workspaceId),
        columns: { enrichmentCredits: true }
      });
      return workspace?.enrichmentCredits ?? 0;
    },

    async exportData(workspaceId: string, filters: unknown) {
      const allEnrichedData = await db.query.enrichedPeople.findMany({
        where: (person, { eq }) => eq(person.workspaceId, workspaceId)
      });
      return {
        exportedAt: new Date().toISOString(),
        workspaceId,
        recordCount: allEnrichedData.length,
        data: allEnrichedData
      };
    },

    async deleteProspect(workspaceId: string, prospectId: string) {
      await db.delete(enrichedPeople).where(
        and(eq(enrichedPeople.workspaceId, workspaceId), eq(enrichedPeople.id, prospectId))
      );
      log.info(`Deleted prospect ${prospectId} from workspace ${workspaceId}`);
    }
  };
}