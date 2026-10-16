import { eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, getLatestEvidenceByAttribute, scopedTo } from "@skout/db";
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
import { searchHubSpotContactsModifiedSince, searchHubSpotDealsModifiedSince } from "./hubspot.client.js";
import { hubSpotContactToSnapshot } from "./crm.service.js";
import { recordEvidence } from "./evidence.service.js";
import { getHubSpotConnectionId, upsertCrmNativeLink, withSyncCheckpoint } from "./crm-sync-state.service.js";
import { ensureHubSpotPortalId } from "./crm-hubspot-webhook.service.js";
import { applyInboundMapping, getResolvedCrmMapping, type CrmObjectMapping } from "./crm-mapping.service.js";
import { evaluateFieldConflict, getPendingConflictFields, isProtectedField, recordCrmConflict } from "./crm-conflict.service.js";
import { getCrmSyncScope, isCompanyInScope, type CrmSyncScope } from "./crm-opt-in.service.js";

const log = createLogger("crm-hubspot-native-sync");
const { contacts, companies, deals, pipelines, pipelineStages } = schema;

export interface HubSpotNativeSyncResult {
  pulled: number;
  created: number;
  updated: number;
  skipped: number;
}

const asText = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

/**
 * COPS-09: which fields of an incoming provider patch may overwrite an existing Skout record.
 * Per field: a pending conflict blocks it (the open conflict is refreshed with the newest provider
 * value); a blank value the mapping says to overwrite clears the field unless Skout wins;
 * otherwise the field's conflict policy decides, and manual review queues a conflict.
 */
