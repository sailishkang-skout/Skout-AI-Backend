/**
 * COPS-13 recommendation candidates (Bible p.83): rules over structured account data. Every
 * candidate points at the real records it came from (evidence refs), so a recommendation always
 * has evidence by construction; the model only words the rationale. Pure functions: the context
 * builder decides what the caller may see, and a rule without its data simply does not fire.
 */
export const RECOMMENDATION_TYPES = ["renewal_risk", "trial_not_activated", "ticket_heavy", "sla_breached", "payment_past_due", "expansion_signal", "stalled_onboarding"] as const;
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

export const RECOMMENDATION_ACTIONS = ["create_task", "start_playbook", "renewal_prep_task"] as const;
export type RecommendationActionKind = (typeof RECOMMENDATION_ACTIONS)[number];

export type EvidenceKind = "health_score" | "ticket" | "subscription" | "invoice" | "provisioning" | "onboarding_signal" | "sla_clock" | "timeline_event";
export interface EvidenceRef {
  kind: EvidenceKind;
  id: string;
  label: string;
}

export interface SuggestedAction {
  kind: RecommendationActionKind;
  params: { title: string; task_type: string; priority: "low" | "medium" | "high"; due_in_hours: number; assign_to: "csm" | "account_owner"; playbook_key?: string };
}

export interface Candidate {
  type: RecommendationType;
  headline: string;
  /** The rule's own wording, used when no model is configured or the model's answer is refused. */
  rationale: string;
  evidence: EvidenceRef[];
  action: SuggestedAction;
  confidence: number;
  dedupeKey: string;
  /** Approving needs write on this resource too (commercial types need commercial:write). */
  resource: "crm" | "commercial" | "billing" | "onboarding" | "tickets";
}

export interface AccountContext {
  now: Date;
  account: { id: string; name: string; healthScore: number | null; healthState: string | null; healthComputedAt: Date | null; healthScoreId?: string | null };
  /** Omitted (undefined) when the caller cannot read commercial data. */
  subscriptions?: { id: string; status: string; termEnd: Date; arrMinor: number; currency: string }[];
  /** Omitted when the caller cannot read billing data. */
  overdueInvoices?: { id: string; dueAt: Date; amountMinor: number; currency: string }[];
  /** Omitted when the caller cannot read onboarding data. */
  onboarding?: {
    trials: { id: string; trialEndsAt: Date }[];
    activated: boolean;
    stalledSignals: { id: string; trigger: string; firedAt: Date }[];
  };
  /** Omitted when the caller cannot read tickets. */
  tickets?: { id: string; title: string; priority: string; severity: string; breachedClockIds: string[] }[];
  signals: { eventId: string; signal: string; at: Date }[];
}

const DAY = 86_400_000;
const daysUntil = (d: Date, now: Date) => Math.max(0, Math.ceil((d.getTime() - now.getTime()) / DAY));
const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const clamp = (x: number) => Math.round(Math.min(0.95, Math.max(0.3, x)) * 100) / 100;

function healthRef(c: AccountContext): EvidenceRef[] {
  return c.account.healthScore === null ? [] : [{ kind: "health_score", id: c.account.healthScoreId ?? c.account.id, label: `Health ${c.account.healthScore} (${c.account.healthState ?? "unknown"})` }];
}

