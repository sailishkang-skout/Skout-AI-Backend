import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { appendCopsEvent, createCopsEvent } from "@skout/shared";
import type { Env } from "../config/env.js";
import { sendMail, type MailOptions, type SendMailResult } from "./mail.service.js";
import { writeCopsAudit } from "./cops-platform.service.js";
import { loadProvisionings, type ProvisioningDto } from "./cops-provisioning.service.js";
import { canContact, CAN_CONTACT_MESSAGE, type CanContactBlock } from "./cops-can-contact.js";
import { chooseOnboardingTemplate } from "./cops-onboarding-templates.js";

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-05 additions).
 *   - Tables touched directly: contacts - read (recipient email and first name of the account's contact);
 *     companies - row lock only (serialises the first send per account) (owned by apps/crm)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: the recipient check, the first-send check and the send row are one transaction with the
 *     account lock; an HTTP call into apps/crm cannot take part in it.
 *   - Review date: revisit when apps/crm's internal API covers transactional reads
 */

/**
 * COPS-05 onboarding email (Bible p.41): rendered from the account's provisioning, refused by the
 * canContact() gate when the recipient must not be emailed, sent once per Idempotency-Key, and a
 * second send for the same recipient only as an explicit, audited re-send. A sent email emits
 * WelcomeEmailSent, which starts the follow-up (enrollment or task).
 */
const { copsOnboardingEmailSends, contacts, copsActivationTemplates, copsOnboardingInstances, copsOnboardingMilestones } = schema;

export type OnboardingErrorCode = "NOT_FOUND" | "NOT_PROVISIONED" | "VALIDATION_FAILED" | "ALREADY_SENT" | "CONTACT_BLOCKED" | "EMAIL_NOT_SENT";

export class OnboardingError extends Error {
  constructor(
    readonly code: OnboardingErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "OnboardingError";
  }

  get status(): number {
    switch (this.code) {
      case "NOT_FOUND":
      case "NOT_PROVISIONED":
        return 404;
      case "VALIDATION_FAILED":
        return 422;
      case "ALREADY_SENT":
      case "CONTACT_BLOCKED":
        return 409;
      case "EMAIL_NOT_SENT":
        return 502;
    }
  }

  get retryable(): boolean {
    return this.code === "EMAIL_NOT_SENT";
  }
}

export interface OnboardingContext {
  workspaceId: string;
  userId: string;
  requestId: string;
}

export interface OnboardingDeps {
  config: Pick<Env, "EMAIL_INTEL_SERVICE_URL" | "EMAIL_INTEL_TIMEOUT_MS">;
  /** Defaults to sendMail (Resend, else SMTP). Tests pass a fake. */
  send: (mail: MailOptions) => Promise<SendMailResult>;
  appBaseUrl: string;
  inviteBaseUrl: string;
  resourcesUrl: string;
  supportEmail: string;
}

export function defaultOnboardingDeps(config: Env): OnboardingDeps {
  const app = config.FRONTEND_URL ?? "http://localhost:3000";
  return {
    config,
    send: (mail) => sendMail(config, mail),
    appBaseUrl: app,
    inviteBaseUrl: config.INVITE_BASE_URL ?? app,
    resourcesUrl: `${app.replace(/\/$/, "")}/guides`,
    supportEmail: "support@skoutai.io",
  };
}

export interface OnboardingSendInput {
  contact_id?: string;
  template_key?: string;
  booking_url?: string;
  resend?: boolean;
  reason?: string;
}

export interface EmailSendDto {
  id: string;
  account_id: string;
  contact_id: string | null;
  to: string;
  template_key: string;
  template_version: number;
  subject: string;
  status: string;
  is_resend: boolean;
  reason: string | null;
  error: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  sent_at: string | null;
  created_at: string;
}

function toDto(r: typeof copsOnboardingEmailSends.$inferSelect): EmailSendDto {
  return {
    id: r.id,
    account_id: r.accountId,
    contact_id: r.contactId,
    to: r.toEmail,
    template_key: r.templateKey,
    template_version: r.templateVersion,
    subject: r.subject,
    status: r.status,
    is_resend: r.isResend,
    reason: r.reason,
    error: r.error,
    opened_at: r.openedAt?.toISOString() ?? null,
    clicked_at: r.clickedAt?.toISOString() ?? null,
    sent_at: r.sentAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
  };
}

interface Target {
  provisioning: ProvisioningDto;
  to: string;
  contactId: string | null;
  customerName: string;
  workspaceName: string;
}

/** The account's provisioned workspace and who the email goes to (the invited admin by default). */
async function loadTarget(db: Db, ctx: OnboardingContext, accountId: string, input: OnboardingSendInput, deps: OnboardingDeps): Promise<Target> {
  const provisioning = (await loadProvisionings(db, ctx.workspaceId, { accountId }, { inviteBaseUrl: deps.inviteBaseUrl })).find(
    (p) => p.status === "succeeded"
  );
  if (!provisioning?.provisioned_workspace_id) {
    throw new OnboardingError("NOT_PROVISIONED", "The account has no provisioned workspace yet; provision a trial first");
  }
  const [ws] = await db
    .select({ name: schema.workspaces.name })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, provisioning.provisioned_workspace_id));

  let to = provisioning.admin_invite?.email ?? null;
  let contactId: string | null = null;
  let customerName = "there";
  if (input.contact_id) {
    const [c] = await db
      .select({ id: contacts.id, email: contacts.email, firstName: contacts.firstName })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, ctx.workspaceId), eq(contacts.id, input.contact_id), eq(contacts.companyId, accountId)));
    if (!c) throw new OnboardingError("NOT_FOUND", "Contact not found on this account", { field: "contact_id" });
    if (!c.email) throw new OnboardingError("VALIDATION_FAILED", "The contact has no email address", { fields: [{ path: "contact_id", message: "No email" }] });
    to = c.email;
    contactId = c.id;
    customerName = c.firstName || customerName;
  } else if (to) {
    const [c] = await db
      .select({ id: contacts.id, firstName: contacts.firstName })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, ctx.workspaceId), eq(contacts.companyId, accountId), sql`lower(${contacts.email}) = ${to.toLowerCase()}`))
      .limit(1);
    if (c) {
      contactId = c.id;
      customerName = c.firstName || customerName;
    }
  }
  if (!to) throw new OnboardingError("VALIDATION_FAILED", "No recipient: pass contact_id", { fields: [{ path: "contact_id", message: "Required" }] });
  return { provisioning, to: to.trim(), contactId, customerName, workspaceName: ws?.name ?? "your workspace" };
}

