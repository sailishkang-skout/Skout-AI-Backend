import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import {
  prospectIdsStillMatching,
  runSmartListQueryWithFallback,
  type ProspectDocument,
  type SearchFilters,
} from "@skout/opensearch";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { buildEnrichmentService, InsufficientCreditsError } from "./enrichment/index.js";
import { prospectToSnapshot } from "./smart-list.mapper.js";
import {
  osConfigFromEnv,
  resolveFiltersForSearch,
  summarizeSearchFilters,
  type SmartListProspectDiffEntry,
} from "./smart-list.service.js";
import { computeNextRefreshAt, type SmartListRefreshCadence } from "./smart-list-cadence.js";
import { createSearchCacheService } from "./search-cache.service.js";

const { asyncJobs, smartLists, smartListMembers, smartListRefreshes } = schema;
const log = createLogger("smart-list-refresh.runner");

function toDiffEntry(doc: ProspectDocument): SmartListProspectDiffEntry {
  return {
    prospectId: doc.prospectId,
    fullName: doc.fullName ?? doc.companyName ?? undefined,
    title: doc.title ?? undefined,
    companyDomain: doc.companyDomain ?? undefined,
  };
}

function withMatchReason(entry: SmartListProspectDiffEntry, reason: string): SmartListProspectDiffEntry {
  return { ...entry, matchReason: reason };
}

export async function runSmartListRefreshJob(
  db: Db,
  config: Env,
  jobId: string,
  workspaceId: string,
  listId: string
): Promise<void> {
  await db
    .update(asyncJobs)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(asyncJobs.id, jobId));

  const [list] = await db.select().from(smartLists).where(eq(smartLists.id, listId));
  if (!list || list.workspaceId !== workspaceId) {
    await db
      .update(asyncJobs)
      .set({ status: "failed", errorMessage: "smart_list_not_found", completedAt: new Date() })
      .where(eq(asyncJobs.id, jobId));
    return;
  }

  const cadence = list.refreshCadence as SmartListRefreshCadence;

  try {
    const osCfg = osConfigFromEnv(config);
    const filters = await resolveFiltersForSearch(osCfg, list.filters as SearchFilters);
    const { hits, total, demo } = await runSmartListQueryWithFallback(osCfg, filters);
    // Demo prospects are fake: in a deployed environment never store them as members or spend
    // credits scoring them. (Local dev without OpenSearch uses the demo corpus on purpose.)
    if (demo && config.NODE_ENV === "production") {
      throw new Error("search_unavailable: refusing to refresh a smart list from demo data");
    }
    const matched = hits as ProspectDocument[];
    const matchedIds = new Set(matched.map((h) => h.prospectId));

    const previousRows = await db
      .select()
      .from(smartListMembers)
      .where(eq(smartListMembers.smartListId, listId));
    const previousIds = new Set(previousRows.map((r) => r.prospectId));

    const addedHits = matched.filter((h) => !previousIds.has(h.prospectId));
    const missingRows = previousRows.filter((r) => !matchedIds.has(r.prospectId));
    // Only the first 1,000 hits are kept. When the list has more matches than that, a member that
    // isn't among them may simply have been pushed past the cap; check before calling it dropped.
    const stillMatching =
      missingRows.length > 0 && total > matched.length && osCfg
        ? await prospectIdsStillMatching(osCfg, filters, missingRows.map((r) => r.prospectId))
        : new Set<string>();
    const keptRows = missingRows.filter((r) => stillMatching.has(r.prospectId));
    const droppedRows = missingRows.filter((r) => !stillMatching.has(r.prospectId));

    const snapshots = addedHits.map(prospectToSnapshot).filter((s) => s.companyDomain);

    const svc = buildEnrichmentService(db, config);
    let creditsUsed = 0;
    try {
      if (snapshots.length > 0) {
        const result = await svc.runCorpusScore(workspaceId, snapshots);
        creditsUsed = result.creditsUsed;
      }
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        const now = new Date();
        await db.insert(smartListRefreshes).values({
          workspaceId,
          smartListId: listId,
          status: "skipped_insufficient_credits",
          matchedCount: total,
          addedCount: addedHits.length,
          droppedCount: droppedRows.length,
          addedProspects: [],
          droppedProspects: [],
          creditsCharged: 0,
          requiredCredits: err.required,
          availableCredits: err.available,
          startedAt: now,
          completedAt: now,
        });
        await db
          .update(smartLists)
          .set({ nextRefreshAt: computeNextRefreshAt(cadence, now) })
          .where(eq(smartLists.id, listId));
        await db
          .update(asyncJobs)
          .set({
            status: "completed",
            result: { skipped: true, reason: "insufficient_credits", required: err.required, available: err.available },
            completedAt: now,
          })
          .where(eq(asyncJobs.id, jobId));
        log.info("smart list refresh skipped — insufficient credits", {
          workspaceId,
          listId,
          required: err.required,
          available: err.available,
        });
        return;
      }
      throw err;
    }

    const now = new Date();
    // Replace membership wholesale: drop stale rows for this list, re-insert current matches.
    await db.delete(smartListMembers).where(eq(smartListMembers.smartListId, listId));
    const members = [
      ...matched.map((doc) => ({ smartListId: listId, prospectId: doc.prospectId, snapshot: toDiffEntry(doc) })),
      ...keptRows.map((r) => ({ smartListId: listId, prospectId: r.prospectId, snapshot: r.snapshot })),
    ];
    if (members.length > 0) {
      await db.insert(smartListMembers).values(members);
    }

    await db
      .update(smartLists)
      .set({
        lastRunCount: total,
        lastRefreshedAt: now,
        nextRefreshAt: computeNextRefreshAt(cadence, now),
        updatedAt: now,
      })
      .where(eq(smartLists.id, listId));

    const filterSummary = summarizeSearchFilters(list.filters as SearchFilters);

    await db.insert(smartListRefreshes).values({
      workspaceId,
      smartListId: listId,
      status: "completed",
      matchedCount: total,
      addedCount: addedHits.length,
      droppedCount: droppedRows.length,
      addedProspects: addedHits.map((doc) => withMatchReason(toDiffEntry(doc), `Now matches: ${filterSummary}`)),
      droppedProspects: droppedRows.map((r) =>
        withMatchReason(r.snapshot as SmartListProspectDiffEntry, `No longer matches: ${filterSummary}`)
      ),
      creditsCharged: creditsUsed,
      startedAt: now,
      completedAt: now,
    });

    await db
      .update(asyncJobs)
      .set({
        status: "completed",
        result: { matched: total, added: addedHits.length, dropped: droppedRows.length, creditsUsed },
        completedAt: now,
      })
      .where(eq(asyncJobs.id, jobId));

    await createSearchCacheService(config).invalidateSmartList(workspaceId, listId);

    log.info("smart list refresh completed", {
      workspaceId,
      listId,
      matched: total,
      kept: matched.length,
      added: addedHits.length,
      dropped: droppedRows.length,
      creditsUsed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("smart list refresh job failed", err, { jobId, workspaceId, listId });
    const now = new Date();
    await db.insert(smartListRefreshes).values({
      workspaceId,
      smartListId: listId,
      status: "failed",
      errorMessage: message,
      startedAt: now,
      completedAt: now,
    });
    await db
      .update(smartLists)
      .set({ nextRefreshAt: computeNextRefreshAt(cadence, now) })
      .where(eq(smartLists.id, listId));
    await db
      .update(asyncJobs)
      .set({ status: "failed", errorMessage: message, completedAt: now })
      .where(eq(asyncJobs.id, jobId));
    throw err;
  }
}
