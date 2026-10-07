import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { schema, scopedTo, scopedById, type Db } from "@skout/db";
import { appendCopsEvent, copsErrorBody, copsErrorStatus, createCopsEvent, resolveCorrelationId } from "@skout/shared";
import { getMemberPermissions } from "@skout/auth";
import { errorResponse, HttpError } from "../utils/http.js";
import { getEvidence } from "../services/evidence.service.js";
import { createRegionalBriefService } from "../services/regional-brief.service.js";
import { copsIdempotencyStore, requireAnyCopsPermission, writeCopsAudit } from "../services/cops-platform.service.js";
import { runLifecycleTransition } from "../services/cops-lifecycle.service.js";
import { withCopsIdempotentReply } from "../services/cops-idempotent.js";
import { AccountLinkError, linkAccounts } from "../services/cops-account-relationships.service.js";

/**
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION (Enterprise Completion Plan) - see
 * docs/adr/0003-read-model-exceptions.md (COPS-02 additions).
 *   - Tables touched directly: companies, contacts, deals, tasks, activities, pipeline_stages - read + write (owned by apps/crm)
 *   - Owning service: apps/crm (apps/api has direct Postgres access via the shared instance)
 *   - Reason: Customer 360 must load header and summaries in one request with an asserted query count
 *     (COPS-02 acceptance), which an HTTP fan-out into apps/crm cannot meet. Stage changes, bulk
 *     reassignment and account merge write the CRM row, the lifecycle state, the audit row and the
 *     outbox event in one transaction; splitting the CRM write into an apps/crm call would lose that
 *     atomicity.
 *   - Review date: revisit when apps/crm's internal API covers transactional writes
 */

const { companies, contacts, deals, activities, signals, copsLifecycleStates, copsTimelineEvents, tasks, workspaceMembers, copsSavedViews, pipelineStages, copsAccountMerges, accountRelationships, crmNativeLinks, copsProvisionings } = schema;

const LOW_CONFIDENCE_THRESHOLD = 0.5;

/**
 * §5.3/§8.4 — group an entity's evidence-ledger rows by attribute, keeping only the most
 * recent row per attribute (rows already arrive most-recent-first from getEvidence) so the
 * caller sees "what backs the current value" rather than the full observation history.
 */
function toFieldEvidence(rows: Awaited<ReturnType<typeof getEvidence>>) {
  const byAttribute: Record<
    string,
    {
      value: unknown;
      chosenValue: unknown;
      source: string;
      confidence: number;
      observedAt: string;
      freshnessExpiresAt: string | null;
      isStale: boolean;
      isLowConfidence: boolean;
    }
  > = {};

  for (const row of rows) {
    if (byAttribute[row.attribute]) continue; // most recent already kept
    const isStale = row.freshnessExpiresAt ? row.freshnessExpiresAt.getTime() < Date.now() : false;
    byAttribute[row.attribute] = {
      value: row.value,
      chosenValue: row.chosenValue ?? null,
      source: row.source,
      confidence: row.confidence,
      observedAt: row.observedAt.toISOString(),
      freshnessExpiresAt: row.freshnessExpiresAt ? row.freshnessExpiresAt.toISOString() : null,
      isStale,
      isLowConfidence: row.confidence < LOW_CONFIDENCE_THRESHOLD,
    };
  }
  return byAttribute;
}

/**
 * §8.4 — Account 360 / Person 360 read models (compose CRM + signals + timeline).
 */
