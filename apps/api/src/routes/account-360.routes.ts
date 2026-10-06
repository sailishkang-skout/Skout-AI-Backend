import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { schema, scopedTo, scopedById, type Db } from "@skout/db";
import { appendCopsEvent, copsErrorBody, copsErrorStatus, createCopsEvent, resolveCorrelationId } from "@skout/shared";
import { getMemberPermissions } from "@skout/auth";
import { errorResponse, HttpError } from "../utils/http.js";
import { getEvidence } from "../services/evidence.service.js";
import { createRegionalBriefService } from "../services/regional-brief.service.js";
import { requireAnyCopsPermission, writeCopsAudit } from "../services/cops-platform.service.js";
import { AccountLinkError, linkAccounts } from "../services/cops-account-relationships.service.js";

const { companies, contacts, deals, activities, signals, copsLifecycleStates, copsTimelineEvents, tasks, workspaceMembers, copsSavedViews } = schema;

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

  // POST /accounts/:id/relationships — link this account to another account in the same workspace.
  const writeGate = requireAnyCopsPermission(["crm:write", "crm:manage"], (ws, user) => getMemberPermissions(db, ws, user));
  app.post<{ Params: { id: string }; Body: { child_account_id?: string; relationship?: string } }>(
    "/accounts/:id/relationships",
    { preHandler: writeGate },
    async (request, reply) => {
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
        const id = await linkAccounts(db, {
          workspaceId: request.workspaceId!,
          parentAccountId: request.params.id,
          childAccountId: childId,
          relationship,
        });
        return reply.status(201).send({ data: { id, parent_account_id: request.params.id, child_account_id: childId, relationship } });
      } catch (err) {
        if (err instanceof AccountLinkError) {
          return fail("child_account_id", err.message);
        }
        throw err;
      }
    }
  );

  // POST /accounts/bulk-reassign — set the owner of many accounts at once. Ids outside this
  // workspace are skipped, not an error. Every change writes one audit row (reason required).
  const bulkGate = requireAnyCopsPermission(["crm:write", "crm:manage"], (ws, user) => getMemberPermissions(db, ws, user));
  app.post<{ Body: { ids?: string[]; owner_id?: string; reason?: string } }>(
    "/accounts/bulk-reassign",
    { preHandler: bulkGate },
    async (request, reply) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      const fail = (path: string, message: string) =>
        reply.status(copsErrorStatus("VALIDATION_FAILED")).send(
          copsErrorBody({ code: "VALIDATION_FAILED", message, requestId, details: { fields: [{ path, code: "invalid", message }] } })
        );

      const ids = request.body?.ids ?? [];
      const ownerId = request.body?.owner_id ?? "";
      const reason = (request.body?.reason ?? "").trim();
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500) return fail("ids", "ids must contain 1-500 account ids");
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
          .update(companies)
          .set({ ownerId })
          .where(and(eq(companies.workspaceId, workspaceId), inArray(companies.id, ids)))
          .returning({ id: companies.id });
        for (const row of rows) {
          await writeCopsAudit(tx, {
            tenantId: workspaceId,
            actor: { type: "user", id: request.userId ?? null },
            entityType: "account",
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
    }
  );

  // GET /accounts — account list: q (name contains), owner_id, sort (name | -created_at), cursor
  // pagination, field select. `view_id` applies a saved view's filters for object "account".
  const listGate = requireAnyCopsPermission(["crm:read", "crm:manage"], (ws, user) => getMemberPermissions(db, ws, user));
  app.get<{ Querystring: { q?: string; owner_id?: string; sort?: string; limit?: string; cursor?: string; view_id?: string } }>(
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
        .select({ id: companies.id, name: companies.name, ownerId: companies.ownerId, createdAt: companies.createdAt, createdAtText: tsText(companies.createdAt) })
        .from(companies)
        .where(and(...conditions))
        .orderBy(...(sortDesc ? [desc(companies.createdAt), desc(companies.id)] : [asc(companies.name), asc(companies.id)]))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const cursorOut = rows.length > limit && last
        ? Buffer.from(JSON.stringify({ v: sortDesc ? last.createdAtText : last.name, id: last.id }), "utf8").toString("base64url")
        : null;
      return {
        data: page.map((r) => ({ id: r.id, name: r.name, owner_id: r.ownerId, created_at: r.createdAt.toISOString() })),
        next_cursor: cursorOut,
        applied_filters: filters,
      };
    }
  );

  // GET /contacts — contact list: q (first/last name or email contains), company_id, sort
  // (name | -created_at), JSON cursor pagination. `view_id` applies a saved view for object "contact".
  app.get<{ Querystring: { q?: string; company_id?: string; sort?: string; limit?: string; cursor?: string; view_id?: string } }>(
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
      return {
        data: page.map((r) => ({
          id: r.id,
          first_name: r.firstName,
          last_name: r.lastName,
          email: r.email,
          company_id: r.companyId,
          created_at: r.createdAt.toISOString(),
        })),
        next_cursor: cursorOut,
        applied_filters: filters,
      };
    }
  );

  // GET /opportunities — opportunity list: q (name contains), company_id, pipeline_id, stage_id,
  // status, sort (updated_at | -updated_at), JSON cursor pagination. `view_id` applies a saved view
  // for object "opportunity".
  app.get<{ Querystring: { q?: string; company_id?: string; pipeline_id?: string; stage_id?: string; status?: string; sort?: string; limit?: string; cursor?: string; view_id?: string } }>(
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
      return {
        data: page.map((r) => ({
          id: r.id,
          name: r.name,
          company_id: r.companyId,
          pipeline_id: r.pipelineId,
          stage_id: r.stageId,
          status: r.status,
          amount: r.amount,
          currency: r.currency,
          updated_at: r.updatedAt.toISOString(),
        })),
        next_cursor: cursorOut,
        applied_filters: filters,
      };
    }
  );

  // GET /tasks — task list: q (title contains), type, status, assigned_to, account_id (tasks
  // related to a company), sort (created_at | -created_at), exact-precision JSON cursor, and
  // view_id for saved views (object "task").
  app.get<{ Querystring: { q?: string; type?: string; status?: string; assigned_to?: string; account_id?: string; sort?: string; limit?: string; cursor?: string; view_id?: string } }>(
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
      return {
        data: page.map((r) => ({
          id: r.id,
          title: r.title,
          type: r.type,
          status: r.status,
          priority: r.priority,
          due_at: r.dueDate ? r.dueDate.toISOString() : null,
          assigned_to: r.assignedTo,
          account_id: r.relatedEntityType === "company" ? r.relatedEntityId : null,
          created_at: r.createdAt.toISOString(),
        })),
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
    async (request, reply) => {
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
    }
  );
}
