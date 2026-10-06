import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { appendCopsEvent, createCopsEvent, type ActivityCreateInput, type ActivityType, type CrmEntityType } from "@skout/shared";
import { serviceLog } from "../lib/obs.js";
import { RetentionRulesService } from "./retention-rules.service.js";

const log = serviceLog("activities");
const { activities, contacts, deals } = schema;

export interface ActivityDto {
  id: string;
  workspaceId: string;
  entityType: string;
  entityId: string;
  activityType: string;
  subject: string | null;
  body: string | null;
  ownerId: string | null;
  /** §8.12 / Task 19 — RetentionRulesService.classify()'s result, or null (see schema comment). */
  retentionClassification: string | null;
  occurredAt: string;
  createdAt: string;
}

function toDto(row: typeof activities.$inferSelect): ActivityDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    entityType: row.entityType,
    entityId: row.entityId,
    activityType: row.activityType,
    subject: row.subject,
    body: row.body,
    ownerId: row.ownerId,
    retentionClassification: row.retentionClassification,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export class ActivitiesService {
  constructor(private readonly db: Db) {}

  async list(
    workspaceId: string,
    entityType: string,
    entityId: string,
    options: { limit: number; offset: number }
  ): Promise<{ data: ActivityDto[]; total: number }> {
    const conditions = [
      eq(activities.workspaceId, workspaceId),
      eq(activities.entityType, entityType),
      eq(activities.entityId, entityId),
    ];

    const rows = await this.db
      .select()
      .from(activities)
      .where(and(...conditions))
      .orderBy(desc(activities.occurredAt))
      .limit(options.limit)
      .offset(options.offset);

    const all = await this.db
      .select({ id: activities.id })
      .from(activities)
      .where(and(...conditions));

    return { data: rows.map(toDto), total: all.length };
  }

  /** Workspace-wide recent activity feed (not filtered by entity) — used by the dashboard overview. */
  async recent(workspaceId: string, limit: number): Promise<ActivityDto[]> {
    const rows = await this.db
      .select()
      .from(activities)
      .where(eq(activities.workspaceId, workspaceId))
      .orderBy(desc(activities.occurredAt))
      .limit(limit);
    return rows.map(toDto);
  }

  async create(workspaceId: string, ownerId: string | undefined, input: ActivityCreateInput): Promise<ActivityDto> {
    return this.record(workspaceId, ownerId, input.entityType, input.entityId, input.activityType, input.subject, input.body, input.visibility ?? "public");
  }

  async record(
    workspaceId: string,
    ownerId: string | undefined,
    entityType: CrmEntityType,
    entityId: string,
    activityType: ActivityType,
    subject?: string,
    body?: string,
    visibility: "public" | "internal" = "public"
  ): Promise<ActivityDto> {
    // §8.12 / Task 19 — every activity-ingestion path funnels through this one method (create(),
    // sequence-enrollment.worker.ts, call disposition, meeting outcomes, etc.), so wiring
    // classify() here covers all of them at once rather than each call site individually.
    // Best-effort: a rules lookup failure must never block the activity itself from being
    // recorded — falls back to unclassified (null) on any error.
    let retentionClassification: string | null = null;
    try {
      const retentionRulesService = new RetentionRulesService(this.db);
      const rules = await retentionRulesService.list(workspaceId, entityType);
      const classification = RetentionRulesService.classify(rules, activityType);
      retentionClassification = classification === "unclassified" ? null : classification;
    } catch (err) {
      log.warn("retention classification failed — recording activity unclassified", { workspaceId, entityType, activityType, err });
    }

    // COPS-02: the activity and its ActivityRecorded event commit together, so the timeline
    // projector sees every activity exactly once (outbox + idempotent consumer).
    const row = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(activities)
        .values({ workspaceId, entityType, entityId, activityType, subject, body, ownerId, retentionClassification, visibility })
        .returning();
      const accountId = await accountIdForActivity(tx, workspaceId, entityType, entityId);
      await appendCopsEvent(
        tx as never,
        createCopsEvent({
          eventType: "ActivityRecorded",
          tenantId: workspaceId,
          aggregateType: entityType,
          aggregateId: entityId,
          actor: ownerId ? { type: "user", id: ownerId } : { type: "system", id: null },
          payload: {
            activity_id: inserted.id,
            activity_type: activityType,
            entity_type: entityType,
            entity_id: entityId,
            account_id: accountId,
            subject: subject ?? null,
            visibility,
          },
        })
      );
      return inserted;
    });
    log.info("activity recorded", { workspaceId, entityType, entityId, activityType, activityId: row.id, retentionClassification });
    return toDto(row);
  }
}

export function buildActivitiesService(db: Db | null): ActivitiesService | null {
  return db ? new ActivitiesService(db) : null;
}

/** The account (company) an activity belongs to, for the account timeline. Null when there is none. */
async function accountIdForActivity(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  workspaceId: string,
  entityType: string,
  entityId: string
): Promise<string | null> {
  if (entityType === "company") return entityId;
  if (entityType === "contact") {
    const [c] = await tx
      .select({ companyId: contacts.companyId })
      .from(contacts)
      .where(and(eq(contacts.id, entityId), eq(contacts.workspaceId, workspaceId)))
      .limit(1);
    return c?.companyId ?? null;
  }
  if (entityType === "deal") {
    const [d] = await tx
      .select({ companyId: deals.companyId })
      .from(deals)
      .where(and(eq(deals.id, entityId), eq(deals.workspaceId, workspaceId)))
      .limit(1);
    return d?.companyId ?? null;
  }
  return null;
}
