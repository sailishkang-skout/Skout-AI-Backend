import { Worker, Queue } from "bullmq";
import { eq, isNull } from "drizzle-orm";
import { createDb, schema, scopedTo } from "@skout/db";
import type { Db } from "@skout/db";
import { createLogger, withSpan } from "@skout/observability";
import type { MatchCandidate } from "@skout/shared";
import type { Env } from "../config/env.js";
import { loadEnv } from "../config/env.js";
import { isRedisAvailable, redisBullMqConnection } from "../lib/redis.js";
import { proposeMerge } from "../services/identity-merge.service.js";

const log = createLogger("identity-merge-discovery.worker");

const QUEUE_NAME = "identity-merge-discovery";

/**
 * A blocking bucket this large means the blocking key itself is too weak to be useful (e.g.
 * many companies genuinely share a null domain, or many contacts share a very common last
 * name) — comparing every pair inside it would be real O(n^2) work for little signal. Skipped
 * buckets are logged so a stuck-too-weak key is visible, not silently dropped.
 */
const MAX_BUCKET_SIZE = 50;

/**
 * §5.2 (Enterprise Completion Plan) — identity-merge candidate discovery.
 *
 * scoreCandidateMatch() and proposeMerge() (packages/shared/src/identity-merge.ts,
 * apps/api/src/services/identity-merge.service.ts) have existed since an earlier pass of this
 * work, but nothing in the running system ever called proposeMerge() outside of tests — the
 * merge-review UI (Frontend Task 22) had a real proposal list to review but no worker ever
 * populated it. This worker closes that gap: it periodically scans each workspace's companies
 * and contacts for probable-duplicate pairs and writes identity_merge_proposals rows, exactly
 * the same call a human-triggered "check this pair" flow would make. It never merges anything
 * itself — every proposal still requires a human decision via resolveMergeProposal().
 *
 * This is a heuristic, blocking-key-based scan, not an exhaustive O(n^2) comparison of every
 * record against every other record in a workspace — that would not scale past a few hundred
 * records. Candidates are only compared within a shared "blocking key" bucket (companies: same
 * domain, or same first-3-normalized-characters of name; contacts: same first-3-normalized-
 * characters of last name). A duplicate pair whose two records share none of these blocking
 * keys (e.g. a company renamed AND changed domains) will not be found by this worker — that
 * residual gap is the honest tradeoff for not scanning every pair in every workspace on every
 * tick. Re-running discovery cannot create a duplicate proposal for the same pair: every
 * candidate pair is checked against identity_merge_proposals for a prior row (any status)
 * before proposeMerge() is called.
 */

type CompanyBlockRow = { id: string; name: string; domain: string | null; location: string | null };
type ContactBlockRow = {
  id: string;
  firstName: string;
  lastName: string | null;
  title: string | null;
  companyDomain: string | null;
};

/** Lowercase, strip non-alphanumerics, take the first 3 chars — a cheap fuzzy-match blocking key. */
function normalizeBlockingKey(s: string | null | undefined): string | null {
  if (!s) return null;
  const norm = s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  return norm.length >= 3 ? norm.slice(0, 3) : null;
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

/** Every (leftEntityId, rightEntityId) pair that already has a proposal (any status) for this
 * workspace + entityType — prevents re-proposing a pair a human already accepted OR rejected. */
async function existingProposalPairKeys(db: Db, workspaceId: string, entityType: string): Promise<Set<string>> {
  const { identityMergeProposals } = schema;
  const rows = await db
    .select({ leftEntityId: identityMergeProposals.leftEntityId, rightEntityId: identityMergeProposals.rightEntityId })
    .from(identityMergeProposals)
    .where(scopedTo(identityMergeProposals, workspaceId, eq(identityMergeProposals.entityType, entityType)));
  return new Set(rows.map((r) => pairKey(r.leftEntityId, r.rightEntityId)));
}

function bucketize<T>(rows: T[], keysFor: (row: T) => string[]): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    for (const key of new Set(keysFor(row))) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(row);
      else buckets.set(key, [row]);
    }
  }
  return buckets;
}

export async function sweepWorkspaceForCompanyMergeCandidates(db: Db, workspaceId: string): Promise<number> {
  const { companies } = schema;
  const rows: CompanyBlockRow[] = await db
    .select({ id: companies.id, name: companies.name, domain: companies.domain, location: companies.location })
    .from(companies)
    .where(scopedTo(companies, workspaceId, isNull(companies.deletedAt)));
  if (rows.length < 2) return 0;

  const buckets = bucketize(rows, (row) => {
    const keys: string[] = [];
    const domainKey = row.domain?.trim().toLowerCase();
    if (domainKey) keys.push(`domain:${domainKey}`);
    const nameKey = normalizeBlockingKey(row.name);
    if (nameKey) keys.push(`name:${nameKey}`);
    return keys;
  });

  const existing = await existingProposalPairKeys(db, workspaceId, "company");
  const seen = new Set<string>();
  let proposed = 0;

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    if (bucket.length > MAX_BUCKET_SIZE) {
      log.warn(`Skipping oversized company blocking bucket (${bucket.length} rows) — key too weak to be useful`, { workspaceId });
      continue;
    }
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!;
        const b = bucket[j]!;
        const key = pairKey(a.id, b.id);
        if (seen.has(key) || existing.has(key)) continue;
        seen.add(key);

        const left: MatchCandidate = { name: a.name, domain: a.domain ?? undefined, location: a.location ?? undefined };
        const right: MatchCandidate = { name: b.name, domain: b.domain ?? undefined, location: b.location ?? undefined };
        try {
          const result = await proposeMerge(db, {
            workspaceId,
            entityType: "company",
            leftEntityId: a.id,
            rightEntityId: b.id,
            left,
            right,
          });
          if (result) proposed++;
        } catch (err) {
          log.error("proposeMerge failed for company candidate pair", { workspaceId, left: a.id, right: b.id, err });
        }
      }
    }
  }
  return proposed;
}

