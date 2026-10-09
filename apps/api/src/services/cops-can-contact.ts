import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import type { Env } from "../config/env.js";
import { isSuppressed } from "./suppression.service.js";
import { isSendBlockedByEligibility } from "./send-eligibility-guard.service.js";
import { buildConsentService } from "./consent.service.js";

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

export type CanContactBlock = "invalid_email" | "suppressed" | "channel_suppressed" | "hard_bounce" | "ineligible" | "no_consent";

export type CanContactResult = { allowed: true } | { allowed: false; reason: CanContactBlock; detail?: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function canContact(
  db: Db,
  config: Pick<Env, "EMAIL_INTEL_SERVICE_URL" | "EMAIL_INTEL_TIMEOUT_MS">,
  input: { workspaceId: string; email: string; contactId?: string | null; prospectId?: string | null; purpose: ContactPurpose }
): Promise<CanContactResult> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) return { allowed: false, reason: "invalid_email" };

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
};
