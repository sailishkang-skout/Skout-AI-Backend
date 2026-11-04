/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-11 additions).
 *   - Tables touched directly: activities - write (one row when a playbook run starts or ends)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: playbook runs appear on the account timeline (COPS-02 timeline contract).
 *   - Review date: 2026-10-20
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { appendActivityRecorded } from "@skout/shared";
import { createLogger } from "@skout/observability";
import type { AutomationGraph } from "./automation-graph.js";
import { AutomationService } from "./automation.service.js";

const { automations, automationRuns, automationVersions, activities, auditLogs } = schema;
const log = createLogger("cops-playbooks");

/**
 * COPS-11 success playbooks (Bible p.50), as ordinary workflows on the COPS-10 engine. Each
 * starts on an event, so a run happens once per event: HealthSignalDetected events are themselves
 * one per account, signal and cycle, which makes enrollment duplicate-safe per cycle.
 */
export interface PlaybookTemplate {
  key: string;
  name: string;
  description: string;
  graph: AutomationGraph;
}

function signalPlaybook(signal: string, task: Record<string, unknown>): AutomationGraph {
  // Starts only on this signal (payloadEquals), so an enrollment always means the playbook applied.
  return {
    nodes: [
      { id: "trigger", type: "trigger", config: { kind: "event", eventType: "HealthSignalDetected", payloadEquals: { signal } } },
      { id: "task", type: "action_create_task", config: task },
    ],
    edges: [{ id: "e1", source: "trigger", target: "task" }],
  };
}

export const PLAYBOOK_TEMPLATES: PlaybookTemplate[] = [
  {
    key: "cs_newly_activated",
    name: "Playbook: newly activated",
    description: "Value confirmation and an adoption plan when an account activates.",
    graph: {
      nodes: [
        { id: "trigger", type: "trigger", config: { kind: "event", eventType: "CustomerActivated" } },
        { id: "task", type: "action_create_task", config: { title: "Confirm value and agree an adoption plan", type: "meeting", priority: "medium", dueInHours: 72, assignTo: "csm" } },
      ],
      edges: [{ id: "e1", source: "trigger", target: "task" }],
    },
  },
  {
    key: "cs_low_adoption",
    name: "Playbook: low adoption",
    description: "Use-case review and education when adoption stays low after activation.",
    graph: signalPlaybook("low_adoption", { title: "Low adoption: review the use case and plan education", type: "meeting", priority: "high", dueInHours: 48, assignTo: "csm", includeEvidence: true }),
  },
  {
    key: "cs_ticket_heavy",
    name: "Playbook: ticket-heavy account",
    description: "Technical success review when tickets pile up.",
    graph: signalPlaybook("ticket_heavy", { title: "Ticket-heavy account: run a technical success review", type: "review", priority: "high", dueInHours: 48, assignTo: "csm", includeEvidence: true }),
  },
  {
    key: "cs_renewal_approaching",
    name: "Playbook: renewal approaching",
    description: "Outcomes review, stakeholders and commercial prep ahead of the renewal.",
    graph: signalPlaybook("renewal_approaching", { title: "Renewal approaching: outcomes review, stakeholders, commercial prep", type: "renewal_action", priority: "high", dueInHours: 120, assignTo: "csm", includeEvidence: true }),
  },
  {
    key: "cs_expansion_signal",
    name: "Playbook: expansion signal",
    description: "Routes an expansion signal to the account's sales owner, with the evidence.",
    graph: signalPlaybook("expansion_signal", { title: "Expansion signal", type: "call", priority: "medium", dueInHours: 72, assignTo: "account_owner", includeEvidence: true }),
  },
];

/**
 * Seeds the success playbooks a workspace does not have yet, each published as v1 and active.
 * Running it again changes nothing. Audited.
 */
