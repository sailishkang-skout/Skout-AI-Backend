import { and, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "@skout/auth";

const { retentionRules } = schema;

export type RetentionClassification = "marketing" | "contractual";

export interface RetentionRuleInput {
  name: string;
  classification: RetentionClassification;
  entityType: string;
  criteria: Record<string, unknown>;
  isActive?: boolean;
}

export interface RetentionRuleDto {
  id: string;
  workspaceId: string;
  name: string;
  classification: RetentionClassification;
  entityType: string;
  criteria: Record<string, unknown>;
  isActive: boolean;
}

function toDto(row: typeof retentionRules.$inferSelect): RetentionRuleDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    classification: row.classification as RetentionClassification,
    entityType: row.entityType,
    criteria: (row.criteria as Record<string, unknown>) ?? {},
    isActive: row.isActive,
  };
}

type CrmDb = Pick<Db, "select" | "insert" | "update" | "delete">;

/**
 * §8.12's retention-workflow half: a workspace-configurable rule set distinguishing marketing
 * engagement (opens/clicks — informative, not a retention signal on its own) from contractual
 * truth (signed renewals, cancellations — the actual disengagement/renewal-risk signal).
 *
 * Wave 1 ships the rule CRUD and a pure classifier function any caller can use against an
 * activity's `activityType`. Wiring `classify()` into every activity-ingestion path (sequence
 * replies, call dispositions, meeting outcomes) so it runs automatically end-to-end is tracked
 * as Wave 2 — see docs/adr/0002-canonical-operating-model-wave-1.md's Wave 2 list.
 */
export class RetentionRulesService {
  constructor(private readonly db: CrmDb) {}

  async list(workspaceId: string, entityType?: string): Promise<RetentionRuleDto[]> {
    const conditions = [eq(retentionRules.workspaceId, workspaceId)];
    if (entityType) conditions.push(eq(retentionRules.entityType, entityType));

    const rows = await this.db
      .select()
      .from(retentionRules)
      .where(and(...conditions));
    return rows.map(toDto);
  }

  async create(workspaceId: string, createdBy: string | undefined, input: RetentionRuleInput): Promise<RetentionRuleDto> {
    const [row] = await this.db
      .insert(retentionRules)
      .values({
        workspaceId,
        name: input.name,
        classification: input.classification,
        entityType: input.entityType,
        criteria: input.criteria,
        isActive: input.isActive ?? true,
        createdBy: createdBy ?? null,
      })
      .returning();
    if (!row) throw new HttpError("Failed to create retention rule", 500);
    return toDto(row);
  }

  async setActive(workspaceId: string, ruleId: string, isActive: boolean): Promise<RetentionRuleDto> {
    const [row] = await this.db
      .update(retentionRules)
      .set({ isActive, updatedAt: new Date() })
      .where(and(eq(retentionRules.id, ruleId), eq(retentionRules.workspaceId, workspaceId)))
      .returning();
    if (!row) throw new HttpError("retention_rule_not_found", 404);
    return toDto(row);
  }

  /**
   * Pure classification: given an entity's active rules and a candidate activityType value,
   * returns the matching classification or "unclassified" if no active rule's criteria matches.
   * A rule's `criteria.activityType` is treated as an allow-list of activityType strings — the
   * only shape Wave 1 needs; richer criteria (date ranges, field matches) are Wave 2.
   */
  static classify(rules: RetentionRuleDto[], activityType: string): RetentionClassification | "unclassified" {
    for (const rule of rules) {
      if (!rule.isActive) continue;
      const allowed = rule.criteria?.activityType;
      if (Array.isArray(allowed) && allowed.includes(activityType)) {
        return rule.classification;
      }
    }
    return "unclassified";
  }
}

export function buildRetentionRulesService(db: CrmDb | null): RetentionRulesService | null {
  return db ? new RetentionRulesService(db) : null;
}
