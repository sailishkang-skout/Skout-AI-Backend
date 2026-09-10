import { desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";

const { inboxThreads, inboxMessages } = schema;

export interface OutcomeInsights {
  windowDays: number;
  sent: number;
  replies: number;
  bounces: number;
  replyRate: number;
  bounceRate: number;
  winningSubjects: string[];
}

const WINDOW_DAYS = 90;
const MAX_WINNING_SUBJECTS = 5;

/**
 * Computes recent outbound performance for a workspace from the inbox tables — how many emails
 * were sent, how many earned replies, how many bounced, and the subject lines that earned
 * positive replies. Feeds the AI generator so copy adapts to what actually works.
 * Returns null when there is no meaningful history yet.
 */
export async function computeOutcomeInsights(
  db: Db,
  workspaceId: string
): Promise<OutcomeInsights | null> {
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [sentRow] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(inboxMessages)
    .innerJoin(inboxThreads, eq(inboxMessages.threadId, inboxThreads.id))
    .where(
      scopedTo(inboxThreads, workspaceId, eq(inboxMessages.direction, "outbound"), gte(inboxMessages.sentAt, cutoff))
    );
  const sent = Number(sentRow?.value ?? 0);

  const [replyRow] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(inboxThreads)
    .where(
      scopedTo(inboxThreads, workspaceId, or(
          inArray(inboxThreads.status, ["replied", "meeting_booked"]),
          isNotNull(inboxThreads.replyTag)
        ))
    );
  const replies = Number(replyRow?.value ?? 0);

  const [bounceRow] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(inboxThreads)
    .where(scopedTo(inboxThreads, workspaceId, eq(inboxThreads.status, "bounced")));
  const bounces = Number(bounceRow?.value ?? 0);

  const winners = await db
    .select({ subject: inboxThreads.subject })
    .from(inboxThreads)
    .where(
      scopedTo(inboxThreads, workspaceId, or(eq(inboxThreads.replyTag, "positive"), eq(inboxThreads.status, "meeting_booked")))
    )
    .orderBy(desc(inboxThreads.lastMessageAt))
    .limit(MAX_WINNING_SUBJECTS);

  const winningSubjects = [
    ...new Set(winners.map((w) => w.subject?.trim()).filter((s): s is string => Boolean(s))),
  ];

  // No signal to learn from yet.
  if (sent === 0 && replies === 0 && bounces === 0 && winningSubjects.length === 0) {
    return null;
  }

  return {
    windowDays: WINDOW_DAYS,
    sent,
    replies,
    bounces,
    replyRate: sent > 0 ? Math.round((replies / sent) * 1000) / 10 : 0,
    bounceRate: sent > 0 ? Math.round((bounces / sent) * 1000) / 10 : 0,
    winningSubjects,
  };
}

/** Renders insights as a compact prompt fragment for the AI generator. */
export function insightsToPrompt(insights: OutcomeInsights | null): string | null {
  if (!insights) return null;
  const lines = [
    `- Last ${insights.windowDays} days: ${insights.sent} sent, ${insights.replies} replies (${insights.replyRate}% reply rate), ${insights.bounces} bounces (${insights.bounceRate}% bounce rate).`,
  ];
  if (insights.winningSubjects.length > 0) {
    lines.push(
      `- Subject lines that earned positive replies: ${insights.winningSubjects
        .map((s) => `"${s}"`)
        .join(", ")}. Match this concise, specific style.`
    );
  }
  if (insights.bounceRate > 3) {
    lines.push(
      `- Bounce rate is elevated — keep copy clean and avoid spam-trigger words to protect deliverability.`
    );
  }
  return lines.join("\n");
}
