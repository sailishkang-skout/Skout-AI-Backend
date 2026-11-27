import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import type { Env } from "../config/env.js";
import { isSuppressed } from "./suppression.service.js";
import { isSendBlockedByEligibility } from "./send-eligibility-guard.service.js";
import { buildConsentService } from "./consent.service.js";
import { subscriptionAccessBlock } from "./cops-subscription-access.js";

/**
 * COPS-05 single contact gate (Bible p.41/86, ticket: "respect suppression/consent via one central
 * canContact() gate"). Every CustomerOps send and enrollment asks this one function; it combines the
 * checks that already exist in four places:
 * - workspace suppression list (unsubscribe / manual)                        -> suppressed
 * - the contact's email channel: suppressed flag or hard bounce (COPS-02)     -> channel_suppressed / hard_bounce
 * - email-intel send eligibility (fails open when the service is down)       -> ineligible
 * - for sales outreach only: an active email consent for the prospect        -> no_consent
 *
 * Purposes: `transactional` is operational mail to a customer who signed up (the onboarding email),
 * so prospect marketing consent does not apply; `outreach` is the follow-up sequence and one-click
 * rep email, which also needs consent when the contact maps to a prospect.
 * COPS-07 adds the lint rule that forbids calling the underlying checks directly.
 */
export type ContactPurpose = "transactional" | "outreach";

export type CanContactBlock = "invalid_email" | "suppressed" | "channel_suppressed" | "hard_bounce" | "ineligible" | "no_consent" | "subscription_restricted";

