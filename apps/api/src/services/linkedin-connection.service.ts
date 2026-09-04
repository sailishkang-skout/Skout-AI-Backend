import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import {
  linkedinPublicIdentifierFromUrl,
  unipileListRelations,
} from "./unipile.client.js";
import { LinkedinAccountService } from "./linkedin-account.service.js";

const log = createLogger("linkedin-connection");
const { linkedinConnections } = schema;

/**
 * A real, dedicated LinkedIn connection-state table (condition-engine spec) — this replaces
 * inferring "accepted" from linkedin_outreach_jobs.status, which was actively wrong: that job's
 * status flips to "completed" the moment the connection REQUEST is successfully sent, not when
 * the prospect actually accepts it. See linkedinInviteState() in sequence-enrollment.worker.ts.
 *
 * Unipile has no reliable webhook/signal for an explicit decline, so this only ever resolves to
 * "accepted" or stays "pending" — a stalled "pending" past the condition step's own
 * conditionWaitDays timeout is handled by the existing fallback-branch mechanism, not by this
 * service inventing a "declined" state it can't actually know.
 */

/** Re-poll Unipile at most this often per prospect — avoids hammering the relations API on
 * every single condition evaluation (a condition can be re-checked many times while a step
 * waits out its conditionWaitDays window). */
const RECHECK_INTERVAL_MS = 15 * 60 * 1000;

/** Bounds how many first-degree relations we page through looking for a match, per account,
 * per check — a hard cap so a prolific SDR's connection list can't turn one condition
 * evaluation into an unbounded number of Unipile API calls. */
const MAX_RELATION_PAGES = 3;
const RELATIONS_PAGE_SIZE = 100;

export type LinkedinConnectionStatus = "pending" | "accepted";

async function findAcceptedAcrossAccounts(
  config: Env,
  accountIds: string[],
  publicIdentifier: string
): Promise<boolean> {
  for (const accountId of accountIds) {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_RELATION_PAGES; page++) {
      let result;
      try {
        result = await unipileListRelations(config, {
          accountId,
          limit: RELATIONS_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        });
      } catch (err) {
        log.warn("linkedin-connection: relations list failed, treating as not-yet-accepted", {
          accountId,
          err,
        });
        break;
      }
      if (result.items.some((r) => r.public_identifier === publicIdentifier)) return true;
      if (!result.cursor) break;
      cursor = result.cursor;
    }
  }
  return false;
}

/**
 * Resolves (and caches) whether a prospect has accepted a LinkedIn connection request from any
 * of the workspace's connected LinkedIn accounts. Cheap on repeated calls within
 * RECHECK_INTERVAL_MS — only actually calls Unipile when the cached row is stale or missing.
 */
export async function checkLinkedinConnectionStatus(
  config: Env,
  db: Db,
  input: { workspaceId: string; prospectId: string; linkedinUrl: string }
): Promise<LinkedinConnectionStatus> {
  const { workspaceId, prospectId, linkedinUrl } = input;

  const [existing] = await db
    .select()
    .from(linkedinConnections)
    .where(scopedTo(linkedinConnections, workspaceId, eq(linkedinConnections.prospectId, prospectId)))
    .limit(1);

  // Already confirmed accepted — this never reverts, so skip re-checking entirely.
  if (existing?.status === "accepted") return "accepted";

  const now = new Date();
  if (existing && now.getTime() - existing.checkedAt.getTime() < RECHECK_INTERVAL_MS) {
    return existing.status as LinkedinConnectionStatus;
  }

  const accounts = new LinkedinAccountService(db, config);
  const rows = await accounts.list(workspaceId, "linkedin");
  const activeAccounts = rows.filter((a) => a.status === "active");
  if (activeAccounts.length === 0) {
    // Nothing to check against — leave whatever we already had cached (or "pending" if new).
    return existing ? (existing.status as LinkedinConnectionStatus) : "pending";
  }

  const publicIdentifier = linkedinPublicIdentifierFromUrl(linkedinUrl);
  if (!publicIdentifier) {
    log.warn("linkedin-connection: could not extract a public identifier from URL", {
      workspaceId,
      prospectId,
      linkedinUrl,
    });
    return existing ? (existing.status as LinkedinConnectionStatus) : "pending";
  }

  const resolvedConfig = await accounts.resolveConfig(workspaceId);
  const accepted = await findAcceptedAcrossAccounts(
    resolvedConfig,
    activeAccounts.map((a) => a.unipileAccountId),
    publicIdentifier
  );

  const status: LinkedinConnectionStatus = accepted ? "accepted" : "pending";

  if (existing) {
    await db
      .update(linkedinConnections)
      .set({ status, checkedAt: now, resolvedAt: accepted ? now : existing.resolvedAt, updatedAt: now })
      .where(eq(linkedinConnections.id, existing.id));
  } else {
    await db
      .insert(linkedinConnections)
      .values({
        workspaceId,
        prospectId,
        // Just needs to point at *an* account for the FK — this row tracks the prospect's
        // connection state, not which specific account sent the original invite.
        linkedinAccountId: activeAccounts[0]!.id,
        status,
        invitedAt: now,
        checkedAt: now,
        resolvedAt: accepted ? now : null,
      })
      .onConflictDoNothing();
  }

  log.info("linkedin-connection: checked", { workspaceId, prospectId, status });
  return status;
}