export async function account360Routes(app: FastifyInstance) {
  app.get("/account-360/:companyId", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!app.db) return reply.code(404).send(errorResponse("Company not found", 404));

    try {
      const { companyId } = z.object({ companyId: z.string().uuid() }).parse(request.params);

      const [company] = await app.db
        .select()
        .from(companies)
        .where(scopedById(companies, request.workspaceId, companyId))
        .limit(1);
      if (!company) return reply.code(404).send(errorResponse("Company not found", 404));

      const companyContacts = await app.db
        .select()
        .from(contacts)
        .where(scopedTo(contacts, request.workspaceId, eq(contacts.companyId, companyId)))
        .limit(50);

      const companyDeals = await app.db
        .select()
        .from(deals)
        .where(scopedTo(deals, request.workspaceId, eq(deals.companyId, companyId)))
        .limit(50);

      const timeline = await app.db
        .select()
        .from(activities)
        .where(
          scopedTo(activities, request.workspaceId, eq(activities.entityType, "company"), eq(activities.entityId, companyId))
        )
        .orderBy(desc(activities.occurredAt))
        .limit(30);

      let signalRows: unknown[] = [];
      try {
        signalRows = await app.db
          .select()
          .from(signals)
          .where(eq(signals.entityId, companyId))
          .orderBy(desc(signals.detectedAt))
          .limit(20);
      } catch {
        signalRows = [];
      }

      // §5.3 — evidence-ledger rows backing this company's resolved fields (source/confidence/freshness).
      let fieldEvidence: ReturnType<typeof toFieldEvidence> = {};
      try {
        const evidenceRows = await getEvidence(app.db, {
          workspaceId: request.workspaceId,
          entityType: "company",
          entityId: companyId,
        });
        fieldEvidence = toFieldEvidence(evidenceRows);
      } catch {
        fieldEvidence = {};
      }

      // §6.2 — regional intelligence (market economics/business practice/channel policy) for
      // the account's resolved country. `company.location` is free text, so resolution is
      // best-effort: an unresolvable location (e.g. "San Francisco, CA") yields null, not an error.
      let regionalIntelligence = null;
      if (company.location) {
        try {
          const regionalBriefSvc = createRegionalBriefService(app.db, app.config);
          regionalIntelligence = await regionalBriefSvc.resolveRegionalBrief({
            countryIso: company.location,
            workspaceId: request.workspaceId,
          });
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          regionalIntelligence = null;
        }
      }

      // Buying Committee Influence Map classification
      const buyingCommittee = companyContacts.map((c) => {
        const titleLower = (c.title ?? "").toLowerCase();
        let role = "Evaluator";
        if (titleLower.includes("vp") || titleLower.includes("chief") || titleLower.includes("head") || titleLower.includes("ceo") || titleLower.includes("cxo")) {
          role = "Decision Maker";
        } else if (titleLower.includes("director") || titleLower.includes("lead") || titleLower.includes("manager")) {
          role = "Champion";
        } else if (titleLower.includes("procurement") || titleLower.includes("legal") || titleLower.includes("security")) {
          role = "Blocker / Gatekeeper";
        }
        return {
          id: c.id,
          fullName: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || "Unknown Contact",
          title: c.title ?? "Unknown Title",
          email: c.email,
          phone: c.phone,
          role,
        };
      });

      return reply.send({
        data: {
          company,
          contacts: companyContacts,
          buyingCommittee,
          deals: companyDeals,
          timeline,
          signals: signalRows,
          fieldEvidence,
          regionalIntelligence,
          view: "account_360",
        },
      });
    } catch {
      return reply.code(404).send(errorResponse("Company not found", 404));
    }
  });

  app.get("/person-360/:contactId", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    if (!app.db) return reply.code(404).send(errorResponse("Contact not found", 404));

    try {
      const { contactId } = z.object({ contactId: z.string().uuid() }).parse(request.params);

      const [contact] = await app.db
        .select()
        .from(contacts)
        .where(scopedById(contacts, request.workspaceId, contactId))
        .limit(1);
      if (!contact) return reply.code(404).send(errorResponse("Contact not found", 404));

      let company = null;
      if (contact.companyId) {
        const [c] = await app.db
          .select()
          .from(companies)
          .where(scopedById(companies, request.workspaceId, contact.companyId))
          .limit(1);
        company = c ?? null;
      }

      const timeline = await app.db
        .select()
        .from(activities)
        .where(
          scopedTo(activities, request.workspaceId, eq(activities.entityType, "contact"), eq(activities.entityId, contactId))
        )
        .orderBy(desc(activities.occurredAt))
        .limit(30);

      let signalRows: unknown[] = [];
      try {
        signalRows = await app.db
          .select()
          .from(signals)
          .where(eq(signals.entityId, contactId))
          .orderBy(desc(signals.detectedAt))
          .limit(20);
      } catch {
        signalRows = [];
      }

      // Professional Facts vs Inferred/Intent Context separation
      const professionalFacts = {
        fullName: `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "Unknown Contact",
        email: contact.email,
        phone: contact.phone,
        title: contact.title,
        companyName: company?.name,
        companyDomain: company?.domain,
      };

      const inferredContext = {
        signalsCount: signalRows.length,
        activityCount: timeline.length,
        signals: signalRows,
      };

      // §6.2 — regional intelligence for Person 360: use contact's company's location if available
      let regionalIntelligence = null;
      if (company?.location) {
        try {
          const regionalBriefSvc = createRegionalBriefService(app.db, app.config);
          regionalIntelligence = await regionalBriefSvc.resolveRegionalBrief({
            countryIso: company.location,
            workspaceId: request.workspaceId,
          });
        } catch (err) {
          if (!(err instanceof HttpError)) throw err;
          regionalIntelligence = null;
        }
      }

      return reply.send({
        data: {
          contact,
          company,
          professionalFacts,
          inferredContext,
          timeline,
          signals: signalRows,
          regionalIntelligence,
          view: "person_360",
        },
      });
    } catch {
      return reply.code(404).send(errorResponse("Contact not found", 404));
    }
  });
}

// ---- COPS-02 Customer 360 (moved here from cops-account-360.routes.ts) ----
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BLOCKS = ["header", "contacts", "timeline", "next_actions", "risks"] as const;
type Block = (typeof BLOCKS)[number];
const SUMMARY_LIMIT = 5;

/**
 * Field selection for list routes (`?fields=name,owner_id`). `id` is always returned so a client
 * can still key rows; an unknown field is a 422 with the allowed list.
 */
const LIST_FIELDS = {
  account: ["id", "name", "owner_id", "created_at", "updated_at"],
  contact: ["id", "first_name", "last_name", "email", "company_id", "created_at"],
  opportunity: ["id", "name", "company_id", "pipeline_id", "stage_id", "status", "amount", "currency", "owner_id", "updated_at"],
  task: ["id", "title", "type", "status", "priority", "due_at", "assigned_to", "account_id", "related_entity_type", "related_entity_id", "created_at"],
} as const;

export function parseListFields(raw: string | undefined, allowed: readonly string[]): string[] | null | "invalid" {
  if (!raw) return null;
  const requested = raw.split(",").map((f) => f.trim()).filter(Boolean);
  if (requested.some((f) => !allowed.includes(f))) return "invalid";
  return Array.from(new Set(["id", ...requested]));
}

function pickFields<T extends Record<string, unknown>>(rows: T[], fields: string[] | null): Array<Partial<T>> {
  if (!fields) return rows;
  return rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[f]])) as Partial<T>);
}


/** Postgres timestamp as text with microseconds, so a cursor never drops rows that share a millisecond. */
const tsText = (col: unknown) => sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

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
  // Same reach as the CRM nav: crm:read, or crm:manage (held by the Member role).
  const gate = requireAnyCopsPermission(["crm:read", "crm:manage"], (ws, user) => getMemberPermissions(db, ws, user));
  // One idempotency store for every COPS-02 write route (Idempotency-Key required; replays return the stored result).
  const idempotency = copsIdempotencyStore(db);

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
        // COPS-03: commercial state of the account's most recently updated open or won opportunity.
        // Commercial content is hidden from roles without commercial:read (e.g. Engineering, COPS-01).
        let commercialState: string | null = null;
        if (permissions.includes("commercial:read")) {
          const [row] = await db
            .select({ state: copsLifecycleStates.state })
            .from(copsLifecycleStates)
            .innerJoin(deals, eq(deals.id, copsLifecycleStates.entityId))
            .where(
              and(
                eq(copsLifecycleStates.workspaceId, workspaceId),
                eq(copsLifecycleStates.dimension, "commercial"),
                eq(deals.workspaceId, workspaceId),
                eq(deals.companyId, accountId),
                isNull(deals.deletedAt),
                inArray(deals.status, ["open", "won"])
              )
            )
            .orderBy(desc(copsLifecycleStates.updatedAt))
            .limit(1);
          commercialState = row?.state ?? null;
        }
        // COPS-04: the provisioned trial workspace (Bible p.28 provisioning fields).
        const [provisioned] = await db
          .select({
            workspaceId: copsProvisionings.provisionedWorkspaceId,
            request: copsProvisionings.request,
            trialStartsAt: copsProvisionings.trialStartsAt,
            trialEndsAt: copsProvisionings.trialEndsAt,
          })
          .from(copsProvisionings)
          .where(
            and(
              eq(copsProvisionings.workspaceId, workspaceId),
              eq(copsProvisionings.accountId, accountId),
              eq(copsProvisionings.status, "succeeded")
            )
          )
          .limit(1);
        data.header = {
          id: account.id,
          name: account.name,
          owner_id: account.ownerId,
          lifecycle: { account: life.account ?? null, health: life.health ?? null, support: life.support ?? null },
          health: life.health ?? null,
          commercial_state: commercialState,
          onboarding_pct: null,
          plan: provisioned ? ((provisioned.request as { plan?: string }).plan ?? null) : null,
          provisioning: provisioned
            ? {
                workspace_id: provisioned.workspaceId,
                trial_starts_at: provisioned.trialStartsAt?.toISOString() ?? null,
                trial_ends_at: provisioned.trialEndsAt?.toISOString() ?? null,
              }
            : null,
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

  // POST /accounts/:id/relationships — link this account to another account in the same workspace.
  const writeGate = requireAnyCopsPermission(["crm:write", "crm:manage"], (ws, user) => getMemberPermissions(db, ws, user));
  app.post<{ Params: { id: string }; Body: { child_account_id?: string; relationship?: string } }>(
    "/accounts/:id/relationships",
    { preHandler: writeGate },
    withCopsIdempotentReply<{ Params: { id: string }; Body: { child_account_id?: string; relationship?: string } }>(idempotency, async (request, reply) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      const fail = (path: string, message: string) =>
        reply.status(copsErrorStatus("VALIDATION_FAILED")).send(
          copsErrorBody({ code: "VALIDATION_FAILED", message, requestId, details: { fields: [{ path, code: "invalid", message }] } })
        );

      if (!UUID.test(request.params.id)) return fail("id", "Invalid account id");
      const childId = request.body?.child_account_id ?? "";
      const relationship = (request.body?.relationship ?? "").trim();
      if (!UUID.test(childId)) return fail("child_account_id", "Invalid child account id");
      if (relationship.length < 1 || relationship.length > 60) return fail("relationship", "relationship must be 1-60 characters");

      try {
        const id = await db.transaction(async (tx) => {
          const linkId = await linkAccounts(tx as unknown as Db, {
            workspaceId: request.workspaceId!,
            parentAccountId: request.params.id,
            childAccountId: childId,
            relationship,
          });
          await writeCopsAudit(tx, {
            tenantId: request.workspaceId!,
            actor: { type: "user", id: request.userId ?? null },
            entityType: "account",
            entityId: request.params.id,
            action: "account.related",
            after: { child_account_id: childId, relationship },
            correlationId: requestId,
            sourceChannel: "api",
          });
          return linkId;
        });
        return reply.status(201).send({ data: { id, parent_account_id: request.params.id, child_account_id: childId, relationship } });
      } catch (err) {
        if (err instanceof AccountLinkError) {
          return fail("child_account_id", err.message);
        }
        throw err;
      }
    })
  );

  // POST /accounts/bulk-reassign — set the owner of many accounts at once. Ids outside this
  // workspace are skipped, not an error. Every change writes one audit row (reason required).
  const bulkGate = requireAnyCopsPermission(["crm:write", "crm:manage"], (ws, user) => getMemberPermissions(db, ws, user));
  // One implementation for every bulk owner change (accounts and opportunities): owner must be a
  // workspace member, reason required, other workspaces' ids skipped, updated_at bumped, one audit
  // row per changed record, Idempotency-Key required.
  type BulkGeneric = { Body: { ids?: string[]; owner_id?: string; reason?: string } };
  const bulkReassignRoute = (path: string, table: typeof companies | typeof deals, entityType: "account" | "opportunity") =>
    app.post<BulkGeneric>(
      path,
      { preHandler: bulkGate },
      withCopsIdempotentReply<BulkGeneric>(idempotency, async (request, reply) => {
        const requestId = resolveCorrelationId(request.headers["x-request-id"]);
        const fail = (field: string, message: string) =>
          reply.status(copsErrorStatus("VALIDATION_FAILED")).send(
            copsErrorBody({ code: "VALIDATION_FAILED", message, requestId, details: { fields: [{ path: field, code: "invalid", message }] } })
          );

        const ids = request.body?.ids ?? [];
        const ownerId = request.body?.owner_id ?? "";
        const reason = (request.body?.reason ?? "").trim();
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500) return fail("ids", `ids must contain 1-500 ${entityType} ids`);
        if (ids.some((id) => !UUID.test(id))) return fail("ids", "every id must be a UUID");
        if (!UUID.test(ownerId)) return fail("owner_id", "owner_id must be a UUID");
        if (reason.length < 1 || reason.length > 500) return fail("reason", "reason is required (1-500 characters)");

        const workspaceId = request.workspaceId!;
        const [member] = await db
          .select({ userId: workspaceMembers.userId })
          .from(workspaceMembers)
          .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, ownerId)))
          .limit(1);
        if (!member) return fail("owner_id", "owner must be a member of this workspace");

        const updated = await db.transaction(async (tx) => {
          const rows = await tx
            .update(table)
            // An owner change is a change to the record: bump updated_at so it is no longer stale.
            .set({ ownerId, updatedAt: new Date() })
            .where(and(eq(table.workspaceId, workspaceId), inArray(table.id, ids)))
            .returning({ id: table.id });
          for (const row of rows) {
            await writeCopsAudit(tx, {
              tenantId: workspaceId,
              actor: { type: "user", id: request.userId ?? null },
              entityType,
              entityId: row.id,
              action: "owner.reassigned",
              after: { owner_id: ownerId },
              reason,
              correlationId: requestId,
              sourceChannel: "api",
            });
          }
          return rows.map((r) => r.id);
        });

        const skipped = ids.filter((id) => !updated.includes(id));
        return { data: { updated: updated.length, updated_ids: updated, skipped_ids: skipped } };
      })
    );
  bulkReassignRoute("/accounts/bulk-reassign", companies, "account");
  bulkReassignRoute("/opportunities/bulk-reassign", deals, "opportunity");

  // GET /accounts — account list: q (name contains), owner_id, sort (name | -created_at), cursor
  // pagination, field select. `view_id` applies a saved view's filters for object "account".
  const listGate = requireAnyCopsPermission(["crm:read", "crm:manage"], (ws, user) => getMemberPermissions(db, ws, user));
  app.get<{ Querystring: { fields?: string; q?: string; owner_id?: string; sort?: string; limit?: string; cursor?: string; view_id?: string } }>(
    "/accounts",
    { preHandler: listGate },
    async (request, reply) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      const fail = (path: string, message: string) =>
        reply.status(copsErrorStatus("VALIDATION_FAILED")).send(
          copsErrorBody({ code: "VALIDATION_FAILED", message, requestId, details: { fields: [{ path, code: "invalid", message }] } })
        );

      const workspaceId = request.workspaceId!;
      const q = request.query;
      let filters: { q?: string; owner_id?: string } = { q: q.q, owner_id: q.owner_id };
      if (q.view_id) {
        if (!UUID.test(q.view_id)) return fail("view_id", "Invalid view id");
        const [view] = await db
          .select({ filters: copsSavedViews.filters, objectType: copsSavedViews.objectType })
          .from(copsSavedViews)
          .where(
            and(
              eq(copsSavedViews.id, q.view_id),
              eq(copsSavedViews.workspaceId, workspaceId),
              or(eq(copsSavedViews.ownerUserId, request.userId!), eq(copsSavedViews.shared, true))
            )
          )
          .limit(1);
        if (!view) return fail("view_id", "Saved view not found");
        if (view.objectType !== "account") return fail("view_id", "Saved view is for another object type");
        const f = view.filters as { q?: unknown; owner_id?: unknown };
        filters = {
          q: typeof filters.q === "string" ? filters.q : typeof f.q === "string" ? f.q : undefined,
          owner_id: typeof filters.owner_id === "string" ? filters.owner_id : typeof f.owner_id === "string" ? f.owner_id : undefined,
        };
      }

      const sortDesc = q.sort !== "name";
      if (q.sort && q.sort !== "name" && q.sort !== "-created_at") return fail("sort", "sort must be name or -created_at");
      const limit = Math.min(100, Math.max(1, Number.parseInt(q.limit ?? "25", 10) || 25));
      if (filters.owner_id && !UUID.test(filters.owner_id)) return fail("owner_id", "Invalid owner_id");

      const conditions = [eq(companies.workspaceId, workspaceId)];
      if (filters.q) conditions.push(sql`${companies.name} ilike ${"%" + filters.q.replace(/[%_]/g, "\$&") + "%"}`);
      if (filters.owner_id) conditions.push(eq(companies.ownerId, filters.owner_id));
      if (q.cursor) {
        let decoded: { v: string; id: string } | null = null;
        try {
          const parsed = JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8")) as { v?: unknown; id?: unknown };
          if (typeof parsed.v === "string" && typeof parsed.id === "string" && UUID.test(parsed.id)) decoded = { v: parsed.v, id: parsed.id };
        } catch {
          decoded = null;
        }
        if (!decoded) return fail("cursor", "Invalid cursor");
        const { v: value, id } = decoded;
        conditions.push(
          sortDesc
            ? or(sql`${companies.createdAt} < ${value}::timestamptz`, and(sql`${companies.createdAt} = ${value}::timestamptz`, lt(companies.id, id)))!
            : or(gt(companies.name, value), and(eq(companies.name, value), gt(companies.id, id)))!
        );
      }

      const rows = await db
        .select({ id: companies.id, name: companies.name, ownerId: companies.ownerId, createdAt: companies.createdAt, updatedAt: companies.updatedAt, createdAtText: tsText(companies.createdAt) })
        .from(companies)
        .where(and(...conditions))
        .orderBy(...(sortDesc ? [desc(companies.createdAt), desc(companies.id)] : [asc(companies.name), asc(companies.id)]))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const cursorOut = rows.length > limit && last
        ? Buffer.from(JSON.stringify({ v: sortDesc ? last.createdAtText : last.name, id: last.id }), "utf8").toString("base64url")
        : null;
      const fieldList = parseListFields(request.query.fields, LIST_FIELDS.account);
      if (fieldList === "invalid") return fail("fields", `fields must be from: ${LIST_FIELDS.account.join(", ")}`);
      return {
        data: pickFields(page.map((r) => ({ id: r.id, name: r.name, owner_id: r.ownerId, created_at: r.createdAt.toISOString(), updated_at: r.updatedAt.toISOString() })), fieldList),
        next_cursor: cursorOut,
        applied_filters: filters,
      };
    }
  );

  // GET /contacts — contact list: q (first/last name or email contains), company_id, sort
  // (name | -created_at), JSON cursor pagination. `view_id` applies a saved view for object "contact".
  app.get<{ Querystring: { fields?: string; q?: string; company_id?: string; sort?: string; limit?: string; cursor?: string; view_id?: string } }>(
    "/contacts",
    { preHandler: listGate },
    async (request, reply) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      const fail = (path: string, message: string) =>
        reply.status(copsErrorStatus("VALIDATION_FAILED")).send(
          copsErrorBody({ code: "VALIDATION_FAILED", message, requestId, details: { fields: [{ path, code: "invalid", message }] } })
        );

      const workspaceId = request.workspaceId!;
      const qs = request.query;
      let filters: { q?: string; company_id?: string } = { q: qs.q, company_id: qs.company_id };
      if (qs.view_id) {
        if (!UUID.test(qs.view_id)) return fail("view_id", "Invalid view id");
        const [view] = await db
          .select({ filters: copsSavedViews.filters, objectType: copsSavedViews.objectType })
          .from(copsSavedViews)
          .where(
            and(
              eq(copsSavedViews.id, qs.view_id),
              eq(copsSavedViews.workspaceId, workspaceId),
              or(eq(copsSavedViews.ownerUserId, request.userId!), eq(copsSavedViews.shared, true))
            )
          )
          .limit(1);
        if (!view) return fail("view_id", "Saved view not found");
        if (view.objectType !== "contact") return fail("view_id", "Saved view is for another object type");
        const f = view.filters as { q?: unknown; company_id?: unknown };
        filters = {
          q: filters.q ?? (typeof f.q === "string" ? f.q : undefined),
          company_id: filters.company_id ?? (typeof f.company_id === "string" ? f.company_id : undefined),
        };
      }

      if (qs.sort && qs.sort !== "name" && qs.sort !== "-created_at") return fail("sort", "sort must be name or -created_at");
      const sortDesc = qs.sort !== "name";
      if (filters.company_id && !UUID.test(filters.company_id)) return fail("company_id", "Invalid company_id");
      const limit = Math.min(100, Math.max(1, Number.parseInt(qs.limit ?? "25", 10) || 25));
      // Sort key for names: last name then first name, so the cursor value is one string.
      const nameKey = sql<string>`lower(coalesce(${contacts.lastName}, '') || ' ' || ${contacts.firstName})`;

      const conditions = [eq(contacts.workspaceId, workspaceId)];
      if (filters.q) {
        const pattern = "%" + filters.q.replace(/[%_]/g, "\$&") + "%";
        conditions.push(
          or(
            sql`${contacts.firstName} ilike ${pattern}`,
            sql`${contacts.lastName} ilike ${pattern}`,
            sql`${contacts.email} ilike ${pattern}`
          )!
        );
      }
      if (filters.company_id) conditions.push(eq(contacts.companyId, filters.company_id));

      if (qs.cursor) {
        let decoded: { v: string; id: string } | null = null;
        try {
          const parsed = JSON.parse(Buffer.from(qs.cursor, "base64url").toString("utf8")) as { v?: unknown; id?: unknown };
          if (typeof parsed.v === "string" && typeof parsed.id === "string" && UUID.test(parsed.id)) decoded = { v: parsed.v, id: parsed.id };
        } catch {
          decoded = null;
        }
        if (!decoded) return fail("cursor", "Invalid cursor");
        const { v: value, id } = decoded;
        conditions.push(
          sortDesc
            ? or(sql`${contacts.createdAt} < ${value}::timestamptz`, and(sql`${contacts.createdAt} = ${value}::timestamptz`, lt(contacts.id, id)))!
            : or(gt(nameKey, value), and(eq(nameKey, value), gt(contacts.id, id)))!
        );
      }

      const rows = await db
        .select({
          id: contacts.id,
          firstName: contacts.firstName,
          lastName: contacts.lastName,
          email: contacts.email,
          companyId: contacts.companyId,
          createdAt: contacts.createdAt,
          createdAtText: tsText(contacts.createdAt),
          nameKey,
        })
        .from(contacts)
        .where(and(...conditions))
        .orderBy(...(sortDesc ? [desc(contacts.createdAt), desc(contacts.id)] : [asc(nameKey), asc(contacts.id)]))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const cursorOut = rows.length > limit && last
        ? Buffer.from(JSON.stringify({ v: sortDesc ? last.createdAtText : last.nameKey, id: last.id }), "utf8").toString("base64url")
        : null;
      const fieldList = parseListFields(request.query.fields, LIST_FIELDS.contact);
      if (fieldList === "invalid") return fail("fields", `fields must be from: ${LIST_FIELDS.contact.join(", ")}`);
      return {
        data: pickFields(page.map((r) => ({
          id: r.id,
          first_name: r.firstName,
          last_name: r.lastName,
          email: r.email,
          company_id: r.companyId,
          created_at: r.createdAt.toISOString(),
        })), fieldList),
        next_cursor: cursorOut,
        applied_filters: filters,
      };
    }
  );

  // GET /opportunities — opportunity list: q (name contains), company_id, pipeline_id, stage_id,
  // status, sort (updated_at | -updated_at), JSON cursor pagination. `view_id` applies a saved view
  // for object "opportunity".
  app.get<{ Querystring: { fields?: string; owner_id?: string; q?: string; company_id?: string; pipeline_id?: string; stage_id?: string; status?: string; sort?: string; limit?: string; cursor?: string; view_id?: string } }>(
    "/opportunities",
    { preHandler: listGate },
    async (request, reply) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      const fail = (path: string, message: string) =>
        reply.status(copsErrorStatus("VALIDATION_FAILED")).send(
          copsErrorBody({ code: "VALIDATION_FAILED", message, requestId, details: { fields: [{ path, code: "invalid", message }] } })
        );

      const workspaceId = request.workspaceId!;
      const qs = request.query;
      let filters: { q?: string; company_id?: string; pipeline_id?: string; stage_id?: string; status?: string } = {
        q: qs.q, company_id: qs.company_id, pipeline_id: qs.pipeline_id, stage_id: qs.stage_id, status: qs.status,
      };
      if (qs.view_id) {
        if (!UUID.test(qs.view_id)) return fail("view_id", "Invalid view id");
        const [view] = await db
          .select({ filters: copsSavedViews.filters, objectType: copsSavedViews.objectType })
          .from(copsSavedViews)
          .where(
            and(
              eq(copsSavedViews.id, qs.view_id),
              eq(copsSavedViews.workspaceId, workspaceId),
              or(eq(copsSavedViews.ownerUserId, request.userId!), eq(copsSavedViews.shared, true))
            )
          )
          .limit(1);
        if (!view) return fail("view_id", "Saved view not found");
        if (view.objectType !== "opportunity") return fail("view_id", "Saved view is for another object type");
        const f = view.filters as Record<string, unknown>;
        const pick = (key: keyof typeof filters) => filters[key] ?? (typeof f[key] === "string" ? (f[key] as string) : undefined);
        filters = { q: pick("q"), company_id: pick("company_id"), pipeline_id: pick("pipeline_id"), stage_id: pick("stage_id"), status: pick("status") };
      }

      if (qs.sort && qs.sort !== "updated_at" && qs.sort !== "-updated_at") return fail("sort", "sort must be updated_at or -updated_at");
      const sortDesc = qs.sort !== "updated_at";
      for (const key of ["company_id", "pipeline_id", "stage_id"] as const) {
        if (filters[key] && !UUID.test(filters[key] as string)) return fail(key, `Invalid ${key}`);
      }
      const limit = Math.min(100, Math.max(1, Number.parseInt(qs.limit ?? "25", 10) || 25));

      const conditions = [eq(deals.workspaceId, workspaceId)];
      if (filters.q) conditions.push(sql`${deals.name} ilike ${"%" + filters.q.replace(/[%_]/g, "\$&") + "%"}`);
      if (filters.company_id) conditions.push(eq(deals.companyId, filters.company_id));
      if (filters.pipeline_id) conditions.push(eq(deals.pipelineId, filters.pipeline_id));
      if (filters.stage_id) conditions.push(eq(deals.stageId, filters.stage_id));
      if (filters.status) conditions.push(eq(deals.status, filters.status));
      if (qs.owner_id) {
        if (!UUID.test(qs.owner_id)) return fail("owner_id", "Invalid owner_id");
        conditions.push(eq(deals.ownerId, qs.owner_id));
      }

      if (qs.cursor) {
        let decoded: { v: string; id: string } | null = null;
        try {
          const parsed = JSON.parse(Buffer.from(qs.cursor, "base64url").toString("utf8")) as { v?: unknown; id?: unknown };
          if (typeof parsed.v === "string" && typeof parsed.id === "string" && UUID.test(parsed.id)) decoded = { v: parsed.v, id: parsed.id };
        } catch {
          decoded = null;
        }
        if (!decoded) return fail("cursor", "Invalid cursor");
        const { v: value, id } = decoded;
        conditions.push(
          sortDesc
            ? or(sql`${deals.updatedAt} < ${value}::timestamptz`, and(sql`${deals.updatedAt} = ${value}::timestamptz`, lt(deals.id, id)))!
            : or(sql`${deals.updatedAt} > ${value}::timestamptz`, and(sql`${deals.updatedAt} = ${value}::timestamptz`, gt(deals.id, id)))!
        );
      }

      const rows = await db
        .select({
          id: deals.id,
          name: deals.name,
          companyId: deals.companyId,
          pipelineId: deals.pipelineId,
          stageId: deals.stageId,
          status: deals.status,
          amount: deals.amount,
          currency: deals.currency,
          ownerId: deals.ownerId,
          updatedAt: deals.updatedAt,
          updatedAtText: tsText(deals.updatedAt),
        })
        .from(deals)
        .where(and(...conditions))
        .orderBy(...(sortDesc ? [desc(deals.updatedAt), desc(deals.id)] : [asc(deals.updatedAt), asc(deals.id)]))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const cursorOut = rows.length > limit && last
        ? Buffer.from(JSON.stringify({ v: last.updatedAtText, id: last.id }), "utf8").toString("base64url")
        : null;
      const fieldList = parseListFields(request.query.fields, LIST_FIELDS.opportunity);
      if (fieldList === "invalid") return fail("fields", `fields must be from: ${LIST_FIELDS.opportunity.join(", ")}`);
      return {
        data: pickFields(page.map((r) => ({
          id: r.id,
          name: r.name,
          company_id: r.companyId,
          pipeline_id: r.pipelineId,
          stage_id: r.stageId,
          status: r.status,
          amount: r.amount,
          currency: r.currency,
          owner_id: r.ownerId,
          updated_at: r.updatedAt.toISOString(),
        })), fieldList),
        next_cursor: cursorOut,
        applied_filters: filters,
      };
    }
  );

  // GET /tasks — task list: q (title contains), type, status, assigned_to, account_id (tasks
  // related to a company), sort (created_at | -created_at), exact-precision JSON cursor, and
  // view_id for saved views (object "task").
  app.get<{ Querystring: { fields?: string; related_type?: string; q?: string; type?: string; status?: string; assigned_to?: string; account_id?: string; sort?: string; limit?: string; cursor?: string; view_id?: string } }>(
    "/tasks",
    { preHandler: listGate },
    async (request, reply) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      const fail = (path: string, message: string) =>
        reply.status(copsErrorStatus("VALIDATION_FAILED")).send(
          copsErrorBody({ code: "VALIDATION_FAILED", message, requestId, details: { fields: [{ path, code: "invalid", message }] } })
        );

      const workspaceId = request.workspaceId!;
      const qs = request.query;
      let filters: { q?: string; type?: string; status?: string; assigned_to?: string; account_id?: string } = {
        q: qs.q, type: qs.type, status: qs.status, assigned_to: qs.assigned_to, account_id: qs.account_id,
      };
      if (qs.view_id) {
        if (!UUID.test(qs.view_id)) return fail("view_id", "Invalid view id");
        const [view] = await db
          .select({ filters: copsSavedViews.filters, objectType: copsSavedViews.objectType })
          .from(copsSavedViews)
          .where(
            and(
              eq(copsSavedViews.id, qs.view_id),
              eq(copsSavedViews.workspaceId, workspaceId),
              or(eq(copsSavedViews.ownerUserId, request.userId!), eq(copsSavedViews.shared, true))
            )
          )
          .limit(1);
        if (!view) return fail("view_id", "Saved view not found");
        if (view.objectType !== "task") return fail("view_id", "Saved view is for another object type");
        const f = view.filters as Record<string, unknown>;
        const pick = (key: keyof typeof filters) => filters[key] ?? (typeof f[key] === "string" ? (f[key] as string) : undefined);
        filters = { q: pick("q"), type: pick("type"), status: pick("status"), assigned_to: pick("assigned_to"), account_id: pick("account_id") };
      }

      if (qs.sort && qs.sort !== "created_at" && qs.sort !== "-created_at") return fail("sort", "sort must be created_at or -created_at");
      const sortDesc = qs.sort !== "created_at";
      if (filters.assigned_to && !UUID.test(filters.assigned_to)) return fail("assigned_to", "Invalid assigned_to");
      if (filters.account_id && !UUID.test(filters.account_id)) return fail("account_id", "Invalid account_id");
      const limit = Math.min(100, Math.max(1, Number.parseInt(qs.limit ?? "25", 10) || 25));

      const conditions = [eq(tasks.workspaceId, workspaceId)];
      if (filters.q) conditions.push(sql`${tasks.title} ilike ${"%" + filters.q.replace(/[%_]/g, "\$&") + "%"}`);
      if (filters.type) conditions.push(eq(tasks.type, filters.type));
      if (filters.status) conditions.push(eq(tasks.status, filters.status));
      if (filters.assigned_to) conditions.push(eq(tasks.assignedTo, filters.assigned_to));
      if (filters.account_id) {
        conditions.push(and(eq(tasks.relatedEntityType, "company"), eq(tasks.relatedEntityId, filters.account_id))!);
      }
      // related_type narrows to tasks on one kind of record, e.g. deal for the board's next actions.
      if (qs.related_type) {
        if (!["company", "contact", "deal"].includes(qs.related_type)) return fail("related_type", "related_type must be company, contact or deal");
        conditions.push(eq(tasks.relatedEntityType, qs.related_type));
      }

      if (qs.cursor) {
        let decoded: { v: string; id: string } | null = null;
        try {
          const parsed = JSON.parse(Buffer.from(qs.cursor, "base64url").toString("utf8")) as { v?: unknown; id?: unknown };
          if (typeof parsed.v === "string" && typeof parsed.id === "string" && UUID.test(parsed.id)) decoded = { v: parsed.v, id: parsed.id };
        } catch {
          decoded = null;
        }
        if (!decoded) return fail("cursor", "Invalid cursor");
        const { v: value, id } = decoded;
        conditions.push(
          sortDesc
            ? or(sql`${tasks.createdAt} < ${value}::timestamptz`, and(sql`${tasks.createdAt} = ${value}::timestamptz`, lt(tasks.id, id)))!
            : or(sql`${tasks.createdAt} > ${value}::timestamptz`, and(sql`${tasks.createdAt} = ${value}::timestamptz`, gt(tasks.id, id)))!
        );
      }

      const rows = await db
        .select({
          id: tasks.id,
          title: tasks.title,
          type: tasks.type,
          status: tasks.status,
          priority: tasks.priority,
          dueDate: tasks.dueDate,
          assignedTo: tasks.assignedTo,
          relatedEntityType: tasks.relatedEntityType,
          relatedEntityId: tasks.relatedEntityId,
          createdAt: tasks.createdAt,
          createdAtText: tsText(tasks.createdAt),
        })
        .from(tasks)
        .where(and(...conditions))
        .orderBy(...(sortDesc ? [desc(tasks.createdAt), desc(tasks.id)] : [asc(tasks.createdAt), asc(tasks.id)]))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const cursorOut = rows.length > limit && last
        ? Buffer.from(JSON.stringify({ v: last.createdAtText, id: last.id }), "utf8").toString("base64url")
        : null;
      const fieldList = parseListFields(request.query.fields, LIST_FIELDS.task);
      if (fieldList === "invalid") return fail("fields", `fields must be from: ${LIST_FIELDS.task.join(", ")}`);
      return {
        data: pickFields(page.map((r) => ({
          id: r.id,
          title: r.title,
          type: r.type,
          status: r.status,
          priority: r.priority,
          due_at: r.dueDate ? r.dueDate.toISOString() : null,
          assigned_to: r.assignedTo,
          account_id: r.relatedEntityType === "company" ? r.relatedEntityId : null,
          related_entity_type: r.relatedEntityType,
          related_entity_id: r.relatedEntityId,
          created_at: r.createdAt.toISOString(),
        })), fieldList),
        next_cursor: cursorOut,
        applied_filters: filters,
      };
    }
  );

  // POST /tasks/:id/complete — marks an open task done and emits TaskCompleted through the outbox
  // in the same transaction. A task that is already done or skipped is a 409.
  app.post<{ Params: { id: string } }>(
    "/tasks/:id/complete",
    { preHandler: writeGate },
    withCopsIdempotentReply<{ Params: { id: string } }>(idempotency, async (request, reply) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      if (!UUID.test(request.params.id)) {
        return reply.status(copsErrorStatus("VALIDATION_FAILED")).send(
          copsErrorBody({ code: "VALIDATION_FAILED", message: "Invalid task id", requestId, details: { fields: [{ path: "id", code: "invalid", message: "Invalid task id" }] } })
        );
      }
      const workspaceId = request.workspaceId!;
      const [task] = await db
        .select({ id: tasks.id, title: tasks.title, type: tasks.type, status: tasks.status, relatedEntityType: tasks.relatedEntityType, relatedEntityId: tasks.relatedEntityId })
        .from(tasks)
        .where(and(eq(tasks.id, request.params.id), eq(tasks.workspaceId, workspaceId)))
        .limit(1);
      if (!task) {
        return reply.status(404).send(copsErrorBody({ code: "NOT_FOUND", message: "Task not found", requestId, details: {} }));
      }
      if (task.status !== "open") {
        return reply.status(copsErrorStatus("BUSINESS_STATE_CONFLICT")).send(
          copsErrorBody({
            code: "BUSINESS_STATE_CONFLICT",
            message: `Task is already ${task.status}`,
            requestId,
            details: { current_state: { status: task.status }, requested_state: "done" },
          })
        );
      }

      const accountId = task.relatedEntityType === "company" ? task.relatedEntityId : null;
      const completedAt = new Date();
      const updated = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(tasks)
          .set({ status: "done", completedAt })
          .where(and(eq(tasks.id, task.id), eq(tasks.status, "open")))
          .returning({ id: tasks.id, status: tasks.status, completedAt: tasks.completedAt });
        if (!row) return null;
        await appendCopsEvent(
          tx,
          createCopsEvent({
            eventType: "TaskCompleted",
            tenantId: workspaceId,
            aggregateType: "task",
            aggregateId: task.id,
            actor: { type: "user", id: request.userId ?? null },
            correlationId: requestId,
            payload: { task_id: task.id, account_id: accountId, task_type: task.type },
          })
        );
        await writeCopsAudit(tx, {
          tenantId: workspaceId,
          actor: { type: "user", id: request.userId ?? null },
          entityType: "task",
          entityId: task.id,
          action: "task.completed",
          before: { status: "open" },
          after: { status: "done" },
          correlationId: requestId,
          sourceChannel: "api",
        });
        return row;
      });
      if (!updated) {
        // Lost a race with another completion between the read and the write.
        return reply.status(copsErrorStatus("BUSINESS_STATE_CONFLICT")).send(
          copsErrorBody({ code: "BUSINESS_STATE_CONFLICT", message: "Task was completed by someone else", requestId, details: {} })
        );
      }
      return {
        data: { id: updated.id, status: updated.status, completed_at: updated.completedAt?.toISOString() ?? null },
      };
    })
  );

  // POST /opportunities/:id/stage — moves the deal to a stage of its own pipeline. The stage maps to
  // a COPS opportunity lifecycle state, and the change goes through the same transition service as
  // POST /cops/lifecycle, so an illegal move is 409 with the allowed transitions.
  app.post<{ Params: { id: string }; Body: { stage_id?: string; reason?: string; source?: string } }>(
    "/opportunities/:id/stage",
    { preHandler: writeGate },
    withCopsIdempotentReply<{ Params: { id: string }; Body: { stage_id?: string; reason?: string; source?: string } }>(idempotency, async (request, reply) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      const fail = (path: string, message: string) =>
        reply.status(copsErrorStatus("VALIDATION_FAILED")).send(
          copsErrorBody({ code: "VALIDATION_FAILED", message, requestId, details: { fields: [{ path, code: "invalid", message }] } })
        );

      if (!UUID.test(request.params.id)) return fail("id", "Invalid opportunity id");
      const stageId = request.body?.stage_id ?? "";
      const reason = (request.body?.reason ?? "").trim();
      const source = (request.body?.source ?? "api").trim() || "api";
      if (!UUID.test(stageId)) return fail("stage_id", "stage_id must be a UUID");
      if (reason.length < 1 || reason.length > 500) return fail("reason", "reason is required (1-500 characters)");

      const workspaceId = request.workspaceId!;
      try {
        const result = await db.transaction(async (tx) => {
          const [deal] = await tx
            .select({ id: deals.id, pipelineId: deals.pipelineId, stageId: deals.stageId })
            .from(deals)
            .where(and(eq(deals.id, request.params.id), eq(deals.workspaceId, workspaceId)))
            .limit(1);
          if (!deal) return { kind: "not_found" as const };

          const [stage] = await tx
            .select({ id: pipelineStages.id, name: pipelineStages.name, isClosedWon: pipelineStages.isClosedWon, isClosedLost: pipelineStages.isClosedLost, lifecycleState: pipelineStages.lifecycleState })
            .from(pipelineStages)
            .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, deal.pipelineId ?? "")))
            .limit(1);
          if (!stage) return { kind: "bad_stage" as const };

          const state = stageToLifecycleState(stage);
          if (!state) return { kind: "unmapped" as const, name: stage.name };

          // Several stages can share one lifecycle state (e.g. New and Qualified). Moving between them
          // changes the stage only; the lifecycle transition runs when the state actually changes.
          const [current] = await tx
            .select({ state: copsLifecycleStates.state })
            .from(copsLifecycleStates)
            .where(and(eq(copsLifecycleStates.workspaceId, workspaceId), eq(copsLifecycleStates.dimension, "opportunity"), eq(copsLifecycleStates.entityId, deal.id)))
            .limit(1);
          const currentState = current?.state ?? "qualified";
          if (state !== currentState) {
            await runLifecycleTransition(tx as unknown as Db, {
              workspaceId,
              dimension: "opportunity",
              entityId: deal.id,
              to: state,
              actorId: request.userId!,
              source,
              reason,
              requestId,
              occurredAt: new Date(),
            });
          }
          // Keep the deal status in step with the lifecycle: reports, the won filter and the open
          // pipeline summary read deals.status, which a stage move alone used to leave as "open".
          const status = state === "won" ? "won" : state === "lost" ? "lost" : "open";
          await tx.update(deals).set({ stageId: stage.id, status, updatedAt: new Date() }).where(eq(deals.id, deal.id));
          await writeCopsAudit(tx, {
            tenantId: workspaceId,
            actor: { type: "user", id: request.userId ?? null },
            entityType: "opportunity",
            entityId: deal.id,
            action: "stage.changed",
            before: { stage_id: deal.stageId, state: currentState },
            after: { stage_id: stage.id, state },
            reason,
            correlationId: requestId,
            sourceChannel: source === "web" ? "web" : "api",
          });
          return { kind: "ok" as const, state, stageId: stage.id };
        });

        if (result.kind === "not_found") {
          return reply.status(404).send(copsErrorBody({ code: "NOT_FOUND", message: "Opportunity not found", requestId, details: {} }));
        }
        if (result.kind === "bad_stage") return fail("stage_id", "Stage does not belong to this opportunity's pipeline");
        if (result.kind === "unmapped") return fail("stage_id", `Stage "${result.name}" has no lifecycle mapping`);
        return { data: { opportunity_id: request.params.id, stage_id: result.stageId, state: result.state } };
      } catch (err) {
        if (err instanceof Error && err.name === "CopsIllegalTransitionError") {
          const t = err as Error & { dimension: string; from: string; to: string; allowed: string[] };
          return reply.status(copsErrorStatus("BUSINESS_STATE_CONFLICT")).send(
            copsErrorBody({
              code: "BUSINESS_STATE_CONFLICT",
              message: t.message,
              requestId,
              details: { dimension: t.dimension, current_state: { state: t.from }, requested_state: t.to, allowed_transitions: t.allowed },
            })
          );
        }
        throw err;
      }
    })
  );

  // POST /accounts/merge: merge a duplicate account into a survivor. Without confirm it returns the
  // conflicts and changes nothing. With confirm, the survivor keeps its values, fills its empty fields
  // from the duplicate, moves every reference to the survivor, records the merge, and removes the
  // duplicate. Needs crm:admin.
  const mergeGate = requireAnyCopsPermission(["crm:admin"], (ws, user) => getMemberPermissions(db, ws, user));
  app.post<{ Body: { survivor_id?: string; duplicate_id?: string; reason?: string; confirm?: boolean } }>(
    "/accounts/merge",
    { preHandler: mergeGate },
    withCopsIdempotentReply<{ Body: { survivor_id?: string; duplicate_id?: string; reason?: string; confirm?: boolean } }>(idempotency, async (request, reply) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      const fail = (path: string, message: string) =>
        reply.status(copsErrorStatus("VALIDATION_FAILED")).send(
          copsErrorBody({ code: "VALIDATION_FAILED", message, requestId, details: { fields: [{ path, code: "invalid", message }] } })
        );

      const survivorId = request.body?.survivor_id ?? "";
      const duplicateId = request.body?.duplicate_id ?? "";
      const reason = (request.body?.reason ?? "").trim();
      if (!UUID.test(survivorId)) return fail("survivor_id", "survivor_id must be a UUID");
      if (!UUID.test(duplicateId)) return fail("duplicate_id", "duplicate_id must be a UUID");
      if (survivorId === duplicateId) return fail("duplicate_id", "An account cannot be merged into itself");
      if (reason.length < 8 || reason.length > 500) return fail("reason", "reason is required (8-500 characters)");

      const workspaceId = request.workspaceId!;
      const found = await db
        .select({ id: companies.id, name: companies.name, domain: companies.domain, ownerId: companies.ownerId })
        .from(companies)
        .where(and(eq(companies.workspaceId, workspaceId), inArray(companies.id, [survivorId, duplicateId])));
      const survivor = found.find((c) => c.id === survivorId);
      const duplicate = found.find((c) => c.id === duplicateId);
      if (!survivor) return fail("survivor_id", "Survivor account not found in this workspace");
      if (!duplicate) return fail("duplicate_id", "Duplicate account not found in this workspace");

      const conflicts: Array<{ field: string; survivor_value: unknown; duplicate_value: unknown }> = [];
      for (const field of ["name", "domain", "ownerId"] as const) {
        const a = survivor[field];
        const b = duplicate[field];
        if (a != null && b != null && a !== b) {
          conflicts.push({ field: field === "ownerId" ? "owner_id" : field, survivor_value: a, duplicate_value: b });
        }
      }
      if (conflicts.length > 0 && request.body?.confirm !== true) {
        return { data: { status: "review_required", conflicts } };
      }

      try {
        await db.transaction(async (tx) => {
          // External refs are unique per (connection, entity). Where both accounts are linked on the
          // same connection, the survivor's link stays and the duplicate's external id is kept in the
          // merge history, so no external reference is lost.
          const survivorLinks = await tx
            .select({ connectionId: crmNativeLinks.connectionId, externalId: crmNativeLinks.externalId })
            .from(crmNativeLinks)
            .where(and(eq(crmNativeLinks.workspaceId, workspaceId), eq(crmNativeLinks.entityType, "company"), eq(crmNativeLinks.entityId, survivorId)));
          const duplicateLinks = await tx
            .select({ id: crmNativeLinks.id, connectionId: crmNativeLinks.connectionId, externalId: crmNativeLinks.externalId })
            .from(crmNativeLinks)
            .where(and(eq(crmNativeLinks.workspaceId, workspaceId), eq(crmNativeLinks.entityType, "company"), eq(crmNativeLinks.entityId, duplicateId)));
          const collidingDuplicateLinks = duplicateLinks.filter((d) => survivorLinks.some((s) => s.connectionId === d.connectionId));
          for (const d of collidingDuplicateLinks) {
            const kept = survivorLinks.find((s) => s.connectionId === d.connectionId)!;
            conflicts.push({ field: `external_ref:${d.connectionId}`, survivor_value: kept.externalId, duplicate_value: d.externalId });
          }

          await tx.insert(copsAccountMerges).values({
            workspaceId,
            survivorId,
            duplicateId,
            duplicateName: duplicate.name,
            reason,
            conflicts,
            mergedBy: request.userId ?? null,
          });
          await writeCopsAudit(tx, {
            tenantId: workspaceId,
            actor: { type: "user", id: request.userId ?? null },
            entityType: "account",
            entityId: survivorId,
            action: "account.merged",
            before: { duplicate_id: duplicateId, duplicate_name: duplicate.name },
            after: { survivor_id: survivorId, conflicts },
            reason,
            override: conflicts.length > 0,
            correlationId: requestId,
            sourceChannel: "api",
          });
          for (const d of collidingDuplicateLinks) {
            await tx.delete(crmNativeLinks).where(eq(crmNativeLinks.id, d.id));
          }
          await tx.update(contacts).set({ companyId: survivorId }).where(and(eq(contacts.workspaceId, workspaceId), eq(contacts.companyId, duplicateId)));
          await tx.update(deals).set({ companyId: survivorId }).where(and(eq(deals.workspaceId, workspaceId), eq(deals.companyId, duplicateId)));
          await tx
            .update(tasks)
            .set({ relatedEntityId: survivorId })
            .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.relatedEntityType, "company"), eq(tasks.relatedEntityId, duplicateId)));
          await tx.update(copsTimelineEvents).set({ accountId: survivorId }).where(and(eq(copsTimelineEvents.workspaceId, workspaceId), eq(copsTimelineEvents.accountId, duplicateId)));
          await tx.update(crmNativeLinks).set({ entityId: survivorId }).where(and(eq(crmNativeLinks.workspaceId, workspaceId), eq(crmNativeLinks.entityType, "company"), eq(crmNativeLinks.entityId, duplicateId)));
          await tx.update(accountRelationships).set({ parentAccountId: survivorId }).where(and(eq(accountRelationships.workspaceId, workspaceId), eq(accountRelationships.parentAccountId, duplicateId)));
          await tx.update(accountRelationships).set({ childAccountId: survivorId }).where(and(eq(accountRelationships.workspaceId, workspaceId), eq(accountRelationships.childAccountId, duplicateId)));
          // A relationship that now points an account at itself carries no meaning; drop it.
          await tx.delete(accountRelationships).where(and(eq(accountRelationships.workspaceId, workspaceId), sql`${accountRelationships.parentAccountId} = ${accountRelationships.childAccountId}`));
          await tx
            .update(companies)
            .set({
              domain: sql`coalesce(${companies.domain}, ${duplicate.domain})`,
              ownerId: sql`coalesce(${companies.ownerId}, ${duplicate.ownerId})`,
            })
            .where(eq(companies.id, survivorId));
          await tx.delete(companies).where(and(eq(companies.id, duplicateId), eq(companies.workspaceId, workspaceId)));
        });
      } catch (err) {
        if (err instanceof Error && /cops_account_merges_duplicate_unique|duplicate key/.test(err.message)) {
          return reply.status(copsErrorStatus("BUSINESS_STATE_CONFLICT")).send(
            copsErrorBody({ code: "BUSINESS_STATE_CONFLICT", message: "This account has already been merged", requestId, details: {} })
          );
        }
        throw err;
      }
      return { data: { status: "merged", survivor_id: survivorId, duplicate_id: duplicateId, conflicts_resolved_to_survivor: conflicts } };
    })
  );
}

/**
 * Pipeline stage -> COPS opportunity lifecycle state. Closed flags win over names. Names are the
 * default pipeline (Qualified -> Discovery -> Demo -> Commercial -> Contracting -> Payment/Procurement
 * -> Closed); a custom stage with no mapping returns null and the move is refused (422).
 */
export function stageToLifecycleState(stage: {
  name: string;
  isClosedWon: boolean;
  isClosedLost: boolean;
  lifecycleState?: string | null;
}): string | null {
  // Configured on the stage (pipeline_stages.lifecycle_state) wins over everything else.
  if (stage.lifecycleState && OPPORTUNITY_STATES.includes(stage.lifecycleState)) return stage.lifecycleState;
  if (stage.isClosedWon) return "won";
  if (stage.isClosedLost) return "lost";
  const key = stage.name.trim().toLowerCase();
  // Bible default pipeline, plus the existing Skout default (New, Qualified, Proposal, Negotiation).
  // The existing pipeline has no Demo stage, so Proposal stands in for it; otherwise commercial could
  // never be reached (the transition table requires qualified -> demo -> commercial).
  if (["new", "qualified", "discovery"].includes(key)) return "qualified";
  if (["demo", "proposal"].includes(key)) return "demo";
  if (["commercial", "negotiation", "contracting", "payment", "payment/procurement"].includes(key)) return "commercial";
  return null;
}

const OPPORTUNITY_STATES = ["qualified", "demo", "commercial", "won", "lost"];
