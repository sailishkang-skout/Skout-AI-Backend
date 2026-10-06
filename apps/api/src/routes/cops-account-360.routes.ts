import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "@skout/db";
import { copsErrorBody, copsErrorStatus, resolveCorrelationId } from "@skout/shared";
import { getMemberPermissions } from "@skout/auth";
import { requireCopsPermission } from "../services/cops-platform.service.js";

const { companies, contacts, copsLifecycleStates, copsTimelineEvents, tasks } = schema;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BLOCKS = ["header", "contacts", "timeline", "next_actions", "risks"] as const;
type Block = (typeof BLOCKS)[number];
const SUMMARY_LIMIT = 5;

export function parseFields(raw: string | undefined): Block[] | "invalid" {
  if (!raw) return [...BLOCKS];
  const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (requested.some((f) => !(BLOCKS as readonly string[]).includes(f))) return "invalid";
  return requested as Block[];
}

/**
 * GET /api/v1/accounts/:id/360 — crm:read. Header plus summary blocks, selectable with `fields`.
 * Fixed query count regardless of how many contacts, tasks, or timeline rows exist (no N+1):
 * account, lifecycle states (one IN query), then one query per requested block.
 */
export async function copsAccount360Routes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const gate = requireCopsPermission("crm", "read", (ws, user) => getMemberPermissions(db, ws, user));

  app.get<{ Params: { id: string }; Querystring: { fields?: string } }>(
    "/accounts/:id/360",
    { preHandler: gate },
    async (request, reply) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      const invalid = (message: string, path: string) =>
        reply.status(copsErrorStatus("VALIDATION_FAILED")).send(
          copsErrorBody({ code: "VALIDATION_FAILED", message, requestId, details: { fields: [{ path, code: "invalid", message }] } })
        );

      if (!UUID.test(request.params.id)) return invalid("Invalid account id", "id");
      const blocks = parseFields(request.query.fields);
      if (blocks === "invalid") return invalid("Unknown field in fields", "fields");

      const workspaceId = request.workspaceId!;
      const accountId = request.params.id;

      const [account] = await db
        .select({ id: companies.id, name: companies.name, ownerId: companies.ownerId })
        .from(companies)
        .where(and(eq(companies.id, accountId), eq(companies.workspaceId, workspaceId)))
        .limit(1);
      if (!account) {
        return reply.status(404).send(copsErrorBody({ code: "NOT_FOUND", message: "Account not found", requestId, details: {} }));
      }

      const permissions = await getMemberPermissions(db, workspaceId, request.userId!);
      const canSeeInternal = permissions.includes("crm:admin");

      const want = new Set(blocks);
      const lifecycleRows = await db
        .select({ dimension: copsLifecycleStates.dimension, state: copsLifecycleStates.state })
        .from(copsLifecycleStates)
        .where(
          and(
            eq(copsLifecycleStates.workspaceId, workspaceId),
            eq(copsLifecycleStates.entityId, accountId),
            inArray(copsLifecycleStates.dimension, ["account", "health", "support"])
          )
        );
      const life = Object.fromEntries(lifecycleRows.map((r) => [r.dimension, r.state]));

      const data: Record<string, unknown> = {};

      if (want.has("header")) {
        data.header = {
          id: account.id,
          name: account.name,
          owner_id: account.ownerId,
          lifecycle: { account: life.account ?? null, health: life.health ?? null, support: life.support ?? null },
          health: life.health ?? null,
          commercial_state: null,
          onboarding_pct: null,
          plan: null,
          renewal_at: null,
        };
      }

      if (want.has("contacts")) {
        const rows = await db
          .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email })
          .from(contacts)
          .where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.companyId, accountId)))
          .limit(SUMMARY_LIMIT);
        data.contacts = rows;
      }

      if (want.has("timeline")) {
        const rows = await db
          .select({
            id: copsTimelineEvents.id,
            type: copsTimelineEvents.type,
            occurredAt: copsTimelineEvents.occurredAt,
            summary: copsTimelineEvents.summary,
            visibility: copsTimelineEvents.visibility,
          })
          .from(copsTimelineEvents)
          .where(
            and(
              eq(copsTimelineEvents.workspaceId, workspaceId),
              eq(copsTimelineEvents.accountId, accountId),
              ...(canSeeInternal ? [] : [eq(copsTimelineEvents.visibility, "public")])
            )
          )
          .orderBy(desc(copsTimelineEvents.occurredAt), desc(copsTimelineEvents.id))
          .limit(SUMMARY_LIMIT);
        data.timeline = rows.map((r) => ({ ...r, occurred_at: r.occurredAt.toISOString(), occurredAt: undefined }));
      }

      if (want.has("next_actions")) {
        const rows = await db
          .select({ id: tasks.id, title: tasks.title, type: tasks.type, dueDate: tasks.dueDate, status: tasks.status })
          .from(tasks)
          .where(
            and(
              eq(tasks.workspaceId, workspaceId),
              eq(tasks.relatedEntityType, "company"),
              eq(tasks.relatedEntityId, accountId),
              eq(tasks.status, "open")
            )
          )
          .orderBy(sql`${tasks.dueDate} asc nulls last`)
          .limit(SUMMARY_LIMIT);
        data.next_actions = rows;
      }

      if (want.has("risks")) {
        const risks: Array<{ dimension: string; state: string }> = [];
        if (life.health && life.health !== "healthy") risks.push({ dimension: "health", state: life.health });
        if (life.support && life.support !== "no_issue") risks.push({ dimension: "support", state: life.support });
        data.risks = risks;
      }

      return { data, next_cursor: null };
    }
  );
}
