import { sql } from "drizzle-orm";
import type { Db } from "@skout/db";

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-05 additions).
 *   - Tables touched directly: companies, contacts, deals, tasks, activities - read (queue rows, owner,
 *     last touch) (owned by apps/crm)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: the queue joins CRM rows with onboarding, inbox, commercial and credit data in one pass;
 *     per-row HTTP calls into apps/crm would be N+1.
 *   - Review date: revisit when apps/crm's internal API covers batched reads
 */

/**
 * COPS-05 rep queue (Bible p.64): who needs human attention today. Six sources, one row per account
 * and reason, most urgent first:
 *   due_task           an open task on the account due within a day (not a playbook task)
 *   stalled_milestone  a stalled-onboarding playbook task that is still open
 *   reply              the customer wrote in the last 7 days and nobody answered yet
 *   high_intent_usage  a trial still activating used 10+ credits in the last 24h
 *   trial_expiry       a trial that is not activated ends within 3 days
 *   commercial_blocker a failed/expired payment link or a declined/expired contract in 14 days
 * Each row carries the active follow-up, last touch, the account's signals and one recommended action.
 */
export const QUEUE_REASONS = ["due_task", "stalled_milestone", "reply", "high_intent_usage", "trial_expiry", "commercial_blocker"] as const;
export type QueueReason = (typeof QUEUE_REASONS)[number];

const PRIORITY: Record<QueueReason, number> = {
  reply: 1,
  commercial_blocker: 2,
  trial_expiry: 3,
  stalled_milestone: 4,
  due_task: 5,
  high_intent_usage: 6,
};

const RECOMMENDED: Record<QueueReason, { kind: "call" | "email" | "meeting" | "task"; label: string }> = {
  reply: { kind: "email", label: "Reply to the customer" },
  commercial_blocker: { kind: "call", label: "Call to unblock payment or contract" },
  trial_expiry: { kind: "meeting", label: "Book the trial review" },
  stalled_milestone: { kind: "call", label: "Personal outreach to unblock onboarding" },
  due_task: { kind: "task", label: "Complete the due task" },
  high_intent_usage: { kind: "call", label: "Conversion or top-up conversation" },
};

export interface QueueItem {
  id: string;
  reason: QueueReason;
  priority: number;
  account: { id: string; name: string };
  contact: { id: string; name: string; email: string | null } | null;
  active_sequence: { enrollment_id: string; current_step: number | null } | null;
  last_touch_at: string | null;
  signals: string[];
  recommended_action: { kind: "call" | "email" | "meeting" | "task"; label: string };
  due_at: string | null;
  detail: string;
}

type Raw = { id: string; reason: QueueReason; account_id: string; due_at: Date | string | null; detail: string };

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []));

