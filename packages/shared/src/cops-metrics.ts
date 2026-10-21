/**
 * COPS-13 (Bible p.87-88, p.59): the shared metric-definition catalog, the funnel stages and the
 * server-side analytics event names. API and FE read the same definitions, so a KPI means one
 * thing everywhere. Changing what a metric counts bumps its `version`; every dashboard and
 * drill-through response names the metric id, version and window it used.
 */
import type { CopsResource } from "./cops-rbac.js";

export const COPS_DASHBOARDS = ["leadership", "sales", "cs", "engineering", "finance"] as const;
export type CopsDashboard = (typeof COPS_DASHBOARDS)[number];

export type MetricUnit = "count" | "money" | "percent" | "minutes" | "score";

export interface MetricDefinition {
  id: string;
  version: number;
  label: string;
  /** One plain sentence: what is counted, over which records, in which window. */
  definition: string;
  unit: MetricUnit;
  /** The RBAC resource whose read permission the KPI needs; without it the KPI is restricted. */
  resource: CopsResource;
  /** `events`: counted from outbox events in the window. `state`: current records, as of now. */
  source: "events" | "state";
  /** Outbox event types the KPI counts (events) or each drill row traces to (state). */
  sourceEvents: readonly string[];
  drill: "accounts" | "events";
  dashboards: readonly CopsDashboard[];
}

const m = (d: MetricDefinition) => d;

