import { eq, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { createLogger } from "@skout/observability";
import { normalizeDomain, normalizeEmail } from "@skout/shared";
import { recordEvidence } from "./evidence.service.js";

const log = createLogger("prospect-crm-link");
const { contacts, companies, prospectActivations } = schema;

export interface ProspectCrmLinkResult {
  contactId: string | null;
  companyId: string | null;
  created: boolean;
}

/**
 * §5.2 / §7.1 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) — see
 * docs/adr/0003-read-model-exceptions.md. ENR-01 adds prospect↔CRM identity linkage.
 *   - Tables touched directly: contacts, companies (both owned by apps/crm)
 *     - read AND write
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: ensure prospect↔CRM identity consistency during activation and sequence
 *     enrollment; required for source-truth identity tracking and account domain matching.
 *     Future: migrate to apps/crm's internal HTTP API surface (Wave 2+).
 *   - Review date: revisit once apps/crm's internal API surface fully shipped (Wave 2)
 */

/**
 * Resolve or create a native CRM contact linked via `contacts.sourceProspectId`.
 * Used on sequence enroll / activation so prospect↔CRM identity is not left open.
 * Best-effort: never throws to callers that wrap it.
 */
export async function ensureContactLinkedToProspect(
  db: Db,
  workspaceId: string,
  prospectId: string,
  opts?: {
    email?: string | null;
    fullName?: string | null;
    companyDomain?: string | null;
    companyName?: string | null;
    title?: string | null;
    linkedinUrl?: string | null;
  }
): Promise<ProspectCrmLinkResult> {
  const [existing] = await db
    .select({
      id: contacts.id,
      companyId: contacts.companyId,
      email: contacts.email,
      title: contacts.title,
      linkedinUrl: contacts.linkedinUrl,
    })
    .from(contacts)
    .where(scopedTo(contacts, workspaceId, eq(contacts.sourceProspectId, prospectId), isNull(contacts.deletedAt)))
    .limit(1);

  let email = opts?.email ? normalizeEmail(opts.email) : null;
  let fullName = opts?.fullName ?? null;
  let companyDomain = opts?.companyDomain ? normalizeDomain(opts.companyDomain) : null;
  let companyName = opts?.companyName ?? null;
  const title = opts?.title ?? null;
  const linkedinUrl = opts?.linkedinUrl ?? null;

  if (!email || !fullName) {
    const [activation] = await db
      .select({ snapshot: prospectActivations.snapshot })
      .from(prospectActivations)
      .where(scopedTo(prospectActivations, workspaceId, eq(prospectActivations.prospectId, prospectId)))
      .limit(1);
    const snap = (activation?.snapshot ?? {}) as Record<string, unknown>;
    email = email ?? (typeof snap.email === "string" ? normalizeEmail(snap.email) : null);
    fullName =
      fullName ??
      (typeof snap.fullName === "string"
        ? snap.fullName
        : typeof snap.firstName === "string"
          ? [snap.firstName, snap.lastName].filter(Boolean).join(" ")
          : null);
    companyDomain = companyDomain ?? (typeof snap.companyDomain === "string" ? normalizeDomain(snap.companyDomain) : null);
    companyName = companyName ?? (typeof snap.companyName === "string" ? snap.companyName : null);
  }

  let companyId: string | null = existing?.companyId ?? null;
  if (companyDomain || companyName) {
    if (!companyId && companyDomain) {
      const [byDomain] = await db
        .select({ id: companies.id })
        .from(companies)
        .where(scopedTo(companies, workspaceId, eq(companies.domain, companyDomain), isNull(companies.deletedAt)))
        .limit(1);
      companyId = byDomain?.id ?? null;
    }
    if (!companyId && companyName) {
      const [createdCo] = await db
        .insert(companies)
        .values({
          workspaceId,
          name: companyName,
          domain: companyDomain ?? undefined,
          sourceProspectCompanyId: null,
          fieldSources: {},
        })
        .returning({ id: companies.id });
      companyId = createdCo?.id ?? null;
    }
  }

  const parts = (fullName ?? email?.split("@")[0] ?? "Prospect").trim().split(/\s+/);
  const firstName = parts[0] ?? "Prospect";
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;

  if (existing) {
    const contactUpdates = {
      ...(existing.companyId === null && companyId ? { companyId } : {}),
      ...(!existing.email && email ? { email } : {}),
      ...(!existing.title && title ? { title } : {}),
      ...(!existing.linkedinUrl && linkedinUrl ? { linkedinUrl } : {}),
    };
    if (Object.keys(contactUpdates).length > 0) {
      await db
        .update(contacts)
        .set({ ...contactUpdates, updatedAt: new Date() })
        .where(scopedTo(contacts, workspaceId, eq(contacts.id, existing.id), isNull(contacts.deletedAt)));
    }
    return { contactId: existing.id, companyId: existing.companyId ?? companyId, created: false };
  }

  const [row] = await db
    .insert(contacts)
    .values({
      workspaceId,
      firstName,
      lastName,
      email: email ?? undefined,
      companyId,
      title: title ?? undefined,
      linkedinUrl: linkedinUrl ?? undefined,
      sourceProspectId: prospectId,
      fieldSources: {},
    })
    .returning({ id: contacts.id });

  if (!row) return { contactId: null, companyId, created: false };

  try {
    await recordEvidence(db, {
      workspaceId,
      entityType: "contact",
      entityId: row.id,
      attribute: "sourceProspectId",
      value: prospectId,
      source: "identity_link",
      observedAt: new Date(),
      confidence: 1,
      method: "ensure_contact_linked_to_prospect",
    });
  } catch (err) {
    log.warn("evidence write failed for prospect↔CRM link", { err });
  }

  log.info("created CRM contact linked to prospect", { workspaceId, prospectId, contactId: row.id });
  try {
    const { incrJourneyMetric } = await import("./journey-metrics.js");
    incrJourneyMetric("prospectCrmLink");
  } catch {
    /* ignore */
  }
  return { contactId: row.id, companyId, created: true };
}