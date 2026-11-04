/**
 * COPS-13 recommendation candidates (Bible p.83): rules over structured account data. Every
 * candidate points at the real records it came from (evidence refs), so a recommendation always
 * has evidence by construction; the model only words the rationale. Pure functions: the context
 * builder decides what the caller may see, and a rule without its data simply does not fire.
 */
export const RECOMMENDATION_TYPES = ["renewal_risk", "trial_not_activated", "ticket_heavy", "sla_breached", "payment_past_due", "expansion_signal", "stalled_onboarding", "credits_running_low"] as const;
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

export const RECOMMENDATION_ACTIONS = ["create_task", "start_playbook", "renewal_prep_task"] as const;
export type RecommendationActionKind = (typeof RECOMMENDATION_ACTIONS)[number];

export type EvidenceKind = "health_score" | "ticket" | "subscription" | "invoice" | "provisioning" | "onboarding_signal" | "sla_clock" | "timeline_event" | "credit_ledger";
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
  /** Product usage of the account's provisioned workspaces. Omitted when the caller cannot read onboarding data. */
  usage?: { workspaceId: string; balance: number; granted: number; consumed30d: number; lastConsumeId: string | null }[];
  /** The latest call, email or meeting on the account's timeline (public rows only); null when there is none. */
  lastTouch?: { id: string; type: string; at: Date } | null;
  /** Playbooks (automation template keys) already running on this account. */
  runningPlaybooks?: string[];
}

const DAY = 86_400_000;

/** COPS-05 stalled-onboarding triggers, in words. first_login and trial_ending are not stalls. */
const STALL_LABEL: Record<string, string> = {
  no_delivery: "the onboarding email was not delivered",
  hard_bounce: "the onboarding email bounced",
  delivered_no_login: "the onboarding email was delivered but nobody has signed in",
  login_no_value: "users signed in but have not reached the first value",
  integration_error: "an integration is failing",
  low_credits: "credits are running low",
};
const daysUntil = (d: Date, now: Date) => Math.max(0, Math.ceil((d.getTime() - now.getTime()) / DAY));
const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const clamp = (x: number) => Math.round(Math.min(0.95, Math.max(0.3, x)) * 100) / 100;

function healthRef(c: AccountContext): EvidenceRef[] {
  return c.account.healthScore === null ? [] : [{ kind: "health_score", id: c.account.healthScoreId ?? c.account.id, label: `Health ${c.account.healthScore} (${c.account.healthState ?? "unknown"})` }];
}

/** A rule that suggests a playbook already running on the account is dropped: the playbook is the follow-up. */
export function recommendationCandidates(c: AccountContext): Candidate[] {
  const running = new Set(c.runningPlaybooks ?? []);
  return candidates(c).filter((x) => !(x.action.kind === "start_playbook" && x.action.params.playbook_key && running.has(x.action.params.playbook_key)));
}