export const COPS_METRICS = [
  // Revenue (Bible p.59 executive, p.88 leadership/finance)
  m({
    id: "revenue.arr",
    version: 1,
    label: "ARR",
    definition: "Annual recurring revenue: the monthly line items of active and past-due subscriptions, times twelve, by currency, as of now.",
    unit: "money",
    resource: "commercial",
    source: "state",
    sourceEvents: ["PaymentSucceeded", "SubscriptionStatusChanged"],
    drill: "accounts",
    dashboards: ["leadership"],
  }),
  m({
    id: "revenue.mrr",
    version: 1,
    label: "MRR",
    definition: "Monthly recurring revenue: the monthly line items of active and past-due subscriptions, by currency, as of now.",
    unit: "money",
    resource: "commercial",
    source: "state",
    sourceEvents: ["PaymentSucceeded", "SubscriptionStatusChanged"],
    drill: "accounts",
    dashboards: ["leadership", "finance"],
  }),
  m({
    id: "revenue.pipeline",
    version: 1,
    label: "Pipeline",
    definition: "Amount of open opportunities, by currency, as of now.",
    unit: "money",
    resource: "commercial",
    source: "state",
    sourceEvents: ["OpportunityQualified"],
    drill: "accounts",
    dashboards: ["leadership", "sales"],
  }),
  m({
    id: "revenue.renewal_exposure",
    version: 1,
    label: "Renewal exposure",
    definition: "ARR of subscriptions whose term ends in the next 90 days, by currency, as of now.",
    unit: "money",
    resource: "commercial",
    source: "state",
    sourceEvents: ["PaymentSucceeded", "SubscriptionStatusChanged", "RenewalOpened"],
    drill: "accounts",
    dashboards: ["leadership", "cs"],
  }),
  m({
    id: "revenue.retention",
    version: 1,
    label: "Retention",
    definition: "Subscriptions whose term ended in the window that were renewed (their renewal opportunity won), over all that ended.",
    unit: "percent",
    resource: "commercial",
    source: "state",
    sourceEvents: ["RenewalOpened"],
    drill: "accounts",
    dashboards: ["leadership"],
  }),
  // Trials, activation, conversion
  m({
    id: "trials.active",
    version: 1,
    label: "Active trials",
    definition: "Completed trial provisionings whose trial has not ended and whose account has no active subscription, as of now.",
    unit: "count",
    resource: "onboarding",
    source: "state",
    sourceEvents: ["WorkspaceProvisioned"],
    drill: "accounts",
    dashboards: ["leadership", "sales"],
  }),
  m({
    id: "activation.rate",
    version: 1,
    label: "Activation",
    definition: "Accounts provisioned in the window that are activated (CustomerActivated), over all accounts provisioned in the window.",
    unit: "percent",
    resource: "onboarding",
    source: "events",
    sourceEvents: ["WorkspaceProvisioned", "CustomerActivated"],
    drill: "accounts",
    dashboards: ["leadership", "cs"],
  }),
  m({
    id: "conversion.trial_to_paid",
    version: 1,
    label: "Trial conversion",
    definition: "Accounts provisioned in the window with a PaymentSucceeded on any of their opportunities, over all accounts provisioned in the window.",
    unit: "percent",
    resource: "commercial",
    source: "events",
    sourceEvents: ["WorkspaceProvisioned", "PaymentSucceeded"],
    drill: "accounts",
    dashboards: ["leadership", "sales"],
  }),
  m({
    id: "sales.qualified",
    version: 1,
    label: "Qualified opportunities",
    definition: "OpportunityQualified events in the window.",
    unit: "count",
    resource: "crm",
    source: "events",
    sourceEvents: ["OpportunityQualified"],
    drill: "events",
    dashboards: ["sales"],
  }),
  m({
    id: "sales.follow_up_completion",
    version: 1,
    label: "Follow-up completion",
    definition: "Follow-up tasks (sequence steps and onboarding follow-ups) due in the window that are completed, over all due in the window.",
    unit: "percent",
    resource: "crm",
    source: "state",
    sourceEvents: ["TaskCreated", "TaskCompleted"],
    drill: "accounts",
    dashboards: ["sales"],
  }),
  // Customer success
  m({
    id: "cs.at_risk",
    version: 1,
    label: "At-risk accounts",
    definition: "Accounts whose health state is at risk, as of now.",
    unit: "count",
    resource: "crm",
    source: "state",
    sourceEvents: ["HealthSignalDetected"],
    drill: "accounts",
    dashboards: ["leadership", "cs"],
  }),
  m({
    id: "cs.avg_health",
    version: 1,
    label: "Average health",
    definition: "Mean health score of accounts that have one, as of now.",
    unit: "score",
    resource: "crm",
    source: "state",
    sourceEvents: ["HealthSignalDetected"],
    drill: "accounts",
    dashboards: ["cs"],
  }),
  m({
    id: "cs.renewals_due",
    version: 1,
    label: "Renewals due (90d)",
    definition: "Subscriptions whose term ends in the next 90 days, as of now.",
    unit: "count",
    resource: "crm",
    source: "state",
    sourceEvents: ["PaymentSucceeded", "SubscriptionStatusChanged", "RenewalOpened"],
    drill: "accounts",
    dashboards: ["cs"],
  }),
  // Engineering (Bible p.56, p.88)
  m({
    id: "engineering.critical_open",
    version: 1,
    label: "Open critical escalations",
    definition: "Open P1 and P2 tickets, as of now.",
    unit: "count",
    resource: "tickets",
    source: "state",
    sourceEvents: ["TicketCreated", "TicketEscalated"],
    drill: "accounts",
    dashboards: ["leadership", "engineering"],
  }),
  m({
    id: "engineering.sla_breaches",
    version: 1,
    label: "SLA breaches",
    definition: "TicketSlaBreached events in the window.",
    unit: "count",
    resource: "tickets",
    source: "events",
    sourceEvents: ["TicketSlaBreached"],
    drill: "events",
    dashboards: ["engineering"],
  }),
  m({
    id: "engineering.mttr",
    version: 1,
    label: "MTTR",
    definition: "Mean minutes from creation to resolved, of tickets resolved (TicketResolved) in the window.",
    unit: "minutes",
    resource: "tickets",
    source: "events",
    sourceEvents: ["TicketResolved"],
    drill: "events",
    dashboards: ["engineering"],
  }),
  m({
    id: "engineering.open_incidents",
    version: 1,
    label: "Open incidents",
    definition: "Incidents that are open or investigating, as of now.",
    unit: "count",
    resource: "tickets",
    source: "state",
    sourceEvents: ["TicketEscalated"],
    drill: "events",
    dashboards: ["engineering"],
  }),
  // Finance (Bible p.67, p.88)
  m({
    id: "finance.overdue",
    version: 1,
    label: "Overdue",
    definition: "Amount of open subscription bills past their due date, by currency, as of now.",
    unit: "money",
    resource: "billing",
    source: "state",
    sourceEvents: ["SubscriptionStatusChanged"],
    drill: "accounts",
    dashboards: ["finance"],
  }),
  m({
    id: "finance.payments",
    version: 1,
    label: "Payments received",
    definition: "PaymentSucceeded events in the window.",
    unit: "count",
    resource: "billing",
    source: "events",
    sourceEvents: ["PaymentSucceeded"],
    drill: "events",
    dashboards: ["finance"],
  }),
  m({
    id: "finance.past_due_subscriptions",
    version: 1,
    label: "Past-due subscriptions",
    definition: "Subscriptions that are past due, restricted or suspended, as of now.",
    unit: "count",
    resource: "billing",
    source: "state",
    sourceEvents: ["SubscriptionStatusChanged"],
    drill: "accounts",
    dashboards: ["finance"],
  }),
  // Operations (Bible p.59)
  m({
    id: "ops.workflow_failures",
    version: 1,
    label: "Workflow failures",
    definition: "Workflow runs (not simulations) that failed in the window.",
    unit: "count",
    resource: "analytics",
    source: "events",
    sourceEvents: [],
    drill: "events",
    dashboards: ["leadership"],
  }),
] as const satisfies readonly MetricDefinition[];

