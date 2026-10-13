/**
 * COPS-06 engineering tickets (Bible p.51-53, 56-57, 65; Epic E13): the state machine, the
 * visibility rule and the safe-diagnostics allowlist. Pure, so the rules are tested without a DB
 * and shared with the frontend contract.
 */

export const TICKET_STATUSES = [
  "new",
  "triage",
  "assigned",
  "in_progress",
  "testing",
  "waiting_on_customer",
  "resolved",
  "verified",
  "closed",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** New -> Triage -> Assigned -> In Progress -> Testing -> Waiting on Customer -> Resolved -> Verified -> Closed. */
export const TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  new: ["triage", "closed"],
  triage: ["assigned", "waiting_on_customer", "closed"],
  assigned: ["in_progress", "triage", "waiting_on_customer"],
  in_progress: ["testing", "waiting_on_customer", "assigned"],
  testing: ["waiting_on_customer", "resolved", "in_progress"],
  waiting_on_customer: ["resolved", "in_progress", "testing", "triage"],
  // A resolution the customer rejects reopens the work.
  resolved: ["verified", "in_progress"],
  verified: ["closed", "in_progress"],
  closed: [],
};

/** Statuses that count as open for the CRM summary (open count, max severity). */
export const TICKET_OPEN_STATUSES: readonly TicketStatus[] = ["new", "triage", "assigned", "in_progress", "testing", "waiting_on_customer"];

export function canTransitionTicket(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from].includes(to);
}

export const TICKET_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type TicketSeverity = (typeof TICKET_SEVERITIES)[number];
export const ticketSeverityRank = (severity: string): number => TICKET_SEVERITIES.indexOf(severity as TicketSeverity);

/** Highest severity in a list, or null for an empty list. */
export function maxTicketSeverity(severities: readonly string[]): TicketSeverity | null {
  let max = -1;
  for (const s of severities) max = Math.max(max, ticketSeverityRank(s));
  return max < 0 ? null : TICKET_SEVERITIES[max]!;
}

export const TICKET_PRIORITIES = ["p1", "p2", "p3", "p4"] as const;
export const TICKET_CATEGORIES = ["bug", "integration", "data", "performance", "access", "other"] as const;
export const TICKET_ENVIRONMENTS = ["production", "sandbox", "staging"] as const;

export const TICKET_VISIBILITIES = ["internal", "customer"] as const;
export type TicketVisibility = (typeof TICKET_VISIBILITIES)[number];

/**
 * A derived comment (an AI summary) inherits the visibility of its sources: one internal source
 * makes it internal. No sources means internal, so the default is deny.
 */
export function inheritedTicketVisibility(sources: readonly string[]): TicketVisibility {
  return sources.length > 0 && sources.every((v) => v === "customer") ? "customer" : "internal";
}

/**
 * Safe diagnostics: the only keys a ticket may carry from the customer's account context. No
 * tokens, credentials, message bodies or commercial values; anything not listed is dropped.
 */
export const TICKET_DIAGNOSTIC_KEYS = [
  "customer_workspace_id",
  "plan",
  "trial_ends_at",
  "activation_pct",
  "first_login_at",
  "integrations",
  "blocker",
  "error_code",
  "request_id",
  "app_version",
  "browser",
  "occurred_at",
] as const;

const SECRET_LIKE = /(secret|token|password|authorization|api[_-]?key|bearer\s+[a-z0-9._-]{8,})/i;

function safeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return SECRET_LIKE.test(value) ? undefined : value.slice(0, 500);
  if (depth >= 2) return undefined;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => safeValue(v, depth + 1)).filter((v) => v !== undefined);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
      if (SECRET_LIKE.test(k)) continue;
      const safe = safeValue(v, depth + 1);
      if (safe !== undefined) out[k] = safe;
    }
    return out;
  }
  return undefined;
}

export function sanitizeTicketDiagnostics(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, unknown> = {};
  for (const key of TICKET_DIAGNOSTIC_KEYS) {
    const safe = safeValue((input as Record<string, unknown>)[key], 0);
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}