function candidates(c: AccountContext): Candidate[] {
  const out: Candidate[] = [];
  const now = c.now;
  const weakHealth = c.account.healthState === "at_risk" || c.account.healthState === "watch";
  // No call, email or meeting in 30 days. Only known when the timeline was read (lastTouch !== undefined).
  const touchDays = c.lastTouch ? Math.floor((now.getTime() - c.lastTouch.at.getTime()) / DAY) : null;
  const staleTouch = c.lastTouch !== undefined && (touchDays === null || touchDays > 30);
  const touchRef: EvidenceRef[] =
    c.lastTouch && staleTouch ? [{ kind: "timeline_event", id: c.lastTouch.id, label: `Last ${c.lastTouch.type} ${touchDays} days ago (${c.lastTouch.at.toISOString().slice(0, 10)})` }] : [];
  const touchText = !staleTouch ? "" : touchDays === null ? " No call, email or meeting is on the timeline." : ` The last ${c.lastTouch!.type} was ${touchDays} days ago.`;

  // Renewal within 90 days on an account whose health is weak.
  for (const s of c.subscriptions ?? []) {
    const days = daysUntil(s.termEnd, now);
    if (!["active", "past_due"].includes(s.status) || s.termEnd.getTime() < now.getTime() || days > 90 || !weakHealth) continue;
    out.push({
      type: "renewal_risk",
      headline: `Renewal in ${days} days with ${c.account.healthState === "at_risk" ? "at-risk" : "watch"} health`,
      rationale: `${money(s.arrMinor, s.currency)} ARR renews in ${days} days and the account's health is ${c.account.healthScore ?? "unknown"}.${touchText} Review outcomes and stakeholders before the renewal conversation.`,
      evidence: [{ kind: "subscription", id: s.id, label: `${money(s.arrMinor, s.currency)} ARR, term ends ${s.termEnd.toISOString().slice(0, 10)}` }, ...healthRef(c), ...touchRef],
      action: { kind: "start_playbook", params: { title: "Renewal approaching: outcomes review, stakeholders, commercial prep", task_type: "renewal_action", priority: "high", due_in_hours: 120, assign_to: "csm", playbook_key: "cs_renewal_approaching" } },
      confidence: clamp(0.55 + (90 - days) / 300 + (c.account.healthState === "at_risk" ? 0.15 : 0) + (staleTouch ? 0.1 : 0)),
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
    const recent = c.onboarding.stalledSignals
      .filter((s) => STALL_LABEL[s.trigger] && now.getTime() - s.firedAt.getTime() <= 14 * DAY)
      .sort((a, b) => b.firedAt.getTime() - a.firedAt.getTime())[0];
    if (recent) {
      const what = STALL_LABEL[recent.trigger]!;
      out.push({
        type: "stalled_onboarding",
        headline: `Onboarding stalled: ${what}`,
        rationale: `On ${recent.firedAt.toISOString().slice(0, 10)} ${what}, and the account is not activated. Offer guided onboarding to reach the first value.`,
        evidence: [{ kind: "onboarding_signal", id: recent.id, label: `${what[0]!.toUpperCase()}${what.slice(1)} (${recent.firedAt.toISOString().slice(0, 10)})` }],
        action: { kind: "create_task", params: { title: "Onboarding stalled: offer guided onboarding", task_type: "onboarding_check", priority: "medium", due_in_hours: 48, assign_to: "csm" } },
        confidence: 0.65,
        dedupeKey: `stalled_onboarding:${recent.id}`,
        resource: "onboarding",
      });
    }
  }
  // High usage, low credits on an activated account (before activation the COPS-05 low_credits stall covers it).
  if (c.onboarding?.activated) {
    for (const u of c.usage ?? []) {
      if (u.granted <= 0 || u.balance > u.granted * 0.2 || u.consumed30d <= 0 || !u.lastConsumeId) continue;
      const label = `${u.consumed30d.toLocaleString("en-US")} credits used in 30 days; ${u.balance.toLocaleString("en-US")} of ${u.granted.toLocaleString("en-US")} left`;
      out.push({
        type: "credits_running_low",
        headline: "High usage, low credits",
        rationale: `The team used ${u.consumed30d.toLocaleString("en-US")} credits in the last 30 days and ${u.balance.toLocaleString("en-US")} of ${u.granted.toLocaleString("en-US")} are left. Talk about a top-up or a plan change before work stops.`,
        evidence: [{ kind: "credit_ledger", id: u.lastConsumeId, label }],
        action: { kind: "create_task", params: { title: "High usage, low credits: top-up or plan conversation", task_type: "call", priority: u.balance <= u.granted * 0.05 ? "high" : "medium", due_in_hours: 48, assign_to: "account_owner" } },
        confidence: clamp(0.6 + (1 - u.balance / u.granted) * 0.3),
        dedupeKey: `credits_running_low:${u.workspaceId}`,
        resource: "crm",
      });
    }
  }
  return out;
}
