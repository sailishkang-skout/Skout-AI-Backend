import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema, scopedTo } from "@skout/db";
import type { EmailVerdict } from "@skout/pal";
import type { OpenSearchConfig } from "@skout/opensearch";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { buildListService } from "./list.service.js";
import { resolveEmailVerifier } from "./enrichment/index.js";
import { resolveProspectFields } from "./prospect-resolver.service.js";
import { isEmailIntelConfigured, verifyEmailAsVerdict } from "./email-intel.service.js";
import { recordEvidence } from "./evidence.service.js";

const log = createLogger("email-verification.service");
const { emailVerifications } = schema;

export type ListVerifyStatus = EmailVerdict | "no_email";

const ALL_STATUSES: ListVerifyStatus[] = [
  "valid",
  "invalid",
  "catch_all",
  "risky",
  "unknown",
  "no_email",
];

/** Verdicts considered safe enough to send to (drives the "sendable" count). */
const SENDABLE_STATUSES: ListVerifyStatus[] = ["valid", "catch_all"];

export interface MemberVerification {
  prospectId: string;
  email: string | null;
  status: ListVerifyStatus;
  deliverabilityScore: number;
  catchAll: boolean;
  risky: boolean;
  provider?: string;
  verifiedAt?: string;
}

export interface ListVerifySummary {
  listId: string;
  total: number;
  verified: number;
  provider: string;
  counts: Record<ListVerifyStatus, number>;
  sendableCount: number;
  results: MemberVerification[];
}

const MAX_LIST_SIZE = 2000;
const CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 0 }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function emptyCounts(): Record<ListVerifyStatus, number> {
  return ALL_STATUSES.reduce(
    (acc, s) => ({ ...acc, [s]: 0 }),
    {} as Record<ListVerifyStatus, number>
  );
}

export class EmailVerificationService {
  constructor(
    private readonly db: Db,
    private readonly config: Env,
    private readonly osCfg: OpenSearchConfig | null
  ) {}