/** Activation steps for the email body: the required milestones of the account's (or the default) template. */
async function activationSteps(db: Db, ctx: OnboardingContext, accountId: string): Promise<string[]> {
  const [instance] = await db
    .select({ id: copsOnboardingInstances.id })
    .from(copsOnboardingInstances)
    .where(and(eq(copsOnboardingInstances.workspaceId, ctx.workspaceId), eq(copsOnboardingInstances.accountId, accountId)));
  if (instance) {
    const rows = await db
      .select({ label: copsOnboardingMilestones.label, required: copsOnboardingMilestones.required })
      .from(copsOnboardingMilestones)
      .where(eq(copsOnboardingMilestones.instanceId, instance.id));
    const req = rows.filter((r) => r.required).map((r) => r.label);
    if (req.length > 0) return req;
  }
  const [tpl] = await db
    .select({ milestones: copsActivationTemplates.milestones })
    .from(copsActivationTemplates)
    .where(and(sql`${copsActivationTemplates.workspaceId} is null`, eq(copsActivationTemplates.key, "default_trial")))
    .orderBy(desc(copsActivationTemplates.version))
    .limit(1);
  const ms = (tpl?.milestones ?? []) as Array<{ label: string; required?: boolean }>;
  return ms.filter((m) => m.required).map((m) => m.label);
}

