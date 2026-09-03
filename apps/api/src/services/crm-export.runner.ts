import { createLogger } from "@skout/observability";
import { desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import {
  batchUpsertHubSpotContacts,
  refreshHubSpotToken,
  type HubSpotContactInput,
  type HubSpotTokens,
} from "./hubspot.client.js";
import {
  createHubSpotCredentialsStore,
  type HubSpotCredentialsStore,
} from "./hubspot-credentials.store.js";
import { DbStore } from "./enrichment/db-store.js";

const { crmConnections, crmProspectMappings, asyncJobs, prospectActivations, listMembers, enrichmentResults } =
  schema;

const HUBSPOT_PROVIDER = "hubspot";
const EXPORT_CREDIT_PER_CONTACT = 1;
const log = createLogger("crm-export.runner");

interface ConnectionRow {
  externalAccountId: string | null;
  settings: Record<string, unknown>;
  credentialsRef: string | null;
  status: string;
}

export async function runHubSpotExportJob(
  db: Db,
  config: Env,
  credentialsStore: HubSpotCredentialsStore,
  jobId: string,
  workspaceId: string,
  listId: string
): Promise<void> {
  await db
    .update(asyncJobs)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(asyncJobs.id, jobId));

  try {
    const tokens = await ensureFreshTokens(db, config, credentialsStore, workspaceId);
    const members = await db.select().from(listMembers).where(eq(listMembers.listId, listId));

    const prospectIds = members.map((m) => m.prospectId);
    const existingMappings =
      prospectIds.length > 0
        ? await db
            .select()
            .from(crmProspectMappings)
            .where(
              scopedTo(
                crmProspectMappings,
                workspaceId,
                eq(crmProspectMappings.provider, HUBSPOT_PROVIDER),
                inArray(crmProspectMappings.prospectId, prospectIds)
              )
            )
        : [];

    const mappingByProspect = new Map(
      existingMappings.map((m) => [m.prospectId, m.externalId])
    );

    const emailRows =
      prospectIds.length > 0
        ? await db
            .select({
              prospectId: enrichmentResults.prospectId,
              fieldValue: enrichmentResults.fieldValue,
            })
            .from(enrichmentResults)
            .where(
              scopedTo(
                enrichmentResults,
                workspaceId,
                inArray(enrichmentResults.prospectId, prospectIds),
                eq(enrichmentResults.fieldName, "email")
              )
            )
            .orderBy(desc(enrichmentResults.createdAt))
        : [];
    const emailByProspect = new Map<string, string>();
    for (const row of emailRows) {
      if (row.fieldValue && !emailByProspect.has(row.prospectId)) {
        emailByProspect.set(row.prospectId, row.fieldValue);
      }
    }

    const contacts: HubSpotContactInput[] = [];
    for (const member of members) {
      const [activation] = await db
        .select()
        .from(prospectActivations)
        .where(scopedTo(prospectActivations, workspaceId, eq(prospectActivations.prospectId, member.prospectId)));
      const snap = (activation?.snapshot ?? {}) as Record<string, unknown>;
      const email =
        (typeof snap.email === "string" && snap.email.trim()) ||
        emailByProspect.get(member.prospectId) ||
        undefined;
      const fullName = typeof snap.fullName === "string" ? snap.fullName : "";
      const parts = fullName.trim().split(/\s+/);
      const firstname = parts[0] ?? "";
      const lastname = parts.slice(1).join(" ") || undefined;
      const hubspotContactId =
        mappingByProspect.get(member.prospectId) ??
        (typeof snap.hubspotContactId === "string" ? snap.hubspotContactId : undefined);
      const companyNested =
        snap.company && typeof snap.company === "object"
          ? (snap.company as { companyName?: string }).companyName
          : undefined;
      contacts.push({
        prospectId: member.prospectId,
        email,
        firstname: firstname || undefined,
        lastname,
        company:
          (typeof snap.companyName === "string" && snap.companyName) ||
          companyNested ||
          (typeof snap.companyDomain === "string" ? snap.companyDomain : undefined) ||
          (typeof snap.company === "string" ? snap.company : undefined),
        jobtitle: typeof snap.title === "string" ? snap.title : undefined,
        hubspotContactId,
      });
    }

    const exportable = contacts.filter((c) => c.email || c.hubspotContactId);
    const batchResult = await batchUpsertHubSpotContacts(tokens.accessToken, exportable);

    for (const mapping of batchResult.mappings) {
      await db
        .insert(crmProspectMappings)
        .values({
          workspaceId,
          provider: HUBSPOT_PROVIDER,
          prospectId: mapping.prospectId,
          externalId: mapping.hubspotContactId,
        })
        .onConflictDoUpdate({
          target: [
            crmProspectMappings.workspaceId,
            crmProspectMappings.provider,
            crmProspectMappings.prospectId,
          ],
          set: {
            externalId: mapping.hubspotContactId,
            updatedAt: new Date(),
          },
        });
    }

    await db
      .update(asyncJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        result: {
          total: contacts.length,
          pushed: batchResult.upserted,
          created: batchResult.created,
          updated: batchResult.updated,
          skippedNoEmail: contacts.length - exportable.length,
          errors: batchResult.errors,
        },
      })
      .where(eq(asyncJobs.id, jobId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("HubSpot export job failed", err, { jobId, workspaceId, listId });

    const [failedJob] = await db
      .select({ payload: asyncJobs.payload })
      .from(asyncJobs)
      .where(eq(asyncJobs.id, jobId))
      .limit(1);
    const contactCount =
      failedJob?.payload &&
      typeof failedJob.payload === "object" &&
      "contactCount" in failedJob.payload
        ? Number((failedJob.payload as { contactCount?: number }).contactCount ?? 0)
        : 0;
    if (contactCount > 0) {
      try {
        const store = new DbStore(db);
        await store.addCredits(
          workspaceId,
          contactCount * EXPORT_CREDIT_PER_CONTACT,
          "export_hubspot_refund",
          listId
        );
        log.info("HubSpot export credits refunded", { workspaceId, listId, contactCount });
      } catch (refundErr) {
        log.error("HubSpot export credit refund failed", refundErr, {
          workspaceId,
          listId,
          contactCount,
        });
      }
    }

    await db
      .update(asyncJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: message,
      })
      .where(eq(asyncJobs.id, jobId));
    throw err;
  }
}

