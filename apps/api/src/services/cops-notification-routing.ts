import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import type { CopsPhase1EventType } from "@skout/shared";

const { roles, workspaceMemberRoles } = schema;

export const COPS_NOTIFICATION_ROLE_KEYS = [
  "sales",
  "sales_manager",
  "cs",
  "finance",
  "legal_revops",
  "engineering",
  "product",
  "admin",
  "owner",
] as const;

export type CopsNotificationRoleKey = (typeof COPS_NOTIFICATION_ROLE_KEYS)[number];

const DEFAULT_EVENT_ROLES: Partial<Record<CopsPhase1EventType, readonly CopsNotificationRoleKey[]>> = {
  OpportunityQualified: ["sales", "sales_manager"],
  ProposalSent: ["sales", "sales_manager", "legal_revops"],
  ContractSent: ["sales", "sales_manager", "legal_revops"],
  ContractSigned: ["sales", "sales_manager", "legal_revops"],
  PaymentRequested: ["finance"],
  PaymentSucceeded: ["finance"],
  WorkspaceProvisioned: ["cs"],
  CreditsGranted: ["finance"],
  WelcomeEmailSent: ["cs"],
  SequenceEnrolled: ["cs"],
  TaskCreated: ["cs"],
  FirstLogin: ["cs"],
  ActivationMilestoneCompleted: ["cs"],
  CustomerActivated: ["cs"],
  TicketCreated: ["engineering", "cs"],
  TicketEscalated: ["engineering", "cs"],
  TicketResolved: ["engineering", "cs"],
  LifecycleTransitioned: ["cs"],
};

/** Lifecycle notifications follow their dimension's owner instead of a generic recipient. */
export function defaultCopsNotificationRoles(
  eventType: CopsPhase1EventType,
  payload?: Record<string, unknown>
): readonly CopsNotificationRoleKey[] {
  if (eventType === "LifecycleTransitioned") {
    switch (payload?.dimension) {
      case "commercial":
        return ["sales", "sales_manager", "legal_revops", "finance"];
      case "support":
        return ["engineering", "cs"];
      case "account":
        return ["cs", "finance"];
      case "opportunity":
        return ["sales", "sales_manager"];
      default:
        return ["cs"];
    }
  }
  return DEFAULT_EVENT_ROLES[eventType] ?? [];
}

export function resolveCopsNotificationRoles(
  eventType: CopsPhase1EventType,
  payload: Record<string, unknown>,
  override?: readonly string[]
): CopsNotificationRoleKey[] {
  const rolesToUse = override ?? defaultCopsNotificationRoles(eventType, payload);
  return [...new Set(rolesToUse)].filter(
    (key): key is CopsNotificationRoleKey =>
      COPS_NOTIFICATION_ROLE_KEYS.includes(key as CopsNotificationRoleKey)
  );
}

/** Resolve current workspace users for role keys; no cross-workspace or global membership lookup. */
export async function getCopsNotificationRecipients(
  db: Pick<Db, "selectDistinct">,
  workspaceId: string,
  roleKeys: readonly CopsNotificationRoleKey[]
): Promise<string[]> {
  if (roleKeys.length === 0) return [];
  const rows = await db
    .selectDistinct({ userId: workspaceMemberRoles.userId })
    .from(workspaceMemberRoles)
    .innerJoin(roles, eq(workspaceMemberRoles.roleId, roles.id))
    .where(
      and(
        eq(workspaceMemberRoles.workspaceId, workspaceId),
        or(isNull(roles.workspaceId), eq(roles.workspaceId, workspaceId)),
        inArray(roles.key, [...roleKeys])
      )
    );
  return rows.map((row) => row.userId);
}
