import { desc, eq, max } from "drizzle-orm";
import { createLogger } from "@skout/observability";
import type { Db } from "@skout/db";
import { schema, scopedTo, scopedById } from "@skout/db";
import type { Env } from "../config/env.js";
import { computeCroRollup, type CroRollup } from "./cro-summary.service.js";
import { sendMail } from "./mail.service.js";
import { computeNextSendAt } from "./report-cadence.js";
import { getReportSchedule, type ReportScheduleRecord } from "./report-schedule.service.js";

const { reportSchedules, reportSnapshots } = schema;
const log = createLogger("report-delivery.service");

export interface ReportSnapshotRecord {
  id: string;
  scheduleId: string | null;
  workspaceId: string;
  version: number;
  rollup: CroRollup;
  generatedAt: string;
}

function serialize(row: typeof reportSnapshots.$inferSelect): ReportSnapshotRecord {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    workspaceId: row.workspaceId,
    version: row.version,
    rollup: row.rollup as CroRollup,
    generatedAt: row.generatedAt.toISOString(),
  };
}

/**
 * Captures the live CroRollup as a versioned snapshot — `scheduleId` null means an
 * on-demand snapshot (e.g. for a manual board-pack export), not tied to any delivery.
 * Version numbers increase per schedule so the history is a real, orderable sequence.
 */
export async function createReportSnapshot(
  db: Db,
  config: Env,
  workspaceId: string,
  scheduleId: string | null = null
): Promise<ReportSnapshotRecord> {
  const rollup = await computeCroRollup(db, config, workspaceId);

  let version = 1;
  if (scheduleId) {
    const [row] = await db
      .select({ maxVersion: max(reportSnapshots.version) })
      .from(reportSnapshots)
      .where(eq(reportSnapshots.scheduleId, scheduleId));
    version = (row?.maxVersion ?? 0) + 1;
  }

  const [row] = await db
    .insert(reportSnapshots)
    .values({ scheduleId, workspaceId, version, rollup })
    .returning();
  return serialize(row!);
}

export async function listReportSnapshots(
  db: Db,
  workspaceId: string,
  scheduleId: string
): Promise<ReportSnapshotRecord[]> {
  const rows = await db
    .select()
    .from(reportSnapshots)
    .where(scopedTo(reportSnapshots, workspaceId, eq(reportSnapshots.scheduleId, scheduleId)))
    .orderBy(desc(reportSnapshots.version));
  return rows.map(serialize);
}

export async function getReportSnapshot(
  db: Db,
  workspaceId: string,
  id: string
): Promise<ReportSnapshotRecord | null> {
  const [row] = await db
    .select()
    .from(reportSnapshots)
    .where(scopedById(reportSnapshots, workspaceId, id));
  return row ? serialize(row) : null;
}

function formatRollupEmail(schedule: ReportScheduleRecord, rollup: CroRollup): { text: string; html: string } {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const lines = [
    `TAM coverage: ${rollup.tamCoverage.activated} activated / ${rollup.tamCoverage.total} total`,
    `Activation rate: ${pct(rollup.activationRate)} · Response rate: ${pct(rollup.responseRate)}`,
    `Open pipeline: ${rollup.pipelineValue.toLocaleString()} ${rollup.currency} across ${rollup.openDeals} deals`,
    `Top at-risk accounts: ${rollup.topAtRiskAccounts.length}`,
  ];
  const html = `<p><strong>${schedule.name}</strong></p><ul>${lines.map((l) => `<li>${l}</li>`).join("")}</ul>`;
  return { text: lines.join("\n"), html };
}

/** Runs one schedule: snapshot the current rollup, email it to every recipient, advance the clock. */
export async function deliverReportSchedule(
  db: Db,
  config: Env,
  workspaceId: string,
  scheduleId: string
): Promise<{ snapshot: ReportSnapshotRecord; emailed: number; skipped: number }> {
  const schedule = await getReportSchedule(db, workspaceId, scheduleId);
  if (!schedule) throw new Error(`report schedule not found: ${scheduleId}`);

  const snapshot = await createReportSnapshot(db, config, workspaceId, scheduleId);
  const { text, html } = formatRollupEmail(schedule, snapshot.rollup);

  let emailed = 0;
  let skipped = 0;
  for (const to of schedule.recipientEmails) {
    try {
      const result = await sendMail(config, {
        to,
        subject: `${schedule.name} — v${snapshot.version}`,
        text,
        html,
      });
      if (result.sent) emailed += 1;
      else skipped += 1;
    } catch (err) {
      log.error("Failed to send scheduled report", err, { workspaceId, scheduleId, to });
      skipped += 1;
    }
  }

  const now = new Date();
  await db
    .update(reportSchedules)
    .set({ lastSentAt: now, nextSendAt: computeNextSendAt(schedule.cadence, now) })
    .where(eq(reportSchedules.id, scheduleId));

  return { snapshot, emailed, skipped };
}
