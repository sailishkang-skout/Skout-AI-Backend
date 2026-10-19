import { eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { TICKET_SEVERITIES, type TicketSeverity } from "@skout/shared";
import { HttpError } from "../../utils/http.js";
import { createTicket } from "../cops-tickets.service.js";
import type { NodeHandler } from "./types.js";
import { withStepEffect } from "./step-effect.js";

const { automationRuns, automationVersions, automations } = schema;

/**
 * COPS-10 "create ticket" (Bible p.68), through the COPS-06 ticket service. Config:
 * { title; description?; severity?; category? }. The ticket is for the run's account and is
 * created on behalf of the admin who published the running version (or who created the workflow).
 * Runs once per step.
 */
export const createTicketActionNodeHandler: NodeHandler = async (ctx) => {
  const config = ctx.node.config as { title?: string; description?: string; severity?: string; category?: string };
  const title = config.title?.trim();
  if (!title) throw new HttpError("Create ticket needs a title", 422);
  const accountId = ctx.subject?.type === "account" ? ctx.subject.id : null;
  if (!accountId) throw new HttpError("Create ticket needs a run about an account", 422);
  const severity: TicketSeverity = (TICKET_SEVERITIES as readonly string[]).includes(config.severity ?? "") ? (config.severity as TicketSeverity) : "medium";

  if (ctx.isSimulation) return { output: { simulated: true, title, severity, accountId } };

  const output = await withStepEffect(ctx, "ticket", async (tx) => {
    const [owner] = await tx
      .select({ publishedBy: automationVersions.publishedBy, createdBy: automations.createdBy })
      .from(automationRuns)
      .innerJoin(automationVersions, eq(automationRuns.automationVersionId, automationVersions.id))
      .innerJoin(automations, eq(automationRuns.automationId, automations.id))
      .where(eq(automationRuns.id, ctx.runId))
      .limit(1);
    const userId = owner?.publishedBy ?? owner?.createdBy;
    if (!userId) throw new HttpError("Create ticket needs the workflow to have been published by a user", 422);
    const ticket = await createTicket(tx as unknown as Db, { workspaceId: ctx.workspaceId, userId, requestId: ctx.runId }, {
      account_id: accountId,
      title: title.slice(0, 300),
      description: config.description,
      severity,
      category: config.category,
    });
    return { ticketId: ticket.ticket.id, severity };
  });
  return { output };
};