async function conflictCheckedPatch(
  db: Db,
  ctx: {
    workspaceId: string;
    connectionId: string;
    entityType: "contact" | "deal";
    existing: Record<string, unknown> & { id: string; updatedAt: Date | null };
    externalId: string;
    modifiedAt: Date | null;
    mapping: CrmObjectMapping | null;
    patch: Record<string, unknown>;
  }
): Promise<Record<string, unknown>> {
  const pending = await getPendingConflictFields(db, ctx.workspaceId, ctx.connectionId, ctx.entityType, ctx.existing.id);
  const eligible: Record<string, unknown> = {};
  for (const [field, val] of Object.entries(ctx.patch)) {
    const fieldMapping = ctx.mapping?.fields.find((f) => f.internalField === field);
    const policy = fieldMapping?.conflictPolicy ?? "most_recent";
    const skoutValue = ctx.existing[field];
    const conflict = {
      workspaceId: ctx.workspaceId,
      connectionId: ctx.connectionId,
      entityType: ctx.entityType,
      entityId: ctx.existing.id,
      externalId: ctx.externalId,
      fieldName: field,
      skoutValue: asText(skoutValue),
      externalValue: asText(val),
      skoutUpdatedAt: ctx.existing.updatedAt,
      externalUpdatedAt: ctx.modifiedAt,
      policy: "manual_review" as const,
    };

    if (pending.has(field)) {
      await recordCrmConflict(db, conflict).catch((err) => log.warn("Failed refreshing CRM sync conflict", { err, field }));
      continue;
    }
    if (val === null) {
      if (skoutValue != null && policy !== "skout_wins" && !fieldMapping?.isProtected && !isProtectedField(field)) eligible[field] = null;
      continue;
    }

    const decision = evaluateFieldConflict({
      fieldName: field,
      skoutValue,
      externalValue: val,
      skoutUpdatedAt: ctx.existing.updatedAt,
      externalUpdatedAt: ctx.modifiedAt,
      policy,
      isFieldProtected: fieldMapping?.isProtected,
    });
    if (decision.action === "apply_external") {
      eligible[field] = val;
    } else if (decision.action === "manual_review") {
      await recordCrmConflict(db, conflict).catch((err) => log.warn("Failed recording CRM sync conflict", { err, field }));
    }
  }
  return eligible;
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
      .where(scopedTo(companies, workspaceId, eq(companies.domain, domain), isNull(companies.deletedAt)))
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
 * §8.12 Task ADI-10 — pull HubSpot contacts modified since the last checkpoint into native CRM,
 * with manual-wins conflict rules, then advance the checkpoint (see withSyncCheckpoint) and
 * refresh each pulled contact's crm_native_links row so outbound push-back knows both which
 * HubSpot record it maps to and when HubSpot last touched it.
 */
export async function syncHubSpotContactsToNativeCrm(
  db: Db,
  config: Env,
  workspaceId: string,
  maxContacts = 200,
  scope: CrmSyncScope | null = null
): Promise<HubSpotNativeSyncResult> {
  const credentialsStore = createDefaultCredentialsStore(config);
  const tokens = await ensureFreshTokens(db, config, credentialsStore, workspaceId);
  const connectionId = await getHubSpotConnectionId(db, workspaceId);
  if (!connectionId) throw new HttpError("hubspot_not_connected", 400);
  // COPS-09: connections from before the fix hold a placeholder portal id; webhooks need the real one.
  await ensureHubSpotPortalId(db, workspaceId, tokens.accessToken).catch((err) => log.warn("could not record the HubSpot portal id", { err, workspaceId }));

  const contactMapping = await getResolvedCrmMapping(db, workspaceId, "hubspot", "contact").catch(() => null);

  return withSyncCheckpoint(db, workspaceId, connectionId, "contact", async (sinceIso) => {
    const hubspotContacts = await searchHubSpotContactsModifiedSince(tokens.accessToken, sinceIso, maxContacts);

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let maxModifiedAt: Date | null = null;

    for (const hsContact of hubspotContacts) {
      const modifiedAtRaw = hsContact.properties?.hs_lastmodifieddate;
      const modifiedAt = modifiedAtRaw ? new Date(modifiedAtRaw) : null;
      if (modifiedAt && !Number.isNaN(modifiedAt.getTime()) && (!maxModifiedAt || modifiedAt > maxModifiedAt)) {
        maxModifiedAt = modifiedAt;
      }

      const snap = hubSpotContactToSnapshot(hsContact);
      const mapped = contactMapping ? applyInboundMapping(contactMapping, (hsContact.properties ?? {}) as Record<string, unknown>) : null;
      const patch: Record<string, unknown> = mapped ? { ...mapped.patch } : {};

      if (!patch.email && snap?.email) patch.email = snap.email.trim().toLowerCase();
      if (!patch.email) {
        skipped++;
        continue;
      }
      const email = String(patch.email).trim().toLowerCase();

      if (!patch.title && snap?.title) patch.title = snap.title;
      if (!patch.phone && snap?.phone) patch.phone = snap.phone;
      if (!patch.firstName && snap?.fullName) {
        const parts = snap.fullName.trim().split(/\s+/);
        patch.firstName = parts[0];
        if (parts.length > 1) patch.lastName = parts.slice(1).join(" ");
      }

      const [existing] = await db
        .select()
        .from(contacts)
        .where(scopedTo(contacts, workspaceId, eq(contacts.email, email), isNull(contacts.deletedAt)))
        .limit(1);

      // ADR 0014 account scope: with a limited scope, only contacts of in-scope accounts sync, and
      // no new records are created.
      if (scope && !isCompanyInScope(scope, existing ? existing.companyId : undefined)) {
        skipped++;
        continue;
      }

      const companyId = snap?.companyName
        ? await findOrCreateCompany(db, workspaceId, snap.companyName, snap.companyDomain ?? null)
        : null;

      let skoutContactId: string | undefined = existing?.id;

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
          skoutContactId = row.id;
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
      } else {
        const eligiblePatch = await conflictCheckedPatch(db, {
          workspaceId,
          connectionId,
          entityType: "contact",
          existing: existing as unknown as Record<string, unknown> & { id: string; updatedAt: Date | null },
          externalId: hsContact.id,
          modifiedAt,
          mapping: contactMapping,
          patch,
        });

        const existingSources = asFieldSourcesMap(existing.fieldSources);
        const evidenceByAttribute = await getLatestEvidenceByAttribute(db, workspaceId, "contact", existing.id);
        const { applied } = filterAutoFillablePatch(eligiblePatch, existingSources, evidenceByAttribute);
        const appliedFields = Object.keys(applied);

        if (appliedFields.length === 0) {
          skipped++;
        } else {
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
      }

      if (skoutContactId) {
        await upsertCrmNativeLink(db, workspaceId, connectionId, "contact", skoutContactId, hsContact.id, modifiedAt);
      }
    }

    return {
      result: { pulled: hubspotContacts.length, created, updated, skipped },
      maxModifiedAt,
    };
  });
}

export interface HubSpotDealSyncResult {
  pulled: number;
  created: number;
  updated: number;
  skipped: number;
}

/**
 * §8.12 Task ADI-10 — pull HubSpot deals modified since the last checkpoint into native CRM,
 * with manual-wins conflict rules on amount, then advance the checkpoint and refresh each pulled
 * deal's crm_native_links row (see syncHubSpotContactsToNativeCrm's doc comment).
 */
export async function syncHubSpotDealsToNativeCrm(
  db: Db,
  config: Env,
  workspaceId: string,
  maxDeals = 200,
  scope: CrmSyncScope | null = null
): Promise<HubSpotDealSyncResult> {
  const credentialsStore = createDefaultCredentialsStore(config);
  const tokens = await ensureFreshTokens(db, config, credentialsStore, workspaceId);
  const connectionId = await getHubSpotConnectionId(db, workspaceId);
  if (!connectionId) throw new HttpError("hubspot_not_connected", 400);

  const [pipeline] = await db
    .select()
    .from(pipelines)
    .where(scopedTo(pipelines, workspaceId, isNull(pipelines.deletedAt)))
    .limit(1);
  const [stage] = pipeline
    ? await db.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipeline.id)).limit(1)
    : [];

  const dealMapping = await getResolvedCrmMapping(db, workspaceId, "hubspot", "deal").catch(() => null);

  return withSyncCheckpoint(db, workspaceId, connectionId, "deal", async (sinceIso) => {
    const hubspotDeals = await searchHubSpotDealsModifiedSince(tokens.accessToken, sinceIso, maxDeals);

    if (!pipeline || !stage) {
      if (!pipeline) log.warn("no CRM pipeline — skipping HubSpot deal sync", { workspaceId });
      return {
        result: { pulled: hubspotDeals.length, created: 0, updated: 0, skipped: hubspotDeals.length },
        maxModifiedAt: null,
      };
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let maxModifiedAt: Date | null = null;

    for (const hs of hubspotDeals) {
      const modifiedAtRaw = hs.properties?.hs_lastmodifieddate;
      const modifiedAt = modifiedAtRaw ? new Date(modifiedAtRaw) : null;
      if (modifiedAt && !Number.isNaN(modifiedAt.getTime()) && (!maxModifiedAt || modifiedAt > maxModifiedAt)) {
        maxModifiedAt = modifiedAt;
      }

      const mapped = dealMapping ? applyInboundMapping(dealMapping, (hs.properties ?? {}) as Record<string, unknown>) : null;
      const patch: Record<string, unknown> = mapped ? { ...mapped.patch } : {};

      const name = (patch.name as string | undefined)?.trim() ?? hs.properties?.dealname?.trim();
      if (!name) {
        skipped++;
        continue;
      }
      const amount = patch.amount != null ? String(patch.amount) : hs.properties?.amount ? hs.properties.amount : undefined;
      if (amount != null && amount !== "") patch.amount = amount;

      const [existing] = await db
        .select()
        .from(deals)
        .where(scopedTo(deals, workspaceId, eq(deals.name, name), isNull(deals.deletedAt)))
        .limit(1);

      if (scope && !isCompanyInScope(scope, existing ? existing.companyId : undefined)) {
        skipped++;
        continue;
      }

      let skoutDealId: string | undefined = existing?.id;

      if (!existing) {
        const [row] = await db
          .insert(deals)
          .values({
            workspaceId,
            pipelineId: pipeline.id,
            stageId: stage.id,
            name,
            amount: amount ?? null,
            fieldSources: mergeAutoFillSources({}, amount ? ["amount"] : [], "enrichment", undefined),
          })
          .returning();
        created++;
        skoutDealId = row?.id;
      } else {
        const eligiblePatch = await conflictCheckedPatch(db, {
          workspaceId,
          connectionId,
          entityType: "deal",
          existing: existing as unknown as Record<string, unknown> & { id: string; updatedAt: Date | null },
          externalId: hs.id,
          modifiedAt,
          mapping: dealMapping,
          patch,
        });

        const existingSources = asFieldSourcesMap(existing.fieldSources);
        const evidenceByAttribute = await getLatestEvidenceByAttribute(db, workspaceId, "deal", existing.id);
        const { applied } = filterAutoFillablePatch(eligiblePatch, existingSources, evidenceByAttribute);
        const appliedFields = Object.keys(applied);

        if (appliedFields.length === 0) {
          skipped++;
        } else {
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
      }

      if (skoutDealId) {
        await upsertCrmNativeLink(db, workspaceId, connectionId, "deal", skoutDealId, hs.id, modifiedAt);
      }
    }

    return { result: { pulled: hubspotDeals.length, created, updated, skipped }, maxModifiedAt };
  });
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
  // ADR 0014: nothing syncs until an admin turns sync on for the connection.
  const scope = await getCrmSyncScope(db, workspaceId, "hubspot");
  if (!scope?.enabled) throw new HttpError("crm_sync_not_enabled", 409);
  const contactsResult = scope.contacts
    ? await syncHubSpotContactsToNativeCrm(db, config, workspaceId, opts?.maxContacts, scope)
    : { pulled: 0, created: 0, updated: 0, skipped: 0 };
  let dealsResult: HubSpotDealSyncResult | undefined;
  if (opts?.includeDeals !== false && scope.deals) {
    try {
      dealsResult = await syncHubSpotDealsToNativeCrm(db, config, workspaceId, opts?.maxDeals, scope);
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
