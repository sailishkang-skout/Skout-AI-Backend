/**
 * COPS-02 timeline projection: maps a COPS domain event to a normalised timeline row.
 * Pure, so the mapping rules are unit-testable without a database.
 */

export const COPS_TIMELINE_TYPES = [
  "email",
  "call",
  "meeting",
  "note",
  "proposal",
  "contract",
  "payment",
  "provisioning",
  "product_milestone",
  "ticket",
  "workflow_action",
] as const;
export type CopsTimelineType = (typeof COPS_TIMELINE_TYPES)[number];

export interface CopsTimelineProjection {
  type: CopsTimelineType;
  visibility: "public" | "internal";
  summary: string;
}

const TYPE_BY_EVENT: Record<string, CopsTimelineType> = {
  OpportunityQualified: "workflow_action",
  ProposalSent: "proposal",
  ContractSent: "contract",
  ContractSigned: "contract",
  PaymentRequested: "payment",
  PaymentSucceeded: "payment",
  WorkspaceProvisioned: "provisioning",
  CreditsGranted: "provisioning",
  WelcomeEmailSent: "email",
  SequenceEnrolled: "workflow_action",
  TaskCreated: "workflow_action",
  TaskCompleted: "workflow_action",
  LifecycleTransitioned: "workflow_action",
  FirstLogin: "product_milestone",
  ActivationMilestoneCompleted: "product_milestone",
  CustomerActivated: "product_milestone",
  TicketCreated: "ticket",
  TicketEscalated: "ticket",
  TicketResolved: "ticket",
};

/** Returns null for events that do not appear on a customer timeline. */
export function projectCopsEventToTimeline(event: { event_type: string; payload?: unknown }): CopsTimelineProjection | null {
  const type = TYPE_BY_EVENT[event.event_type];
  if (!type) return null;
  return {
    type,
    visibility: "public",
    summary: summarize(event.event_type, event.payload),
  };
}

function summarize(eventType: string, payload: unknown): string {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if (eventType === "LifecycleTransitioned") {
    return `${String(p.dimension ?? "lifecycle")}: ${String(p.from ?? "?")} → ${String(p.to ?? "?")}`;
  }
  return eventType.replace(/([a-z])([A-Z])/g, "$1 $2");
}