export async function installSuccessPlaybooks(db: Db, workspaceId: string, actorId: string | null) {
  const existing = new Set(
    (await db.select({ key: automations.templateKey }).from(automations).where(and(eq(automations.workspaceId, workspaceId), isNotNull(automations.templateKey)))).map((r) => r.key)
  );
  const svc = new AutomationService(db);
  const installed: string[] = [];
  for (const t of PLAYBOOK_TEMPLATES) {
    if (existing.has(t.key)) continue;
    const auto = await svc.createAutomation(workspaceId, { name: t.name, description: t.description, createdBy: actorId ?? undefined });
    await db.update(automations).set({ templateKey: t.key }).where(eq(automations.id, auto.id));
    await svc.publishVersion(workspaceId, auto.id, t.graph, actorId ?? undefined);
    installed.push(t.key);
  }
  if (installed.length) {
    await db.insert(auditLogs).values({
      workspaceId,
      actorType: actorId ? "user" : "system",
      actorId,
      action: "cs_playbooks.installed",
      entityType: "workspace",
      entityId: workspaceId,
      afterState: { installed },
      reason: `Success playbooks installed: ${installed.join(", ")}`,
    });
  }
  return { installed, total: PLAYBOOK_TEMPLATES.length };
}

/** Playbook enrollments (runs of template workflows), newest first; optionally for one account. */
export async function listPlaybookEnrollments(db: Db, workspaceId: string, opts: { accountId?: string; limit?: number } = {}) {
  return db
    .select({
      runId: automationRuns.id,
      automationId: automations.id,
      playbook: automations.name,
      templateKey: automations.templateKey,
      version: automationVersions.version,
      status: automationRuns.status,
      accountId: automationRuns.subjectId,
      trigger: automationRuns.triggerRef,
      signal: automationRuns.triggerPayload,
      createdAt: automationRuns.createdAt,
      finishedAt: automationRuns.finishedAt,
    })
    .from(automationRuns)
    .innerJoin(automations, eq(automationRuns.automationId, automations.id))
    .innerJoin(automationVersions, eq(automationRuns.automationVersionId, automationVersions.id))
    .where(
      and(
        eq(automationRuns.workspaceId, workspaceId),
        isNotNull(automations.templateKey),
        eq(automationRuns.isSimulation, false),
        opts.accountId ? eq(automationRuns.subjectId, opts.accountId) : undefined
      )
    )
    .orderBy(desc(automationRuns.createdAt))
    .limit(Math.min(opts.limit ?? 50, 200));
}

/**
 * Puts a playbook run on the account timeline: an activity with its ActivityRecorded event, as
 * the COPS-02 timeline contract asks. Only runs of template workflows about an account; best
 * effort, a timeline failure never stops the run.
 */
export async function recordPlaybookTimeline(db: Db, runId: string, kind: "started" | "completed" | "cancelled") {
  try {
    const [run] = await db
      .select({ workspaceId: automationRuns.workspaceId, subjectType: automationRuns.subjectType, subjectId: automationRuns.subjectId, isSimulation: automationRuns.isSimulation, name: automations.name, templateKey: automations.templateKey })
      .from(automationRuns)
      .innerJoin(automations, eq(automationRuns.automationId, automations.id))
      .where(eq(automationRuns.id, runId))
      .limit(1);
    if (!run || !run.templateKey || run.isSimulation || run.subjectType !== "account" || !run.subjectId) return;
    const subject = `${run.name} ${kind}`;
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(activities)
        .values({ workspaceId: run.workspaceId, entityType: "company", entityId: run.subjectId!, activityType: "workflow", subject, body: `Workflow run ${runId}` })
        .returning({ id: activities.id });
      await appendActivityRecorded(tx as never, {
        workspaceId: run.workspaceId,
        activityId: row!.id,
        activityType: "workflow",
        entityType: "company",
        entityId: run.subjectId!,
        subject,
      });
    });
  } catch (err) {
    log.warn("playbook timeline entry failed", { err, runId });
  }
}