export type CopsMetricId = (typeof COPS_METRICS)[number]["id"];

export function getMetric(id: string): MetricDefinition | undefined {
  return (COPS_METRICS as readonly MetricDefinition[]).find((d) => d.id === id);
}

export function metricsForDashboard(dashboard: CopsDashboard): MetricDefinition[] {
  return (COPS_METRICS as readonly MetricDefinition[]).filter((d) => d.dashboards.includes(dashboard));
}

/** Funnel stages (Bible p.87), in order, with the outbox events that mark an account reaching them. */
export const FUNNEL_STAGES = ["qualified", "commercial", "provisioned", "first_login", "activated", "paid", "renewed"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];
export const FUNNEL_STAGE_EVENTS: Record<FunnelStage, readonly string[]> = {
  qualified: ["OpportunityQualified"],
  commercial: ["ProposalSent", "ContractSent"],
  provisioned: ["WorkspaceProvisioned"],
  first_login: ["FirstLogin"],
  activated: ["CustomerActivated"],
  paid: ["PaymentSucceeded"],
  renewed: ["RenewalOpened"],
};

/** Server-side analytics name for a domain event: canonical, versioned through `schema_version`. */
export function serverAnalyticsEventName(eventType: string): string {
  return `cops.server.${eventType.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}`;
}

/** Payload keys whose string values are enums or versions, never free text. */
const ENUM_KEYS = new Set([
  "severity",
  "priority",
  "clock",
  "task_type",
  "rule_version",
  "template_version",
  "status",
  "from",
  "to",
  "dimension",
  "signal",
  "cycle",
  "activity_type",
  "required_approvers",
]);

/**
 * The properties the warehouse may receive: ids, enums, numbers and booleans only. Free text
 * (reasons, evidence, names) is dropped, so nothing personal or internal leaves the operational DB.
 */
export function analyticsSafeProperties(payload: Record<string, unknown>): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string" && (k.endsWith("_id") || ENUM_KEYS.has(k)) && v.length <= 100) out[k] = v;
    else if (Array.isArray(v) && ENUM_KEYS.has(k) && v.every((x) => typeof x === "string")) out[k] = v as string[];
  }
  return out;
}

/** Window helpers: the default dashboard window is the 30 days up to now. */
export function resolveWindow(from?: string | Date | null, to?: string | Date | null, now = new Date()): { from: Date; to: Date } {
  const end = to ? new Date(to) : now;
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 86_400_000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) throw new Error("INVALID_WINDOW");
  if (end.getTime() - start.getTime() > 731 * 86_400_000) throw new Error("WINDOW_TOO_LONG");
  return { from: start, to: end };
}
