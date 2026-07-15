import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { resolveProspectFields } from "./prospect-resolver.service.js";
import { isSuppressed, buildUnsubscribeUrl } from "./suppression.service.js";
import { pickNextInbox, markInboxUsed } from "./inbox-rotation.service.js";
import { renderTemplate, type MergeData } from "./template-render.service.js";
import { buildEmailSenderFromInbox } from "./email-sender.service.js";
import { looksLikeHtml, htmlToPlainText } from "./tracking.service.js";

const log = createLogger("ai-draft-send.service");
const { inboxThreads, inboxMessages, aiDrafts } = schema;

export type DraftSendFailureReason =
  | "prospect_email_not_found"
  | "suppressed"
  | "no_active_inbox"
  | "smtp_build_failed"
  | "send_failed";

export interface DraftSendResult {
  sent: boolean;
  reason?: DraftSendFailureReason;
  threadId?: string;
  to?: string;
}

export interface SendableDraft {
  id: string;
  workspaceId: string;
  prospectId: string;
  subject: string;
  body: string;
}

/**
 * Sends an approved AI draft as a one-off email to the prospect through a rotated inbox.
 * Used for standalone drafts (not tied to a sequence step) — enrollment-linked drafts are
 * delivered by the sequence worker instead. Tracking pixels/click-rewrites are skipped
 * because there is no enrollment/step to attribute open/click events to.
 *
 * Never throws: all failure modes return a structured result so the approval itself succeeds.
 */
export async function sendApprovedDraftEmail(
  db: Db,
  config: Env,
  draft: SendableDraft
): Promise<DraftSendResult> {
  const { workspaceId, prospectId } = draft;

  const prospect = await resolveProspectFields(config, db, workspaceId, prospectId).catch(() => null);
  if (!prospect?.email) return { sent: false, reason: "prospect_email_not_found" };

  if (await isSuppressed(db, workspaceId, prospect.email)) {
    return { sent: false, reason: "suppressed", to: prospect.email };
  }

  const inbox = await pickNextInbox(db, workspaceId);
  if (!inbox) return { sent: false, reason: "no_active_inbox", to: prospect.email };

  const mergeData: MergeData = {
    firstName: prospect.firstName,
    lastName: prospect.lastName,
    fullName: prospect.fullName,
    companyName: prospect.companyName ?? "",
    companyDomain: prospect.companyDomain ?? "",
    title: prospect.title ?? "",
    senderName: inbox.displayName ?? inbox.emailAddress,
    senderEmail: inbox.emailAddress,
    unsubscribeUrl: buildUnsubscribeUrl(config, workspaceId, prospect.email),
  };

  const subject = renderTemplate(draft.subject ?? "", mergeData);
  const renderedBody = renderTemplate(draft.body ?? "", mergeData);
  const isHtml = looksLikeHtml(renderedBody);
  const html = isHtml ? renderedBody : renderedBody.replace(/\n/g, "<br>\n");
  const text = isHtml ? htmlToPlainText(renderedBody) : renderedBody;

  let transport;
  try {
    transport = buildEmailSenderFromInbox(config, inbox);
  } catch (err: unknown) {
    log.warn("Approved draft send failed — could not build SMTP transport", { draftId: draft.id, err });
    return { sent: false, reason: "smtp_build_failed", to: prospect.email };
  }

  let externalId: string;
  try {
    const result = await transport.send({
      from: inbox.emailAddress,
      fromName: inbox.displayName,
      to: prospect.email,
      subject,
      text,
      html,
    });
    externalId = result.externalId;
  } catch (err: unknown) {
    log.error("Approved draft send failed — SMTP send", err, { draftId: draft.id });
    return { sent: false, reason: "send_failed", to: prospect.email };
  }

  const now = new Date();
  const to = prospect.email;
  const threadId = await db.transaction(async (tx) => {
    const [thread] = await tx
      .insert(inboxThreads)
      .values({
        workspaceId,
        inboxId: inbox.id,
        enrollmentId: null,
        prospectId,
        subject,
        status: "new",
        lastMessageAt: now,
      })
      .returning();
    if (!thread) throw new Error("inboxThreads insert returned no row");
    await tx.insert(inboxMessages).values({
      threadId: thread.id,
      direction: "outbound",
      fromAddress: inbox.emailAddress,
      toAddress: to,
      subject,
      bodyText: text,
      bodyHtml: html,
      externalId,
      messageId: externalId,
      sentAt: now,
    });
    await tx.update(aiDrafts).set({ threadId: thread.id }).where(eq(aiDrafts.id, draft.id));
    return thread.id;
  });

  await markInboxUsed(db, inbox.id);
  log.info("Approved AI draft sent as one-off email", { draftId: draft.id, inboxId: inbox.id, threadId });
  return { sent: true, threadId, to };
}
