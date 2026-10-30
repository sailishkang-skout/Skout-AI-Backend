import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import type { Env } from "../config/env.js";
import { SearchService } from "./search.service.js";

const { enrichmentResults, prospectActivations, contacts, companies } = schema;

/** A CustomerOps contact enrolled straight into a sequence, without a corpus prospect (owner decision, Oct 2026). */
export const CONTACT_PROSPECT_PREFIX = "contact:";
export const contactProspectId = (contactId: string) => `${CONTACT_PROSPECT_PREFIX}${contactId}`;

/** Free-mail domains — corpus often has these; enrichment usually returns work email. */
const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.in",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
]);

export interface ResolvedProspect {
  prospectId: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  firstName: string;
  lastName: string;
  fullName: string;
  companyName?: string;
  companyDomain?: string;
  title?: string;
  location?: string;
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

function emailDomain(email: string): string {
  return email.split("@")[1]?.trim().toLowerCase() ?? "";
}

function isPersonalEmail(email: string): boolean {
  return PERSONAL_EMAIL_DOMAINS.has(emailDomain(email));
}

/**
 * Resolves a prospectId to the fields needed for merge tokens + the send-to address.
 *
 * Email precedence:
 * 1. OpenSearch personal/free-mail address (what search shows; preferred for deliverability tests)
 * 2. Activation snapshot email
 * 3. enrichmentResults primary (then any)
 * 4. Any OpenSearch email
 *
 * Previously snapshot always beat OpenSearch, so enriched work emails (e.g. first.last@company)
 * hid corpus Gmail and sequences sent to the wrong inbox.
 */
export async function resolveProspectFields(
  env: Env,
  db: Db,
  workspaceId: string,
  prospectId: string
): Promise<ResolvedProspect | null> {
  if (prospectId.startsWith(CONTACT_PROSPECT_PREFIX)) return resolveContactProspect(db, workspaceId, prospectId);
  const search = new SearchService(env, db);
  // OpenSearch lookup — may return null for manually-created prospects
  const doc = await search.findExistingProspect(prospectId).catch(() => null);

  const [activation] = await db
    .select()
    .from(prospectActivations)
    .where(
      scopedTo(prospectActivations, workspaceId, eq(prospectActivations.prospectId, prospectId))
    );
  const snap = (activation?.snapshot ?? {}) as Record<string, unknown>;

  // If no OpenSearch doc AND no activation snapshot, prospect is unresolvable
  if (!doc && !activation) return null;

  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;

  const snapshotEmail = str(snap.email);
  const snapshotFullName = str(snap.fullName);
  const snapshotFirstName = str(snap.firstName);
  const snapshotLastName = str(snap.lastName);
  const docEmail = str(doc?.email);

  const rows = await db
    .select({ fieldValue: enrichmentResults.fieldValue, isPrimary: enrichmentResults.isPrimary })
    .from(enrichmentResults)
    .where(
      scopedTo(enrichmentResults, workspaceId, inArray(enrichmentResults.prospectId, [prospectId]), eq(enrichmentResults.fieldName, "email"))
    )
    .orderBy(desc(enrichmentResults.createdAt));
  const primary = rows.find((r) => r.isPrimary && r.fieldValue);
  const enrichedEmail = primary?.fieldValue ?? rows.find((r) => r.fieldValue)?.fieldValue ?? undefined;

  const phoneRows = await db
    .select({ fieldValue: enrichmentResults.fieldValue, isPrimary: enrichmentResults.isPrimary })
    .from(enrichmentResults)
    .where(
      scopedTo(enrichmentResults, workspaceId, inArray(enrichmentResults.prospectId, [prospectId]), eq(enrichmentResults.fieldName, "phone"))
    )
    .orderBy(desc(enrichmentResults.createdAt));
  const primaryPhone = phoneRows.find((r) => r.isPrimary && r.fieldValue);
  const enrichedPhone =
    primaryPhone?.fieldValue ?? phoneRows.find((r) => r.fieldValue)?.fieldValue ?? undefined;

  let email: string | undefined;
  if (docEmail && isPersonalEmail(docEmail)) {
    email = docEmail;
  } else {
    email = snapshotEmail ?? enrichedEmail ?? docEmail ?? undefined;
  }

  const fullName = doc?.fullName ?? snapshotFullName ?? "";
  const { firstName, lastName } = snapshotFirstName
    ? { firstName: snapshotFirstName, lastName: snapshotLastName ?? "" }
    : splitName(fullName);

  return {
    prospectId,
    email,
    phone: str(snap.phone) ?? enrichedPhone ?? undefined,
    linkedinUrl: str(snap.linkedinUrl) ?? doc?.linkedinUrl ?? undefined,
    firstName,
    lastName,
    fullName,
    companyName: doc?.companyName ?? str(snap.companyName) ?? undefined,
    companyDomain: doc?.companyDomain ?? str(snap.companyDomain) ?? undefined,
    title: doc?.title || str(snap.title) || undefined,
    location: (() => {
      const fromDoc = [doc?.city, doc?.state, doc?.country]
        .filter((p): p is string => Boolean(p))
        .join(", ");
      return str(snap.location) ?? str(snap.hqCountry) ?? (fromDoc || undefined);
    })(),
  };
}

/** Sequence fields for a CustomerOps contact (prospect id "contact:<uuid>"), scoped to the workspace. */
async function resolveContactProspect(db: Db, workspaceId: string, prospectId: string): Promise<ResolvedProspect | null> {
  const contactId = prospectId.slice(CONTACT_PROSPECT_PREFIX.length);
  const [row] = await db
    .select({
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      title: contacts.title,
      linkedinUrl: contacts.linkedinUrl,
      companyName: companies.name,
      companyDomain: companies.domain,
    })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.id, contactId), isNull(contacts.deletedAt)))
    .limit(1)
    .catch(() => []);
  if (!row) return null;
  const firstName = row.firstName ?? "";
  const lastName = row.lastName ?? "";
  return {
    prospectId,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    linkedinUrl: row.linkedinUrl ?? undefined,
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
    companyName: row.companyName ?? undefined,
    companyDomain: row.companyDomain ?? undefined,
    title: row.title ?? undefined,
  };
}