export type CanContactResult = { allowed: true } | { allowed: false; reason: CanContactBlock; detail?: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** One identifier of someone: what `findOptedOut` matches on. `ref` says whose it is, in the caller's own terms. */
export interface PersonIdentifier {
  ref: number;
  /** `linkedin` is a LinkedIn identity key (`in:<id>`); `phone` is digits only. */
  kind: "email" | "phone" | "prospect" | "linkedin";
  value: string;
}

export const isEmailAddress = (value: string) => EMAIL.test(value);
/** Phone numbers are compared by their digits; fewer than seven are not a number to match on. */
export const phoneDigits = (value: string) => {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 ? digits : null;
};

/**
 * Which of many people have opted out, read from the records the gate above uses, in one query (WB2-027). A person is
 * opted out when an address of theirs is on the workspace suppression list, when an email address or phone number of
 * theirs is marked do-not-contact, or when their email consent was revoked and none is active. A bounced address is not
 * an opt-out.
 *
 * Identifiers are followed to the person they belong to: a Skout prospect to its stored address, and a prospect, an
 * address or a LinkedIn identity to the CRM contact that holds it, with that contact's other addresses. A phone number
 * is only matched itself, since a number is often shared. Nothing is looked up by company, name or domain.
 *
 * Returns the `ref`s that are opted out. Why is deliberately not returned.
 */
export async function findOptedOut(db: Pick<Db, "execute">, workspaceId: string, identifiers: PersonIdentifier[]): Promise<Set<number>> {
  if (!identifiers.length) return new Set();
  const given = identifiers.map((i) => ({ ref: i.ref, kind: i.kind, value: i.kind === "email" ? i.value.trim().toLowerCase() : i.value }));
  const hits = (await db.execute(sql`
    WITH given AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(given)}::text::jsonb) AS x (ref bigint, kind text, value text)
    ),
    subject AS (
      SELECT ref, kind, value FROM given
      UNION
      SELECT g.ref, 'email', lower(btrim(p.snapshot ->> 'email'))
      FROM given g JOIN prospect_activations p ON p.workspace_id = ${workspaceId}::uuid AND p.prospect_id = g.value
      WHERE g.kind = 'prospect' AND p.snapshot ->> 'email' <> ''
    ),
    person AS (
      SELECT s.ref, c.id, c.email, c.source_prospect_id
      FROM subject s JOIN contacts c ON c.workspace_id = ${workspaceId}::uuid AND c.source_prospect_id = s.value
      WHERE s.kind = 'prospect'
      UNION
      SELECT s.ref, c.id, c.email, c.source_prospect_id
      FROM subject s JOIN contacts c ON c.workspace_id = ${workspaceId}::uuid AND lower(btrim(c.email)) = s.value
      WHERE s.kind = 'email'
      UNION
      SELECT s.ref, c.id, c.email, c.source_prospect_id
      FROM subject s
      JOIN contact_channels h ON h.workspace_id = ${workspaceId}::uuid AND h.channel = 'email' AND lower(btrim(h.value)) = s.value
      JOIN contacts c ON c.workspace_id = h.workspace_id AND c.id = h.contact_id
      WHERE s.kind = 'email'
      UNION
      SELECT s.ref, c.id, c.email, c.source_prospect_id
      FROM subject s
      JOIN enrichment_identities i ON i.workspace_id = ${workspaceId}::uuid AND i.entity_type = 'person' AND i.canonical_key = s.value
      JOIN contacts c ON c.workspace_id = i.workspace_id AND c.id = i.entity_id
      WHERE s.kind = 'linkedin'
    ),
    known AS (
      SELECT ref, kind, value FROM subject
      UNION SELECT ref, 'email', lower(btrim(email)) FROM person WHERE email IS NOT NULL
      UNION SELECT ref, 'prospect', source_prospect_id FROM person WHERE source_prospect_id IS NOT NULL
      UNION SELECT ref, 'contact', id::text FROM person
    )
    SELECT k.ref FROM known k JOIN suppressions s ON s.workspace_id = ${workspaceId}::uuid AND s.email = k.value WHERE k.kind = 'email'
    UNION
    SELECT k.ref FROM known k
    JOIN consents r ON r.workspace_id = ${workspaceId}::uuid AND r.type = 'email' AND r.revoked_at IS NOT NULL AND lower(r.subject_id) = lower(k.value)
    WHERE k.kind IN ('email', 'prospect', 'contact')
      AND NOT EXISTS (
        SELECT 1 FROM consents a
        WHERE a.workspace_id = r.workspace_id AND a.subject_type = r.subject_type AND a.subject_id = r.subject_id AND a.type = 'email' AND a.revoked_at IS NULL)
    UNION
    SELECT k.ref FROM known k
    JOIN contact_channels h ON h.workspace_id = ${workspaceId}::uuid AND h.suppressed AND h.channel = 'phone' AND regexp_replace(h.value, '[^0-9]', '', 'g') = k.value
    WHERE k.kind = 'phone'
    UNION
    SELECT p.ref FROM person p
    JOIN contact_channels h ON h.workspace_id = ${workspaceId}::uuid AND h.contact_id = p.id AND h.suppressed AND h.channel IN ('email', 'phone')
  `)) as unknown as Array<{ ref: number }>;
  return new Set(hits.map((h) => Number(h.ref)));
}

export async function canContact(
  db: Db,
  config: Pick<Env, "EMAIL_INTEL_SERVICE_URL" | "EMAIL_INTEL_TIMEOUT_MS">,
  input: { workspaceId: string; email: string; contactId?: string | null; prospectId?: string | null; purpose: ContactPurpose }
): Promise<CanContactResult> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) return { allowed: false, reason: "invalid_email" };
  // COPS-08: outreach stops while the sending workspace has an unpaid subscription bill past day 7.
  // Transactional mail (invites, receipts, the onboarding email) still goes.
  if (input.purpose === "outreach") {
    const block = await subscriptionAccessBlock(db, input.workspaceId);
    if (block) return { allowed: false, reason: "subscription_restricted", detail: block };
  }

  if (await isSuppressed(db, input.workspaceId, email)) return { allowed: false, reason: "suppressed" };

  const { contactChannels } = schema;
  const [channel] = await db
    .select({ suppressed: contactChannels.suppressed, bounceStatus: contactChannels.bounceStatus })
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.workspaceId, input.workspaceId),
        eq(contactChannels.channel, "email"),
        sql`lower(${contactChannels.value}) = ${email}`,
        ...(input.contactId ? [eq(contactChannels.contactId, input.contactId)] : [])
      )
    )
    .orderBy(sql`${contactChannels.suppressed} desc, (${contactChannels.bounceStatus} = 'hard') desc`)
    .limit(1);
  if (channel?.suppressed) return { allowed: false, reason: "channel_suppressed" };
  if (channel?.bounceStatus === "hard") return { allowed: false, reason: "hard_bounce" };

  const eligibility = await isSendBlockedByEligibility(config, email);
  if (eligibility.blocked) return { allowed: false, reason: "ineligible", detail: eligibility.reason };

  if (input.purpose === "outreach" && input.prospectId) {
    const consent = buildConsentService(db);
    if (consent && !(await consent.hasActive(input.workspaceId, "prospect", input.prospectId, "email"))) {
      return { allowed: false, reason: "no_consent" };
    }
  }
  return { allowed: true };
}

export const CAN_CONTACT_MESSAGE: Record<CanContactBlock, string> = {
  invalid_email: "The contact has no valid email address",
  suppressed: "The address is on the workspace suppression list (unsubscribed or blocked)",
  channel_suppressed: "The contact's email is marked do-not-contact",
  hard_bounce: "The contact's email hard-bounced",
  ineligible: "The address failed the send-eligibility check",
  no_consent: "No active email consent for this contact",
  subscription_restricted: "Outreach is paused because this workspace has an unpaid subscription bill",
};