async function render(db: Db, ctx: OnboardingContext, accountId: string, input: OnboardingSendInput, deps: OnboardingDeps) {
  const target = await loadTarget(db, ctx, accountId, input, deps);
  const template = chooseOnboardingTemplate(target.provisioning.plan, input.template_key);
  if (!template) {
    throw new OnboardingError("VALIDATION_FAILED", "Unknown template", { fields: [{ path: "template_key", message: "Unknown template" }] });
  }
  const mail = template.render({
    to: target.to,
    customerName: target.customerName,
    workspaceName: target.workspaceName,
    workspaceUrl: deps.appBaseUrl,
    inviteUrl: target.provisioning.admin_invite?.accept_url ?? null,
    trialEndsAt: target.provisioning.trial_ends_at,
    activationSteps: await activationSteps(db, ctx, accountId),
    bookingUrl: input.booking_url ?? null,
    resourcesUrl: deps.resourcesUrl,
    supportEmail: deps.supportEmail,
  });
  return { target, template, mail };
}

export async function previewOnboardingEmail(db: Db, ctx: OnboardingContext, accountId: string, input: OnboardingSendInput, deps: OnboardingDeps) {
  const { target, template, mail } = await render(db, ctx, accountId, input, deps);
  const gate = await canContact(db, deps.config, { workspaceId: ctx.workspaceId, email: target.to, contactId: target.contactId, purpose: "transactional" });
  return {
    template_key: template.key,
    template_version: template.version,
    to: mail.to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    blocked: gate.allowed ? null : gate.reason,
  };
}

export async function listOnboardingEmails(db: Db, workspaceId: string, accountId: string): Promise<EmailSendDto[]> {
  const rows = await db
    .select()
    .from(copsOnboardingEmailSends)
    .where(and(eq(copsOnboardingEmailSends.workspaceId, workspaceId), eq(copsOnboardingEmailSends.accountId, accountId)))
    .orderBy(desc(copsOnboardingEmailSends.createdAt));
  return rows.map(toDto);
}

/**
 * Sends the onboarding email. Returns `replayed: true` for a key seen before. A failed delivery
 * leaves the row `failed` (502, retryable); the same key then tries again on the same row.
 */
