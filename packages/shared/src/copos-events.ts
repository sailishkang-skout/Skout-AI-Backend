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
export const WorkspaceProvisionedPayload = z.object({ account_id: id, workspace_id: id });
export const CreditsGrantedPayload = z.object({ wallet_id: id, amount: z.number().int(), reason: z.string() });
export const WelcomeEmailSentPayload = z.object({ account_id: id, email_send_id: id });
export const SequenceEnrolledPayload = z.object({ account_id: id, enrollment_id: id, template_version: z.string() });
export const TaskCreatedPayload = z.object({ task_id: id, account_id: id, task_type: z.string() });
export const FirstLoginPayload = z.object({ account_id: id, user_id: id });
export const ActivationMilestoneCompletedPayload = z.object({ account_id: id, milestone_id: id });
export const CustomerActivatedPayload = z.object({ account_id: id, rule_version: z.string() });
export const TicketCreatedPayload = z.object({ ticket_id: id, account_id: id, severity: z.string() });
export const TicketEscalatedPayload = z.object({ ticket_id: id, account_id: id, severity: z.string() });
export const TicketResolvedPayload = z.object({ ticket_id: id, account_id: id });
export const LifecycleTransitionedPayload = z.object({
  dimension: z.enum(["opportunity", "commercial", "onboarding", "account", "health", "support"]),
  entity_id: z.string().uuid(),
  from: z.string(),
  to: z.string(),
  source: z.string().min(1),
  reason: z.string().min(1),
});

/** Event type → payload schema. The single registry consumers and outbox writers use. */
export const COPS_PHASE1_EVENTS = {
  OpportunityQualified: OpportunityQualifiedPayload,
  ProposalSent: ProposalSentPayload,
  ContractSent: ContractSentPayload,
  ContractSigned: ContractSignedPayload,
  PaymentRequested: PaymentRequestedPayload,
  PaymentSucceeded: PaymentSucceededPayload,
  WorkspaceProvisioned: WorkspaceProvisionedPayload,
  CreditsGranted: CreditsGrantedPayload,
  WelcomeEmailSent: WelcomeEmailSentPayload,
  SequenceEnrolled: SequenceEnrolledPayload,
  TaskCreated: TaskCreatedPayload,
  FirstLogin: FirstLoginPayload,
  ActivationMilestoneCompleted: ActivationMilestoneCompletedPayload,
  CustomerActivated: CustomerActivatedPayload,
  TicketCreated: TicketCreatedPayload,
  TicketEscalated: TicketEscalatedPayload,
  TicketResolved: TicketResolvedPayload,
  LifecycleTransitioned: LifecycleTransitionedPayload,
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
