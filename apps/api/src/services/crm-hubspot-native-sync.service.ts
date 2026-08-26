import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, getLatestEvidenceByAttribute } from "@skout/db";
import {
  asFieldSourcesMap,
  filterAutoFillablePatch,
  mergeAutoFillSources,
  DEFAULT_AUTO_FILL_CONFIDENCE,
} from "@skout/shared";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { HttpError } from "../utils/http.js";
import { ensureFreshTokens, createDefaultCredentialsStore } from "./crm-export.runner.js";
import { fetchAllHubSpotContacts, fetchAllHubSpotDeals } from "./hubspot.client.js";
import { hubSpotContactToSnapshot } from "./crm.service.js";
import { recordEvidence } from "./evidence.service.js";

const log = createLogger("crm-hubspot-native-sync");
const { contacts, companies, deals, pipelines, pipelineStages } = schema;

export interface HubSpotNativeSyncResult {
  pulled: number;
  created: number;
  updated: number;
  skipped: number;
}

async function findOrCreateCompany(
  db: Db,
  workspaceId: string,
  name: string,
  domain: string | null
): Promise<string | null> {
  if (domain) {
    const [byDomain] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(
        and(eq(companies.workspaceId, workspaceId), eq(companies.domain, domain), isNull(companies.deletedAt))
      )
      .limit(1);
    if (byDomain) return byDomain.id;
  }

  const [created] = await db
    .insert(companies)
    .values({
      workspaceId,
      name,
      domain: domain ?? undefined,
      fieldSources: {},
    })
    .returning({ id: companies.id });
  return created?.id ?? null;
}

/**
 * §8.12 — pull HubSpot contacts into native CRM with manual-wins conflict rules.
 */
export async function syncHubSpotContactsToNativeCrm(
  db: Db,
  config: Env,
  workspaceId: string,
  maxContacts = 200
): Promise<HubSpotNativeSyncResult> {
  const credentialsStore = createDefaultCredentialsStore(config);
  const tokens = await ensureFreshTokens(db, config, credentialsStore, workspaceId);
  const hubspotContacts = await fetchAllHubSpotContacts(tokens.accessToken, maxContacts);

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const hsContact of hubspotContacts) {
    const snap = hubSpotContactToSnapshot(hsContact);
    if (!snap?.email) {
      skipped++;
      continue;
    }

    const email = snap.email.trim().toLowerCase();
    const companyId = snap.companyName
      ? await findOrCreateCompany(db, workspaceId, snap.companyName, snap.companyDomain ?? null)
      : null;

    const patch: Record<string, unknown> = {};
    if (snap.title) patch.title = snap.title;
    if (snap.phone) patch.phone = snap.phone;
    if (snap.fullName) {
      const parts = snap.fullName.trim().split(/\s+/);
      patch.firstName = parts[0];
      if (parts.length > 1) patch.lastName = parts.slice(1).join(" ");
    }

    const [existing] = await db
      .select()
      .from(contacts)
      .where(
        and(eq(contacts.workspaceId, workspaceId), eq(contacts.email, email), isNull(contacts.deletedAt))
      )
      .limit(1);

    if (!existing) {
      const firstName = (patch.firstName as string) ?? email.split("@")[0] ?? "Contact";
      const [row] = await db
        .insert(contacts)
        .values({
          workspaceId,
          firstName,
          lastName: (patch.lastName as string | undefined) ?? null,
          email,
          phone: (patch.phone as string | undefined) ?? null,
          title: (patch.title as string | undefined) ?? null,
          companyId,
          fieldSources: mergeAutoFillSources(
            {},
            Object.keys(patch).filter((k) => k !== "firstName"),
            "enrichment",
            undefined
          ),
        })
        .returning();
      if (row) {
        created++;
        for (const field of ["title", "phone"] as const) {
          if (patch[field] == null) continue;
          try {
            await recordEvidence(db, {
              workspaceId,
              entityType: "contact",
              entityId: row.id,
              attribute: field,
              value: patch[field],
              source: "hubspot_inbound",
              observedAt: new Date(),
              confidence: DEFAULT_AUTO_FILL_CONFIDENCE.enrichment,
              method: "hubspot_native_sync",
            });
          } catch (err) {
            log.error("evidence write failed on hubspot inbound create", { err, contactId: row.id, field });
          }
        }
      }
      continue;
    }

    const existingSources = asFieldSourcesMap(existing.fieldSources);
    const evidenceByAttribute = await getLatestEvidenceByAttribute(db, workspaceId, "contact", existing.id);
    const { applied } = filterAutoFillablePatch(patch, existingSources, evidenceByAttribute);
    const appliedFields = Object.keys(applied);
    if (appliedFields.length === 0) {
      skipped++;
      continue;
    }

    const nextFieldSources = mergeAutoFillSources(existingSources, appliedFields, "enrichment", undefined);
    await db
      .update(contacts)
      .set({
        ...applied,
        ...(companyId && !existing.companyId ? { companyId } : {}),
        fieldSources: nextFieldSources,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, existing.id));

    updated++;
    for (const field of appliedFields) {
      try {
        await recordEvidence(db, {
          workspaceId,
          entityType: "contact",
          entityId: existing.id,
          attribute: field,
          value: (applied as Record<string, unknown>)[field],
          source: "hubspot_inbound",
          observedAt: new Date(),
          confidence: DEFAULT_AUTO_FILL_CONFIDENCE.enrichment,
          method: "hubspot_native_sync",
        });
      } catch (err) {
        log.error("evidence write failed on hubspot inbound update", { err, contactId: existing.id, field });
      }
    }
  }

  return { pulled: hubspotContacts.length, created, updated, skipped };
}