export async function sendOnboardingEmail(
  db: Db,
  ctx: OnboardingContext,
  accountId: string,
  idempotencyKey: string,
  input: OnboardingSendInput,
  deps: OnboardingDeps
): Promise<{ send: EmailSendDto; replayed: boolean }> {
  const resend = input.resend === true;
  const reason = input.reason?.trim() || null;
  if (resend && !reason) {
    throw new OnboardingError("VALIDATION_FAILED", "A re-send needs a reason", { fields: [{ path: "reason", message: "Required when resend is true" }] });
  }

  const [existing] = await db
    .select()
    .from(copsOnboardingEmailSends)
    .where(and(eq(copsOnboardingEmailSends.workspaceId, ctx.workspaceId), eq(copsOnboardingEmailSends.idempotencyKey, idempotencyKey)));
  if (existing && existing.accountId !== accountId) {
    throw new OnboardingError("VALIDATION_FAILED", "This Idempotency-Key was used for another account");
  }
  if (existing && existing.status !== "failed") return { send: toDto(existing), replayed: true };

  const { target, template, mail } = await render(db, ctx, accountId, input, deps);
  const gate = await canContact(db, deps.config, { workspaceId: ctx.workspaceId, email: target.to, contactId: target.contactId, purpose: "transactional" });
  if (!gate.allowed) {
    throw new OnboardingError("CONTACT_BLOCKED", CAN_CONTACT_MESSAGE[gate.reason as CanContactBlock], { reason: gate.reason, to: target.to });
  }

  let row = existing;
  if (!row) {
    // Lock the account so two different keys for the same first send cannot both pass the check.
    row = await db.transaction(async (tx) => {
      await tx.execute(sql`select id from companies where id = ${accountId} and workspace_id = ${ctx.workspaceId} for update`);
      if (!resend) {
        const [first] = await tx
          .select({ id: copsOnboardingEmailSends.id, status: copsOnboardingEmailSends.status })
          .from(copsOnboardingEmailSends)
          .where(
            and(
              eq(copsOnboardingEmailSends.workspaceId, ctx.workspaceId),
              eq(copsOnboardingEmailSends.accountId, accountId),
              sql`lower(${copsOnboardingEmailSends.toEmail}) = ${target.to.toLowerCase()}`,
              eq(copsOnboardingEmailSends.isResend, false)
            )
          );
        if (first) {
          throw new OnboardingError("ALREADY_SENT", "The onboarding email was already sent to this recipient; re-send with a reason", {
            email_send_id: first.id,
            status: first.status,
          });
        }
      }
      const [inserted] = await tx
        .insert(copsOnboardingEmailSends)
        .values({
          workspaceId: ctx.workspaceId,
          accountId,
          provisioningId: target.provisioning.id,
          contactId: target.contactId,
          toEmail: target.to,
          templateKey: template.key,
          templateVersion: template.version,
          subject: mail.subject,
          idempotencyKey,
          isResend: resend,
          reason,
          actorId: ctx.userId,
        })
        .onConflictDoNothing()
        .returning();
      return inserted ?? null;
    });
    if (!row) {
      // A concurrent request with the same key won the insert: replay it.
      const [winner] = await db
        .select()
        .from(copsOnboardingEmailSends)
        .where(and(eq(copsOnboardingEmailSends.workspaceId, ctx.workspaceId), eq(copsOnboardingEmailSends.idempotencyKey, idempotencyKey)));
      return { send: toDto(winner!), replayed: true };
    }
  }

  let result: SendMailResult;
  try {
    result = await deps.send(mail);
  } catch (err) {
    await db
      .update(copsOnboardingEmailSends)
      .set({ status: "failed", error: err instanceof Error ? err.message.slice(0, 500) : "send failed" })
      .where(eq(copsOnboardingEmailSends.id, row.id));
    throw new OnboardingError("EMAIL_NOT_SENT", "The email provider did not accept the message; retry with the same key", { email_send_id: row.id });
  }
  if (!result.sent) {
    await db
      .update(copsOnboardingEmailSends)
      .set({ status: "failed", error: "Email provider not configured" })
      .where(eq(copsOnboardingEmailSends.id, row.id));
    throw new OnboardingError("EMAIL_NOT_SENT", "No email provider is configured; nothing was sent", { email_send_id: row.id });
  }

  const sentRow = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(copsOnboardingEmailSends)
      .set({ status: "sent", sentAt: new Date(), providerMessageId: result.messageId ?? null, error: null })
      .where(eq(copsOnboardingEmailSends.id, row!.id))
      .returning();
    const actor = { type: "user" as const, id: ctx.userId };
    await appendCopsEvent(
      tx as never,
      createCopsEvent({
        eventType: "WelcomeEmailSent",
        tenantId: ctx.workspaceId,
        aggregateType: "account",
        aggregateId: accountId,
        actor,
        correlationId: ctx.requestId,
        payload: { account_id: accountId, email_send_id: updated!.id },
      })
    );
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor,
      entityType: "onboarding_email",
      entityId: updated!.id,
      action: resend ? "onboarding_email.resent" : "onboarding_email.sent",
      after: { account_id: accountId, to: target.to, template_key: template.key, template_version: template.version },
      ...(resend ? { reason: reason!, override: true } : {}),
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    return updated!;
  });
  return { send: toDto(sentRow), replayed: false };
}