export function recommendationCandidates(c: AccountContext): Candidate[] {
  const out: Candidate[] = [];
  const now = c.now;
  const weakHealth = c.account.healthState === "at_risk" || c.account.healthState === "watch";

  // Renewal within 90 days on an account whose health is weak.
  for (const s of c.subscriptions ?? []) {
    const days = daysUntil(s.termEnd, now);
    if (!["active", "past_due"].includes(s.status) || s.termEnd.getTime() < now.getTime() || days > 90 || !weakHealth) continue;
    out.push({
      type: "renewal_risk",
      headline: `Renewal in ${days} days with ${c.account.healthState === "at_risk" ? "at-risk" : "watch"} health`,
      rationale: `${money(s.arrMinor, s.currency)} ARR renews in ${days} days and the account's health is ${c.account.healthScore ?? "unknown"}. Review outcomes and stakeholders before the renewal conversation.`,
      evidence: [{ kind: "subscription", id: s.id, label: `${money(s.arrMinor, s.currency)} ARR, term ends ${s.termEnd.toISOString().slice(0, 10)}` }, ...healthRef(c)],
      action: { kind: "start_playbook", params: { title: "Renewal approaching: outcomes review, stakeholders, commercial prep", task_type: "renewal_action", priority: "high", due_in_hours: 120, assign_to: "csm", playbook_key: "cs_renewal_approaching" } },
      confidence: clamp(0.55 + (90 - days) / 300 + (c.account.healthState === "at_risk" ? 0.15 : 0)),
      dedupeKey: `renewal_risk:${s.id}:${s.termEnd.toISOString().slice(0, 10)}`,
      resource: "commercial",
    });
  }

  // Trial ending within 7 days and the account is not activated.
  if (c.onboarding && !c.onboarding.activated) {
    for (const t of c.onboarding.trials) {
      const days = daysUntil(t.trialEndsAt, now);
      if (t.trialEndsAt.getTime() < now.getTime() || days > 7) continue;
      out.push({
        type: "trial_not_activated",
        headline: `Trial ends in ${days} day(s) and the account is not activated`,
        rationale: `The trial ends on ${t.trialEndsAt.toISOString().slice(0, 10)} and the activation milestones are not met. Book a trial review to unblock activation or agree an extension.`,
        evidence: [{ kind: "provisioning", id: t.id, label: `Trial ends ${t.trialEndsAt.toISOString().slice(0, 10)}` }],
        action: { kind: "create_task", params: { title: "Trial ending without activation: book a trial review", task_type: "call", priority: "high", due_in_hours: 24, assign_to: "account_owner" } },
        confidence: clamp(0.9 - days * 0.05),
        dedupeKey: `trial_not_activated:${t.id}`,
        resource: "onboarding",
      });
    }
  }

  // Ticket-heavy: three or more open tickets, or two or more high/critical.
  const open = c.tickets ?? [];
  const serious = open.filter((t) => t.severity === "high" || t.severity === "critical");
  if (open.length >= 3 || serious.length >= 2) {
    const ids = open.map((t) => t.id).sort();
    out.push({
      type: "ticket_heavy",
      headline: `${open.length} open tickets (${serious.length} high or critical)`,
      rationale: `The account has ${open.length} open engineering tickets, ${serious.length} of them high or critical. A technical success review keeps the relationship ahead of the fixes.`,
      evidence: open.slice(0, 5).map((t) => ({ kind: "ticket" as const, id: t.id, label: `${t.priority.toUpperCase()} ${t.title}` })),
      action: { kind: "start_playbook", params: { title: "Ticket-heavy account: run a technical success review", task_type: "review", priority: "high", due_in_hours: 48, assign_to: "csm", playbook_key: "cs_ticket_heavy" } },
      confidence: clamp(0.5 + open.length * 0.05 + serious.length * 0.08),
      dedupeKey: `ticket_heavy:${ids.join(",").slice(0, 400)}`,
      resource: "tickets",
    });
  }

  // An open P1/P2 with a breached SLA clock.
  for (const t of open.filter((x) => (x.priority === "p1" || x.priority === "p2") && x.breachedClockIds.length > 0)) {
    out.push({
      type: "sla_breached",
      headline: `SLA breached on ${t.priority.toUpperCase()} "${t.title}"`,
      rationale: `The ${t.priority.toUpperCase()} ticket "${t.title}" has breached its SLA. Send the customer a status update and agree the next checkpoint.`,
      evidence: [{ kind: "ticket", id: t.id, label: `${t.priority.toUpperCase()} ${t.title}` }, ...t.breachedClockIds.map((id) => ({ kind: "sla_clock" as const, id, label: "SLA clock breached" }))],
      action: { kind: "create_task", params: { title: `SLA breached: update the customer on "${t.title}"`.slice(0, 200), task_type: "ticket_follow_up", priority: "high", due_in_hours: 4, assign_to: "csm" } },
      confidence: 0.9,
      dedupeKey: `sla_breached:${t.id}`,
      resource: "tickets",
    });
  }

  // Payment past due.
  const overdue = c.overdueInvoices ?? [];
  if (overdue.length > 0) {
    const oldest = [...overdue].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0]!;
    const late = Math.floor((now.getTime() - oldest.dueAt.getTime()) / DAY);
    out.push({
      type: "payment_past_due",
      headline: `${overdue.length} bill(s) overdue, oldest by ${late} day(s)`,
      rationale: `The oldest unpaid bill (${money(oldest.amountMinor, oldest.currency)}) was due ${late} day(s) ago. Check in with the billing contact before the subscription is restricted.`,
      evidence: overdue.slice(0, 5).map((i) => ({ kind: "invoice" as const, id: i.id, label: `${money(i.amountMinor, i.currency)} due ${i.dueAt.toISOString().slice(0, 10)}` })),
      action: { kind: "create_task", params: { title: "Payment overdue: check in with the billing contact", task_type: "call", priority: late > 14 ? "high" : "medium", due_in_hours: 48, assign_to: "account_owner" } },
      confidence: clamp(0.6 + late / 60),
      dedupeKey: `payment_past_due:${oldest.id}`,
      resource: "billing",
    });
  }

  // An expansion signal in the last 30 days.
  const expansion = c.signals.filter((s) => s.signal === "expansion_signal" && now.getTime() - s.at.getTime() <= 30 * DAY).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  if (expansion) {
    out.push({
      type: "expansion_signal",
      headline: "Expansion signal: route to the sales owner",
      rationale: `Usage crossed the expansion threshold on ${expansion.at.toISOString().slice(0, 10)}. Route it to the account's sales owner with the evidence.`,
      evidence: [{ kind: "timeline_event", id: expansion.eventId, label: `Expansion signal ${expansion.at.toISOString().slice(0, 10)}` }, ...healthRef(c)],
      action: { kind: "start_playbook", params: { title: "Expansion signal", task_type: "call", priority: "medium", due_in_hours: 72, assign_to: "account_owner", playbook_key: "cs_expansion_signal" } },
      confidence: 0.7,
      dedupeKey: `expansion_signal:${expansion.eventId}`,
      resource: "crm",
    });
  }

  // Stalled onboarding: a stall signal in the last 14 days and not activated.
  if (c.onboarding && !c.onboarding.activated) {
    const recent = c.onboarding.stalledSignals.filter((s) => now.getTime() - s.firedAt.getTime() <= 14 * DAY).sort((a, b) => b.firedAt.getTime() - a.firedAt.getTime())[0];
    if (recent) {
      out.push({
        type: "stalled_onboarding",
        headline: `Onboarding stalled: ${recent.trigger.replace(/_/g, " ")}`,
        rationale: `Onboarding raised "${recent.trigger.replace(/_/g, " ")}" on ${recent.firedAt.toISOString().slice(0, 10)} and the account is not activated. Offer guided onboarding to reach the first value.`,
        evidence: [{ kind: "onboarding_signal", id: recent.id, label: `${recent.trigger.replace(/_/g, " ")} ${recent.firedAt.toISOString().slice(0, 10)}` }],
        action: { kind: "create_task", params: { title: "Onboarding stalled: offer guided onboarding", task_type: "onboarding_check", priority: "medium", due_in_hours: 48, assign_to: "csm" } },
        confidence: 0.65,
        dedupeKey: `stalled_onboarding:${recent.id}`,
        resource: "onboarding",
      });
    }
  }
  return out;
}