export async function ensureFreshTokens(
  db: Db,
  config: Env,
  credentialsStore: HubSpotCredentialsStore,
  workspaceId: string
): Promise<HubSpotTokens> {
  const row = await getHubSpotConnection(db, workspaceId);
  if (!row || row.status !== "connected") {
    throw new HttpError("hubspot_not_connected", 400);
  }

  let tokens = await loadTokens(db, credentialsStore, workspaceId, row);
  if (!tokens) {
    await markConnectionError(db, workspaceId);
    throw new HttpError("hubspot_token_expired", 401);
  }

  const expiresAt = tokens.expiresAt ? new Date(tokens.expiresAt).getTime() : 0;
  if (expiresAt > Date.now() + 60_000) {
    return tokens;
  }

  if (!config.HUBSPOT_CLIENT_ID || !config.HUBSPOT_CLIENT_SECRET || !tokens.refreshToken) {
    await markConnectionError(db, workspaceId);
    throw new HttpError("hubspot_token_expired", 401);
  }

  const refreshed = await refreshHubSpotToken({
    clientId: config.HUBSPOT_CLIENT_ID,
    clientSecret: config.HUBSPOT_CLIENT_SECRET,
    refreshToken: tokens.refreshToken,
  });

  await saveHubSpotTokens(db, credentialsStore, workspaceId, refreshed, row.externalAccountId);
  return refreshed;
}

export async function saveHubSpotTokens(
  db: Db,
  credentialsStore: HubSpotCredentialsStore,
  workspaceId: string,
  tokens: HubSpotTokens,
  externalAccountId?: string | null
): Promise<string> {
  const credentialsRef = await credentialsStore.save(workspaceId, tokens);

  await db
    .insert(crmConnections)
    .values({
      workspaceId,
      provider: HUBSPOT_PROVIDER,
      status: "connected",
      externalAccountId: externalAccountId ?? null,
      credentialsRef,
      settings: {},
      tokenExpiresAt: new Date(tokens.expiresAt),
    })
    .onConflictDoUpdate({
      target: [crmConnections.workspaceId, crmConnections.provider],
      set: {
        status: "connected",
        externalAccountId: externalAccountId ?? null,
        credentialsRef,
        settings: {},
        tokenExpiresAt: new Date(tokens.expiresAt),
        updatedAt: new Date(),
      },
    });

  return credentialsRef;
}

async function loadTokens(
  db: Db,
  credentialsStore: HubSpotCredentialsStore,
  workspaceId: string,
  row: ConnectionRow
): Promise<HubSpotTokens | null> {
  if (row.credentialsRef) {
    const fromStore = await credentialsStore.load(row.credentialsRef);
    if (fromStore) return fromStore;
  }

  const legacy = row.settings as unknown as HubSpotTokens;
  if (legacy?.accessToken && legacy?.refreshToken) {
    await saveHubSpotTokens(db, credentialsStore, workspaceId, legacy, row.externalAccountId);
    return legacy;
  }

  return null;
}

async function getHubSpotConnection(db: Db, workspaceId: string): Promise<ConnectionRow | null> {
  const [row] = await db
    .select()
    .from(crmConnections)
    .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, HUBSPOT_PROVIDER)));
  return (row as ConnectionRow) ?? null;
}

async function markConnectionError(db: Db, workspaceId: string): Promise<void> {
  await db
    .update(crmConnections)
    .set({ status: "error", updatedAt: new Date() })
    .where(scopedTo(crmConnections, workspaceId, eq(crmConnections.provider, HUBSPOT_PROVIDER)));
}

export function createDefaultCredentialsStore(config: Env): HubSpotCredentialsStore {
  return createHubSpotCredentialsStore(config);
}