export async function loadFollowUpQueue(
  db: Db,
  input: { workspaceId: string; userId: string; owner: "me" | "all"; reason?: QueueReason; cursor?: number; limit: number }
): Promise<{ data: QueueItem[]; next_cursor: number | null }> {
  const ws = input.workspaceId;
  const mine = input.owner === "me";
  const ownerAccount = mine ? sql`and co.owner_id = ${input.userId}` : sql``;

  const raw = rowsOf<Raw>(
    await db.execute(sql`
    with
    playbook_tasks as (select task_id from cops_onboarding_signals where workspace_id = ${ws} and task_id is not null),
    due_task as (
      select 'task:' || t.id as id, 'due_task' as reason, t.related_entity_id as account_id, t.due_date as due_at, t.title as detail
        from tasks t join companies co on co.id = t.related_entity_id
       where t.workspace_id = ${ws} and t.related_entity_type = 'company' and t.status = 'open' and t.deleted_at is null
         and t.due_date <= now() + interval '1 day' and t.id not in (select task_id from playbook_tasks)
         ${mine ? sql`and (t.assigned_to = ${input.userId} or (t.assigned_to is null and co.owner_id = ${input.userId}))` : sql``}
    ),
    stalled as (
      select 'signal:' || s.id as id, 'stalled_milestone' as reason, i.account_id, t.due_date as due_at, t.title as detail
        from cops_onboarding_signals s
        join cops_onboarding_instances i on i.id = s.instance_id
        join tasks t on t.id = s.task_id
        join companies co on co.id = i.account_id
       where s.workspace_id = ${ws} and t.status = 'open' and t.deleted_at is null
         ${mine ? sql`and (t.assigned_to = ${input.userId} or co.owner_id = ${input.userId})` : sql``}
    ),
    reply as (
      select distinct on (c.company_id) 'reply:' || m.id as id, 'reply' as reason, c.company_id as account_id, m.sent_at as due_at,
             coalesce(m.subject, 'Customer reply') as detail
        from inbox_messages m
        join inbox_threads th on th.id = m.thread_id
        join contacts c on c.workspace_id = th.workspace_id and lower(c.email) = lower(m.from_address)
        join companies co on co.id = c.company_id
       where th.workspace_id = ${ws} and m.direction = 'inbound' and m.sent_at > now() - interval '7 days'
         and not exists (select 1 from inbox_messages o where o.thread_id = m.thread_id and o.direction = 'outbound' and o.sent_at > m.sent_at)
         ${ownerAccount}
       order by c.company_id, m.sent_at desc
    ),
    usage as (
      select 'usage:' || i.id as id, 'high_intent_usage' as reason, i.account_id, null::timestamptz as due_at,
             'Used ' || sum(-ct.amount) || ' credits in the last 24h' as detail
        from cops_onboarding_instances i
        join credit_transactions ct on ct.workspace_id = i.customer_workspace_id and ct.kind = 'consume' and ct.created_at > now() - interval '24 hours'
        join companies co on co.id = i.account_id
       where i.workspace_id = ${ws} and i.activated_at is null ${ownerAccount}
       group by i.id, i.account_id
      having sum(-ct.amount) >= 10
    ),
    trial as (
      select 'trial:' || p.id as id, 'trial_expiry' as reason, p.account_id, p.trial_ends_at as due_at,
             'Trial ends ' || to_char(p.trial_ends_at, 'YYYY-MM-DD') as detail
        from cops_provisionings p
        join companies co on co.id = p.account_id
        left join cops_onboarding_instances i on i.workspace_id = p.workspace_id and i.account_id = p.account_id
       where p.workspace_id = ${ws} and p.status = 'succeeded' and p.trial_ends_at between now() and now() + interval '3 days'
         and i.activated_at is null ${ownerAccount}
    ),
    commercial as (
      select 'payment:' || pr.id as id, 'commercial_blocker' as reason, d.company_id as account_id, pr.status_changed_at as due_at,
             'Payment link ' || pr.status as detail
        from payment_requests pr join deals d on d.id = pr.opportunity_id join companies co on co.id = d.company_id
       where pr.workspace_id = ${ws} and pr.status in ('failed', 'expired') and coalesce(pr.status_changed_at, pr.updated_at) > now() - interval '14 days'
         ${ownerAccount}
      union all
      select 'contract:' || ct.id, 'commercial_blocker', d.company_id, ct.status_changed_at, upper(ct.kind) || ' ' || ct.status
        from contracts ct join deals d on d.id = ct.opportunity_id join companies co on co.id = d.company_id
       where ct.workspace_id = ${ws} and ct.status in ('declined', 'expired') and ct.status_changed_at > now() - interval '14 days'
         ${ownerAccount}
    )
    select * from due_task union all select * from stalled union all select * from reply
    union all select * from usage union all select * from trial union all select * from commercial`)
  ).filter((r) => r.account_id && (!input.reason || r.reason === input.reason));

  // Most urgent reason first, then the earliest due.
  raw.sort((a, b) => PRIORITY[a.reason] - PRIORITY[b.reason] || dueMs(a) - dueMs(b) || a.id.localeCompare(b.id));
  const start = input.cursor ?? 0;
  const page = raw.slice(start, start + input.limit);
  const accountIds = [...new Set(page.map((r) => r.account_id))];
  if (accountIds.length === 0) return { data: [], next_cursor: null };

  const ids = sql.join(accountIds.map((id) => sql`${id}::uuid`), sql`, `);
  const accounts = rowsOf<{ id: string; name: string; last_touch_at: Date | string | null }>(
    await db.execute(sql`
      select co.id, co.name, (select max(a.occurred_at) from activities a where a.entity_type = 'company' and a.entity_id = co.id) as last_touch_at
        from companies co where co.workspace_id = ${ws} and co.id in (${ids})`)
  );
  const contacts = rowsOf<{ account_id: string; id: string; first_name: string | null; last_name: string | null; email: string | null }>(
    await db.execute(sql`
      select distinct on (c.company_id) c.company_id as account_id, c.id, c.first_name, c.last_name, c.email
        from contacts c
        left join cops_onboarding_email_sends s on s.contact_id = c.id
       where c.workspace_id = ${ws} and c.company_id in (${ids}) and c.deleted_at is null
       order by c.company_id, (s.id is null), c.created_at`)
  );
  const sequences = rowsOf<{ account_id: string; enrollment_id: string; current_step: number | null }>(
    await db.execute(sql`
      select distinct on (f.account_id) f.account_id, e.id as enrollment_id,
             (select min(st.step_order) from sequence_enrollment_steps es join sequence_steps st on st.id = es.step_id
               where es.enrollment_id = e.id and es.status in ('scheduled', 'executing')) as current_step
        from cops_follow_ups f join sequence_enrollments e on e.id = f.enrollment_id
       where f.workspace_id = ${ws} and f.account_id in (${ids}) and e.status in ('active', 'paused')
       order by f.account_id, f.created_at desc`)
  );
  const signalsByAccount = new Map<string, Set<string>>();
  for (const r of raw) {
    if (!accountIds.includes(r.account_id)) continue;
    const set = signalsByAccount.get(r.account_id) ?? new Set<string>();
    set.add(r.reason);
    signalsByAccount.set(r.account_id, set);
  }

  const data: QueueItem[] = page.map((r) => {
    const acc = accounts.find((a) => a.id === r.account_id);
    const c = contacts.find((x) => x.account_id === r.account_id);
    const seq = sequences.find((x) => x.account_id === r.account_id);
    return {
      id: r.id,
      reason: r.reason,
      priority: PRIORITY[r.reason],
      account: { id: r.account_id, name: acc?.name ?? "Account" },
      contact: c ? { id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(" ") || (c.email ?? "Contact"), email: c.email } : null,
      active_sequence: seq ? { enrollment_id: seq.enrollment_id, current_step: seq.current_step } : null,
      last_touch_at: toIso(acc?.last_touch_at ?? null),
      signals: [...(signalsByAccount.get(r.account_id) ?? [])],
      recommended_action: RECOMMENDED[r.reason],
      due_at: toIso(r.due_at),
      detail: r.detail,
    };
  });
  return { data, next_cursor: start + input.limit < raw.length ? start + input.limit : null };
}

function toIso(v: Date | string | null): string | null {
  if (!v) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function dueMs(r: Raw): number {
  return r.due_at ? new Date(r.due_at).getTime() : Number.MAX_SAFE_INTEGER;
}
