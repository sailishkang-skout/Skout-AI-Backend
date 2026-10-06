/**
 * COPS-01 — lifecycle state model (Bible p.8). Six independent dimensions. Each dimension has its
 * own allowed-transition table. A transition records actor, time, source and reason, and produces
 * the event payload the caller publishes through the outbox. Closed-won on opportunity does not
 * imply an activated customer: the dimensions never write to each other.
 */

export const COPS_DIMENSIONS = ["opportunity", "commercial", "onboarding", "account", "health", "support"] as const;
export type CopsDimension = (typeof COPS_DIMENSIONS)[number];

export const COPS_STATES = {
  opportunity: ["qualified", "demo", "commercial", "won", "lost"],
  commercial: ["proposal_sent", "msa_pending", "payment_pending", "complete"],
  onboarding: ["not_started", "in_progress", "blocked", "activated"],
  account: ["trial", "paid", "suspended", "closed"],
  health: ["healthy", "watch", "at_risk"],
  support: ["no_issue", "open_ticket", "incident_impacted"],
} as const satisfies Record<CopsDimension, readonly string[]>;

export type CopsState<D extends CopsDimension> = (typeof COPS_STATES)[D][number];

/** Allowed transitions per dimension. Anything not listed is illegal and returns a 409. */
export const COPS_TRANSITIONS: { [D in CopsDimension]: Record<CopsState<D>, readonly CopsState<D>[]> } = {
  opportunity: {
    qualified: ["demo", "lost"],
    demo: ["commercial", "lost"],
    commercial: ["won", "lost"],
    won: [],
    lost: [],
  },
  commercial: {
    proposal_sent: ["msa_pending", "payment_pending"],
    msa_pending: ["payment_pending", "complete"],
    payment_pending: ["complete"],
    complete: [],
  },
  onboarding: {
    not_started: ["in_progress"],
    in_progress: ["blocked", "activated"],
    blocked: ["in_progress"],
    activated: [],
  },
  account: {
    trial: ["paid", "suspended", "closed"],
    paid: ["suspended", "closed"],
    suspended: ["paid", "closed"],
    closed: [],
  },
  health: {
    healthy: ["watch"],
    watch: ["healthy", "at_risk"],
    at_risk: ["watch", "healthy"],
  },
  support: {
    no_issue: ["open_ticket", "incident_impacted"],
    open_ticket: ["no_issue", "incident_impacted"],
    incident_impacted: ["open_ticket", "no_issue"],
  },
};

export class CopsIllegalTransitionError extends Error {
  readonly code = "BUSINESS_STATE_CONFLICT";
  readonly status = 409;
  constructor(
    public readonly dimension: CopsDimension,
    public readonly from: string,
    public readonly to: string,
    public readonly allowed: readonly string[]
  ) {
    super(`Illegal ${dimension} transition: ${from} -> ${to}`);
    this.name = "CopsIllegalTransitionError";
  }
}

export interface CopsTransitionInput {
  dimension: CopsDimension;
  from: string;
  to: string;
  actor: { type: "user" | "system" | "ai" | "integration"; id: string | null };
  source: string;
  reason: string;
  at?: Date;
}

export interface CopsTransitionResult {
  dimension: CopsDimension;
  from: string;
  to: string;
  actor: CopsTransitionInput["actor"];
  source: string;
  reason: string;
  at: Date;
}

/** Validate a transition and return its record. Throws CopsIllegalTransitionError on a bad move. */
export function applyCopsTransition(input: CopsTransitionInput): CopsTransitionResult {
  const table = COPS_TRANSITIONS[input.dimension] as Record<string, readonly string[]>;
  const allowed = table[input.from];
  if (!allowed) {
    throw new CopsIllegalTransitionError(input.dimension, input.from, input.to, []);
  }
  if (!allowed.includes(input.to)) {
    throw new CopsIllegalTransitionError(input.dimension, input.from, input.to, allowed);
  }
  if (!input.reason.trim()) {
    throw new Error("A state transition must record a reason");
  }
  return {
    dimension: input.dimension,
    from: input.from,
    to: input.to,
    actor: input.actor,
    source: input.source,
    reason: input.reason,
    at: input.at ?? new Date(),
  };
}
