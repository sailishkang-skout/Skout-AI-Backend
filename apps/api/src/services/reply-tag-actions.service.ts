import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { ReplyTag } from "./reply-tagger.service.js";
import { addSuppression } from "./suppression.service.js";

const log = createLogger("reply-tag-actions");
const { inboxThreads, prospectActivations } = schema;

/**
 * Apply self-intuitive follow-up actions after an inbound reply is tagged.
 * Human replies already stop the enrollment; tags refine thread status + suppressions.
 */
export async function applyReplyTagActions(
  db: Db,
  workspaceId: string,
  threadId: string,
  tag: ReplyTag
): Promise<void> {
  const [thread] = await db
    .select({
      id: inboxThreads.id,
      prospectId: inboxThreads.prospectId,
      status: inboxThreads.status,
    })
    .from(inboxThreads)
    .where(and(eq(inboxThreads.workspaceId, workspaceId), eq(inboxThreads.id, threadId)))
    .limit(1);

  if (!thread) return;

  const now = new Date();

  if (tag === "meeting_request" && thread.status !== "meeting_booked" && thread.status !== "closed") {
    await db
      .update(inboxThreads)
      .set({ status: "meeting_booked", statusChangedAt: now, updatedAt: now })
      .where(eq(inboxThreads.id, threadId));
    log.info("reply-tag-actions: marked meeting_booked", { threadId, workspaceId });
    return;
  }

  if (tag === "unsubscribe") {
    await db
      .update(inboxThreads)
      .set({ status: "closed", statusChangedAt: now, updatedAt: now })
      .where(eq(inboxThreads.id, threadId));

    if (thread.prospectId) {
      const [activation] = await db
        .select({ snapshot: prospectActivations.snapshot })
        .from(prospectActivations)
        .where(
          and(
            eq(prospectActivations.workspaceId, workspaceId),
            eq(prospectActivations.prospectId, thread.prospectId)
          )
        )
        .limit(1);
      const email = (activation?.snapshot as Record<string, unknown> | undefined)?.email;
      if (typeof email === "string" && email.includes("@")) {
        await addSuppression(db, workspaceId, email, "unsubscribed");
        log.info("reply-tag-actions: suppressed on unsubscribe tag", {
          threadId,
          workspaceId,
        });
      }
    }
  }
}