  /**
   * Verifies every member of a list through the workspace's email verifier and stores the
   * verdicts. Returns a deliverability summary the UI can show before a bulk send.
   * Returns null when the list does not exist.
   */
  async verifyList(workspaceId: string, listId: string): Promise<ListVerifySummary | null> {
    const listSvc = buildListService(this.db, this.osCfg);
    if (!listSvc) return null;
    const members = await listSvc.getMembers(workspaceId, listId);
    if (members === null) return null;

    const capped = members.slice(0, MAX_LIST_SIZE);
    const verifier = await resolveEmailVerifier(this.db, this.config, workspaceId);
    const now = new Date();

    const results = await mapWithConcurrency(capped, CONCURRENCY, async (m): Promise<MemberVerification> => {
      const snapEmail =
        typeof m.snapshot?.email === "string" ? (m.snapshot.email as string).trim() : "";
      let email = snapEmail || null;
      if (!email) {
        const resolved = await resolveProspectFields(
          this.config,
          this.db,
          workspaceId,
          m.prospectId
        ).catch(() => null);
        email = resolved?.email ?? null;
      }

      if (!email) {
        return {
          prospectId: m.prospectId,
          email: null,
          status: "no_email",
          deliverabilityScore: 0,
          catchAll: false,
          risky: false,
        };
      }

      // Try the in-house email-intel service first (own SMTP verification,
      // no per-lookup vendor cost) — falls through to the existing
      // ZeroBounce/NeverBounce/MillionVerifier waterfall below whenever it's
      // unconfigured, unreachable, or returns nothing usable.
      if (isEmailIntelConfigured(this.config)) {
        const v = await verifyEmailAsVerdict(this.config, email);
        if (v) {
          // Task 21 (Enterprise Completion Plan Section 5.3) — Skout-Email-Intelligence-Tool is a
          // separately deployed service with its own Postgres and its own internal evidence
          // pipeline (evidenceLedger/evidenceCollector/evidenceWeighting), genuinely a different
          // bounded context from this workspace-scoped canonical evidence_ledger (no workspaceId
          // concept exists in its data model at all — it tracks raw email/domain verification
          // facts, not CRM entities). Rather than having that tool make a new outbound HTTP call
          // into apps/api (a new cross-service auth surface for a service that today only serves
          // stateless verification requests), this dual-writes from HERE — the one place in
          // apps/api that already has both the verdict AND workspace/prospect context — matching
          // the same "avoid a new cross-service hop when an existing call site already has the
          // needed context" reasoning used for the read-model exceptions (ADR 0003).
          // Best-effort: a ledger-write failure must never fail list verification itself.
          try {
            await recordEvidence(this.db, {
              workspaceId,
              entityType: "prospect",
              entityId: m.prospectId,
              attribute: "email_deliverability",
              value: { email, status: v.status, catchAll: v.catchAll, risky: v.risky },
              source: "email_intelligence_tool",
              observedAt: now,
              confidence: v.deliverabilityScore / 100,
              method: "smtp_verification",
            });
          } catch (err) {
            log.warn("evidence ledger dual-write failed for email-intel verification", { workspaceId, prospectId: m.prospectId, err });
          }

          return {
            prospectId: m.prospectId,
            email,
            status: v.status,
            deliverabilityScore: v.deliverabilityScore,
            catchAll: v.catchAll,
            risky: v.risky,
            provider: "email-intel",
            verifiedAt: now.toISOString(),
          };
        }
      }

      try {
        const v = await verifier.verify(email);
        return {
          prospectId: m.prospectId,
          email,
          status: v.status,
          deliverabilityScore: v.deliverabilityScore,
          catchAll: v.catchAll,
          risky: v.risky,
          provider: verifier.name,
          verifiedAt: now.toISOString(),
        };
      } catch (err: unknown) {
        log.warn("Email verification failed", { prospectId: m.prospectId, err });
        return {
          prospectId: m.prospectId,
          email,
          status: "unknown",
          deliverabilityScore: 0,
          catchAll: false,
          risky: false,
          provider: verifier.name,
          verifiedAt: now.toISOString(),
        };
      }
    });

    const rows = results
      .filter((r) => r.email)
      .map((r) => ({
        workspaceId,
        prospectId: r.prospectId,
        email: r.email!,
        status: r.status,
        deliverabilityScore: r.deliverabilityScore,
        catchAll: r.catchAll,
        risky: r.risky,
        provider: r.provider ?? verifier.name,
        verifiedAt: now,
      }));

    if (rows.length > 0) {
      await this.db
        .insert(emailVerifications)
        .values(rows)
        .onConflictDoUpdate({
          target: [emailVerifications.workspaceId, emailVerifications.prospectId],
          set: {
            email: sql`excluded.email`,
            status: sql`excluded.status`,
            deliverabilityScore: sql`excluded.deliverability_score`,
            catchAll: sql`excluded.catch_all`,
            risky: sql`excluded.risky`,
            provider: sql`excluded.provider`,
            verifiedAt: sql`excluded.verified_at`,
          },
        });
    }

    const counts = emptyCounts();
    for (const r of results) counts[r.status] += 1;
    const sendableCount = SENDABLE_STATUSES.reduce((sum, s) => sum + counts[s], 0);

    return {
      listId,
      total: results.length,
      verified: rows.length,
      provider: verifier.name,
      counts,
      sendableCount,
      results,
    };
  }

  /** Returns stored verdicts for the given prospects, keyed by prospectId. */
  async getForProspects(
    workspaceId: string,
    prospectIds: string[]
  ): Promise<Record<string, MemberVerification>> {
    if (prospectIds.length === 0) return {};
    const rows = await this.db
      .select()
      .from(emailVerifications)
      .where(
        scopedTo(emailVerifications, workspaceId, inArray(emailVerifications.prospectId, prospectIds))
      );
    const map: Record<string, MemberVerification> = {};
    for (const r of rows) {
      map[r.prospectId] = {
        prospectId: r.prospectId,
        email: r.email,
        status: r.status as ListVerifyStatus,
        deliverabilityScore: r.deliverabilityScore,
        catchAll: r.catchAll,
        risky: r.risky,
        provider: r.provider ?? undefined,
        verifiedAt: r.verifiedAt.toISOString(),
      };
    }
    return map;
  }
}

export function buildEmailVerificationService(
  db: Db | null,
  config: Env,
  osCfg: OpenSearchConfig | null
): EmailVerificationService | null {
  if (!db) return null;
  return new EmailVerificationService(db, config, osCfg);
}