export interface HubSpotDealSyncResult {
  pulled: number;
  created: number;
  updated: number;
  skipped: number;
}

/**
 * §8.12 — pull HubSpot deals into native CRM with manual-wins conflict rules on amount.
 */
export async function syncHubSpotDealsToNativeCrm(
  db: Db,
  config: Env,
  workspaceId: string,
  maxDeals = 200
): Promise<HubSpotDealSyncResult> {
  const credentialsStore = createDefaultCredentialsStore(config);
  const tokens = await ensureFreshTokens(db, config, credentialsStore, workspaceId);
  const hubspotDeals = await fetchAllHubSpotDeals(tokens.accessToken, maxDeals);

  const [pipeline] = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.workspaceId, workspaceId), isNull(pipelines.deletedAt)))
    .limit(1);
  if (!pipeline) {
    log.warn("no CRM pipeline — skipping HubSpot deal sync", { workspaceId });
    return { pulled: hubspotDeals.length, created: 0, updated: 0, skipped: hubspotDeals.length };
  }
  const [stage] = await db
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.pipelineId, pipeline.id))
    .limit(1);
  if (!stage) {
    return { pulled: hubspotDeals.length, created: 0, updated: 0, skipped: hubspotDeals.length };
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const hs of hubspotDeals) {
    const name = hs.properties?.dealname?.trim();
    if (!name) {
      skipped++;
      continue;
    }
    const amount = hs.properties?.amount ? hs.properties.amount : undefined;
    const patch: Record<string, unknown> = {};
    if (amount != null && amount !== "") patch.amount = amount;

    const [existing] = await db
      .select()
      .from(deals)
      .where(and(eq(deals.workspaceId, workspaceId), eq(deals.name, name), isNull(deals.deletedAt)))
      .limit(1);

    if (!existing) {
      await db.insert(deals).values({
        workspaceId,
        pipelineId: pipeline.id,
        stageId: stage.id,
        name,
        amount: amount ?? null,
        fieldSources: mergeAutoFillSources({}, amount ? ["amount"] : [], "enrichment", undefined),
      });
      created++;
      continue;
    }

    if (Object.keys(patch).length === 0) {
      skipped++;
      continue;
    }

    const existingSources = asFieldSourcesMap(existing.fieldSources);
    const evidenceByAttribute = await getLatestEvidenceByAttribute(db, workspaceId, "deal", existing.id);
    const { applied } = filterAutoFillablePatch(patch, existingSources, evidenceByAttribute);
    const appliedFields = Object.keys(applied);
    if (appliedFields.length === 0) {
      skipped++;
      continue;
    }

    const nextFieldSources = mergeAutoFillSources(existingSources, appliedFields, "enrichment", undefined);
    await db
      .update(deals)
      .set({ ...applied, fieldSources: nextFieldSources, updatedAt: new Date() })
      .where(eq(deals.id, existing.id));
    updated++;

    for (const field of appliedFields) {
      try {
        await recordEvidence(db, {
          workspaceId,
          entityType: "deal",
          entityId: existing.id,
          attribute: field,
          value: (applied as Record<string, unknown>)[field],
          source: "hubspot_inbound",
          observedAt: new Date(),
          confidence: DEFAULT_AUTO_FILL_CONFIDENCE.enrichment,
          method: "hubspot_deal_sync",
        });
      } catch (err) {
        log.error("evidence write failed on hubspot deal sync", { err, dealId: existing.id, field });
      }
    }
  }

  return { pulled: hubspotDeals.length, created, updated, skipped };
}

export async function syncHubSpotNativeOrThrow(
  db: Db,
  config: Env,
  workspaceId: string,
  opts?: { maxContacts?: number; maxDeals?: number; includeDeals?: boolean }
) {
  if (!config.HUBSPOT_CLIENT_ID || !config.HUBSPOT_CLIENT_SECRET) {
    throw new HttpError("hubspot_not_configured", 503);
  }
  const contactsResult = await syncHubSpotContactsToNativeCrm(db, config, workspaceId, opts?.maxContacts);
  let dealsResult: HubSpotDealSyncResult | undefined;
  if (opts?.includeDeals !== false) {
    try {
      dealsResult = await syncHubSpotDealsToNativeCrm(db, config, workspaceId, opts?.maxDeals);
    } catch (err) {
      log.warn("HubSpot deal sync failed (contacts still applied) — check deals.read scope", { err });
    }
  }
  try {
    const { incrJourneyMetric } = await import("./journey-metrics.js");
    incrJourneyMetric("hubspotSync");
  } catch {
    /* ignore */
  }
  return { contacts: contactsResult, deals: dealsResult };
}
