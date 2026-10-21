/**
 * COPS-01 — Phase 1 CustomerOps event contract (Zod).
 *
 * Envelope fields and event names follow Bible v2 (Appendix A and the Phase 1 event list on p.73).
 * Payload shapes are minimal (ids + the fields the doc names). Extend per ticket; any change to a
 * shape bumps schema_version. Consumers must reject unknown schema_version values.
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";

export const COPS_SCHEMA_VERSION = 1 as const;

export const CopsActorSchema = z.object({
  type: z.enum(["user", "system", "ai", "integration"]),
  id: z.string().nullable(),
});

export const CopsEnvelopeSchema = z.object({
  event_id: z.string().uuid(),
  event_type: z.string().regex(/^[A-Z][A-Za-z]*$/),
  schema_version: z.literal(COPS_SCHEMA_VERSION),
  tenant_id: z.string().min(1),
  aggregate_type: z.string().min(1),
  aggregate_id: z.string().min(1),
  occurred_at: z.string().datetime(),
  actor: CopsActorSchema,
  correlation_id: z.string().uuid(),
  causation_id: z.string().uuid().nullable(),
  payload: z.record(z.unknown()),
});

export type CopsEnvelope = z.infer<typeof CopsEnvelopeSchema>;

const id = z.string().min(1);

// Phase 1 event payloads, in the order Bible p.73 lists them.
export const OpportunityQualifiedPayload = z.object({ opportunity_id: id, account_id: id });
export const ProposalSentPayload = z.object({ proposal_id: id, opportunity_id: id });
export const ContractSentPayload = z.object({ contract_id: id, opportunity_id: id });
export const ContractSignedPayload = z.object({ contract_id: id, opportunity_id: id });
export const PaymentRequestedPayload = z.object({ payment_request_id: id, opportunity_id: id });
export const PaymentSucceededPayload = z.object({ payment_request_id: id, opportunity_id: id });
/** Added for COPS-03: the commercial gate opened for an opportunity. Emitted once per opportunity. */
export const ProvisioningRequestedPayload = z.object({
  opportunity_id: id,
  account_id: id.nullable(),
  policy: z.enum(["trial_approval_only", "signature", "payment", "signature+payment", "manual_override"]),
  trigger: z.enum(["signature", "payment", "trial_approval", "override", "policy_change", "approval"]),
});
export const WorkspaceProvisionedPayload = z.object({ account_id: id, workspace_id: id });
/** COPS-04: optional account_id (additive) so the grant reaches the account timeline. */
export const CreditsGrantedPayload = z.object({ wallet_id: id, amount: z.number().int(), reason: z.string(), account_id: id.optional() });
export const WelcomeEmailSentPayload = z.object({ account_id: id, email_send_id: id });
export const SequenceEnrolledPayload = z.object({ account_id: id, enrollment_id: id, template_version: z.string() });
export const TaskCreatedPayload = z.object({ task_id: id, account_id: id, task_type: z.string() });
/** Added for COPS-02: every recorded CRM activity reaches the timeline through this event. */
export const ActivityRecordedPayload = z.object({
  activity_id: id,
  activity_type: z.string(),
  entity_type: z.string(),
  entity_id: id,
  account_id: id.nullable(),
  subject: z.string().nullable(),
  visibility: z.enum(["public", "internal"]),
});
/** Added for COPS-02: completing a task emits an event (COPS-02 ticket). */
export const TaskCompletedPayload = z.object({ task_id: id, account_id: id.nullable(), task_type: z.string() });
export const FirstLoginPayload = z.object({ account_id: id, user_id: id });
export const ActivationMilestoneCompletedPayload = z.object({ account_id: id, milestone_id: id });
export const CustomerActivatedPayload = z.object({ account_id: id, rule_version: z.string() });
export const TicketCreatedPayload = z.object({ ticket_id: id, account_id: id, severity: z.string() });
export const TicketEscalatedPayload = z.object({ ticket_id: id, account_id: id, severity: z.string() });
export const TicketResolvedPayload = z.object({ ticket_id: id, account_id: id });
/** COPS-12: an SLA clock passed its target (once per clock). */
export const TicketSlaBreachedPayload = z.object({ ticket_id: id, account_id: id, clock: z.enum(["response", "resolution"]), priority: z.string(), target_minutes: z.number().int() });
export const LifecycleTransitionedPayload = z.object({
  dimension: z.enum(["opportunity", "commercial", "onboarding", "account", "health", "support"]),
  entity_id: z.string().uuid(),
  from: z.string(),
  to: z.string(),
  source: z.string().min(1),
  reason: z.string().min(1),
});

/** COPS-08: an approval was asked for; the approver roles it names are who gets notified. */
export const ApprovalRequestedPayload = z.object({
  approval_id: z.string().uuid(),
  proposal_id: z.string().uuid(),
  opportunity_id: z.string().uuid(),
  proposal_version: z.number().int().min(1),
  required_approvers: z.array(z.enum(["sales_manager", "finance", "legal_revops", "executive"])).min(1),
});
/** COPS-08: an approval reached an outcome (granted, rejected, or voided by a change of terms). */
export const ApprovalDecidedPayload = z.object({
  approval_id: z.string().uuid(),
  proposal_id: z.string().uuid(),
  opportunity_id: z.string().uuid(),
  proposal_version: z.number().int().min(1),
  status: z.enum(["approved", "rejected", "voided"]),
  reason: z.string().nullable(),
});