export async function sweepWorkspaceForContactMergeCandidates(db: Db, workspaceId: string): Promise<number> {
  const { contacts, companies } = schema;
  const rows: ContactBlockRow[] = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      title: contacts.title,
      companyDomain: companies.domain,
    })
    .from(contacts)
    .leftJoin(companies, eq(companies.id, contacts.companyId))
    .where(scopedTo(contacts, workspaceId, isNull(contacts.deletedAt)));
  if (rows.length < 2) return 0;

  const buckets = bucketize(rows, (row) => {
    const key = normalizeBlockingKey(row.lastName) ?? normalizeBlockingKey(row.firstName);
    return key ? [`name:${key}`] : [];
  });

  const existing = await existingProposalPairKeys(db, workspaceId, "contact");
  const seen = new Set<string>();
  let proposed = 0;

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    if (bucket.length > MAX_BUCKET_SIZE) {
      log.warn(`Skipping oversized contact blocking bucket (${bucket.length} rows) — key too weak to be useful`, { workspaceId });
      continue;
    }
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]!;
        const b = bucket[j]!;
        const key = pairKey(a.id, b.id);
        if (seen.has(key) || existing.has(key)) continue;
        seen.add(key);

        const left: MatchCandidate = {
          name: `${a.firstName} ${a.lastName ?? ""}`.trim(),
          title: a.title ?? undefined,
          domain: a.companyDomain ?? undefined,
        };
        const right: MatchCandidate = {
          name: `${b.firstName} ${b.lastName ?? ""}`.trim(),
          title: b.title ?? undefined,
          domain: b.companyDomain ?? undefined,
        };
        try {
          const result = await proposeMerge(db, {
            workspaceId,
            entityType: "contact",
            leftEntityId: a.id,
            rightEntityId: b.id,
            left,
            right,
          });
          if (result) proposed++;
        } catch (err) {
          log.error("proposeMerge failed for contact candidate pair", { workspaceId, left: a.id, right: b.id, err });
        }
      }
    }
  }
  return proposed;
}

export async function startIdentityMergeDiscoveryWorker(config: Env) {
  if (!config.DATABASE_URL) {
    log.warn("DATABASE_URL not set — identity-merge discovery worker disabled");
    return () => Promise.resolve();
  }

  if (!(await isRedisAvailable(config))) {
    log.warn("Redis unavailable — identity-merge discovery worker disabled");
    return () => Promise.resolve();
  }

  const connection = redisBullMqConnection(config.REDIS_URL);
  const queue = new Queue(QUEUE_NAME, { connection });

  const cronExpression = `0 */${config.IDENTITY_MERGE_DISCOVERY_INTERVAL_HOURS} * * *`;
  await queue.upsertJobScheduler(
    "identity-merge-discovery-all",
    { pattern: cronExpression },
    { name: "identity-merge-discovery-all", data: {} }
  );

  const { db } = createDb(config.DATABASE_URL);
  const { workspaces } = schema;

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await withSpan("identity-merge-discovery.tick", async () => {
        const allWorkspaces = await db.select({ id: workspaces.id }).from(workspaces);
        let totalProposed = 0;
        for (const ws of allWorkspaces) {
          try {
            totalProposed += await sweepWorkspaceForCompanyMergeCandidates(db, ws.id);
            totalProposed += await sweepWorkspaceForContactMergeCandidates(db, ws.id);
          } catch (err) {
            log.error(`Identity-merge discovery failed for workspace ${ws.id}`, { workspaceId: ws.id, err });
          }
        }
        if (totalProposed > 0) log.info(`Identity-merge discovery created ${totalProposed} new proposal(s)`);
      });
    },
    { connection, concurrency: 1 }
  );

  worker.on("failed", (job, err) => {
    log.error("Identity-merge discovery job failed", { jobId: job?.id, err });
  });

  log.info(`Identity-merge discovery worker started (cron: ${cronExpression})`);

  return async () => {
    await worker.close();
    await queue.close();
  };
}

if (
  process.argv[1]?.endsWith("identity-merge-discovery.worker.ts") ||
  process.argv[1]?.endsWith("identity-merge-discovery.worker.js")
) {
  const config = loadEnv();
  startIdentityMergeDiscoveryWorker(config).then(() => {
    log.info("Identity-merge discovery worker running standalone");
  });
}
