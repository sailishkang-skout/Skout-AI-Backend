import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";

/**
 * COPS-05 onboarding email delivery tracking (Bible p.41: "record send/delivery/bounce/open/click
 * where provider and privacy rules allow"). Resend posts Svix-signed webhooks; we verify the
 * signature, find the send by the provider message id and record only timestamps (no IP, no user
 * agent). Each timestamp is set once, so a redelivered webhook changes nothing. A permanent bounce
 * also marks the contact's email channel `hard`, which canContact() then refuses and the onboarding
 * evaluator turns into a rep task.
 */
const { copsOnboardingEmailSends, contactChannels } = schema;

const TOLERANCE_S = 5 * 60;

/** Svix signature check: base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)), secret `whsec_<base64>`. */
export function verifySvixSignature(
  secret: string | undefined,
  headers: { id?: string; timestamp?: string; signature?: string },
  rawBody: string,
  nowS = Math.floor(Date.now() / 1000)
): boolean {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowS - ts) > TOLERANCE_S) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.${rawBody}`).digest();
  return headers.signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export interface ResendEvent {
  type: string;
  created_at?: string;
  data?: { email_id?: string; bounce?: { type?: string } };
}

export type EmailEventOutcome = "applied" | "unchanged" | "unknown_email" | "ignored";

export async function applyResendEvent(db: Db, event: ResendEvent): Promise<EmailEventOutcome> {
  const messageId = event.data?.email_id;
  if (!messageId) return "ignored";
  const at = event.created_at ? new Date(event.created_at) : new Date();
  const [send] = await db
    .select({ id: copsOnboardingEmailSends.id, workspaceId: copsOnboardingEmailSends.workspaceId, contactId: copsOnboardingEmailSends.contactId, toEmail: copsOnboardingEmailSends.toEmail })
    .from(copsOnboardingEmailSends)
    .where(eq(copsOnboardingEmailSends.providerMessageId, messageId));
  if (!send) return "unknown_email";

  const byId = eq(copsOnboardingEmailSends.id, send.id);
  let updated: Array<{ id: string }> = [];
  switch (event.type) {
    case "email.delivered":
      updated = await db
        .update(copsOnboardingEmailSends)
        .set({ deliveredAt: at, status: sql`case when ${copsOnboardingEmailSends.status} = 'sent' then 'delivered' else ${copsOnboardingEmailSends.status} end` })
        .where(and(byId, isNull(copsOnboardingEmailSends.deliveredAt)))
        .returning({ id: copsOnboardingEmailSends.id });
      break;
    case "email.opened":
      updated = await db.update(copsOnboardingEmailSends).set({ openedAt: at }).where(and(byId, isNull(copsOnboardingEmailSends.openedAt))).returning({ id: copsOnboardingEmailSends.id });
      break;
    case "email.clicked":
      updated = await db.update(copsOnboardingEmailSends).set({ clickedAt: at }).where(and(byId, isNull(copsOnboardingEmailSends.clickedAt))).returning({ id: copsOnboardingEmailSends.id });
      break;
    case "email.bounced": {
      updated = await db
        .update(copsOnboardingEmailSends)
        .set({ bouncedAt: at, status: "bounced" })
        .where(and(byId, isNull(copsOnboardingEmailSends.bouncedAt)))
        .returning({ id: copsOnboardingEmailSends.id });
      const permanent = (event.data?.bounce?.type ?? "Permanent").toLowerCase() !== "transient";
      if (updated.length > 0 && permanent && send.contactId) {
        const email = send.toEmail.trim().toLowerCase();
        const changed = await db
          .update(contactChannels)
          .set({ bounceStatus: "hard" })
          .where(and(eq(contactChannels.workspaceId, send.workspaceId), eq(contactChannels.contactId, send.contactId), eq(contactChannels.channel, "email"), sql`lower(${contactChannels.value}) = ${email}`))
          .returning({ id: contactChannels.id });
        if (changed.length === 0) {
          await db
            .insert(contactChannels)
            .values({ workspaceId: send.workspaceId, contactId: send.contactId, channel: "email", value: email, bounceStatus: "hard" })
            .onConflictDoNothing();
        }
      }
      break;
    }
    default:
      return "ignored";
  }
  return updated.length > 0 ? "applied" : "unchanged";
}