/** COPS-08: a subscription moved along the failed-payment timeline, or back to active after payment. */
export const SubscriptionStatusChangedPayload = z.object({
  subscription_id: z.string().uuid(),
  account_id: z.string().uuid(),
  from: z.enum(["active", "past_due", "restricted", "suspended", "closed"]),
  to: z.enum(["active", "past_due", "restricted", "suspended", "closed"]),
  /** Days since the due date of the oldest unpaid bill; null when nothing is unpaid. */
  day: z.number().int().min(0).nullable(),
});

/** COPS-08 (Bible p.73): a renewal opportunity was opened ahead of the end of a term. Once per term. */
export const RenewalOpenedPayload = z.object({
  subscription_id: z.string().uuid(),
  account_id: z.string().uuid(),
  opportunity_id: z.string().uuid(),
  original_opportunity_id: z.string().uuid(),
  term_end: z.string().datetime(),
});

/**
 * COPS-11: the health sweep raised a customer-success signal for an account. One event per account,
 * signal and cycle (the event id is derived from them), so a success playbook runs once per cycle.
 */
export const HEALTH_SIGNALS = ["low_adoption", "ticket_heavy", "renewal_approaching", "expansion_signal"] as const;
export const HealthSignalDetectedPayload = z.object({
  account_id: z.string().uuid(),
  signal: z.enum(HEALTH_SIGNALS),
  cycle: z.string().min(1),
  health_score: z.number().int().nullable(),
  evidence: z.array(z.object({ factor: z.string(), reason: z.string() })),
});

/** Event type → payload schema. The single registry consumers and outbox writers use. */
export const COPS_PHASE1_EVENTS = {
  OpportunityQualified: OpportunityQualifiedPayload,
  ProposalSent: ProposalSentPayload,
  ContractSent: ContractSentPayload,
  ContractSigned: ContractSignedPayload,
  PaymentRequested: PaymentRequestedPayload,
  PaymentSucceeded: PaymentSucceededPayload,
  ProvisioningRequested: ProvisioningRequestedPayload,
  WorkspaceProvisioned: WorkspaceProvisionedPayload,
  CreditsGranted: CreditsGrantedPayload,
  WelcomeEmailSent: WelcomeEmailSentPayload,
  SequenceEnrolled: SequenceEnrolledPayload,
  TaskCreated: TaskCreatedPayload,
  TaskCompleted: TaskCompletedPayload,
  ActivityRecorded: ActivityRecordedPayload,
  FirstLogin: FirstLoginPayload,
  ActivationMilestoneCompleted: ActivationMilestoneCompletedPayload,
  CustomerActivated: CustomerActivatedPayload,
  TicketCreated: TicketCreatedPayload,
  TicketEscalated: TicketEscalatedPayload,
  TicketSlaBreached: TicketSlaBreachedPayload,
  TicketResolved: TicketResolvedPayload,
  LifecycleTransitioned: LifecycleTransitionedPayload,
  ApprovalRequested: ApprovalRequestedPayload,
  ApprovalDecided: ApprovalDecidedPayload,
  SubscriptionStatusChanged: SubscriptionStatusChangedPayload,
  RenewalOpened: RenewalOpenedPayload,
  HealthSignalDetected: HealthSignalDetectedPayload,
} as const;

export type CopsPhase1EventType = keyof typeof COPS_PHASE1_EVENTS;

export function createCopsEvent<T extends Record<string, unknown>>(input: {
  eventType: CopsPhase1EventType;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  actor: z.infer<typeof CopsActorSchema>;
  correlationId?: string;
  causationId?: string | null;
  payload: T;
  occurredAt?: Date;
}): CopsEnvelope {
  const eventId = randomUUID();
  return parseCopsEvent({
    event_id: eventId,
    event_type: input.eventType,
    schema_version: COPS_SCHEMA_VERSION,
    tenant_id: input.tenantId,
    aggregate_type: input.aggregateType,
    aggregate_id: input.aggregateId,
    occurred_at: (input.occurredAt ?? new Date()).toISOString(),
    actor: input.actor,
    correlation_id: input.correlationId ?? eventId,
    causation_id: input.causationId ?? null,
    payload: input.payload,
  });
}

/** Validate an envelope and its payload against the registry. Throws ZodError on mismatch. */
export function parseCopsEvent(input: unknown) {
  const envelope = CopsEnvelopeSchema.parse(input);
  const schema = COPS_PHASE1_EVENTS[envelope.event_type as CopsPhase1EventType];
  if (!schema) {
    throw new Error(`Unknown COPS event_type: ${envelope.event_type}`);
  }
  return { ...envelope, payload: schema.parse(envelope.payload) };
}
