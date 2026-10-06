import type { FastifyInstance } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import { copsErrorBody, copsErrorStatus, resolveCorrelationId } from "@skout/shared";
import { getMemberPermissions } from "@skout/auth";
import { copsIdempotencyStore, requireAnyCopsPermission, writeCopsAudit } from "../services/cops-platform.service.js";
import { withCopsIdempotentReply } from "../services/cops-idempotent.js";
import { writeContactChannel } from "../services/cops-contact-channels.service.js";

const { companies, contacts, deals, tasks, tags, entityTags, opportunityContacts, contactChannels } = schema;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TAGGABLE = ["account", "contact", "opportunity", "task"] as const;
const BOUNCE = ["none", "soft", "hard"] as const;

/**
 * COPS-02 CRM objects with no existing routes: tags and tag assignments, opportunity contacts,
 * and contact channels (verified vs inferred values, suppression and bounce status). Reads need
 * crm:read or crm:manage; writes need crm:write or crm:manage and an Idempotency-Key.
 */
export async function copsCrmObjectsRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
  const perms = (ws: string, user: string) => getMemberPermissions(db, ws, user);
  const readGate = requireAnyCopsPermission(["crm:read", "crm:manage"], perms);
  const writeGate = requireAnyCopsPermission(["crm:write", "crm:manage"], perms);
  const idempotency = copsIdempotencyStore(db);

  const invalid = (requestId: string, path: string, message: string) => ({
    status: copsErrorStatus("VALIDATION_FAILED"),
    body: copsErrorBody({ code: "VALIDATION_FAILED", message, requestId, details: { fields: [{ path, code: "invalid", message }] } }),
  });
  const notFound = (requestId: string, message: string) => ({
    status: 404,
    body: copsErrorBody({ code: "NOT_FOUND", message, requestId, details: {} }),
  });

  /** True when the record exists in this workspace. Stops tagging or linking another tenant's ids. */
  async function entityInWorkspace(workspaceId: string, entityType: string, entityId: string): Promise<boolean> {
    const table = entityType === "account" ? companies : entityType === "contact" ? contacts : entityType === "opportunity" ? deals : tasks;
    const [row] = await db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, entityId), eq(table.workspaceId, workspaceId)))
      .limit(1);
    return Boolean(row);
  }

  // ---- Tags ----

  app.get("/tags", { preHandler: readGate }, async (request) => {
    const rows = await db
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(eq(tags.workspaceId, request.workspaceId!))
      .orderBy(asc(tags.name));
    return { data: rows };
  });

  app.post<{ Body: { name?: string } }>(
    "/tags",
    { preHandler: writeGate },
    withCopsIdempotentReply<{ Body: { name?: string } }>(idempotency, async (request, reply) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      const name = (request.body?.name ?? "").trim();
      if (name.length < 1 || name.length > 60) {
        const e = invalid(requestId, "name", "name must be 1-60 characters");
        return reply.status(e.status).send(e.body);
      }
      const [created] = await db
        .insert(tags)
        .values({ workspaceId: request.workspaceId!, name })
        .onConflictDoNothing()
        .returning({ id: tags.id, name: tags.name });
      if (created) return reply.status(201).send({ data: created });
      // Tag names are unique per workspace; creating an existing one returns it.
      const [existing] = await db
        .select({ id: tags.id, name: tags.name })
        .from(tags)
        .where(and(eq(tags.workspaceId, request.workspaceId!), eq(tags.name, name)))
        .limit(1);
      return { data: existing };
    })
  );

  app.get<{ Params: { type: string; id: string } }>("/records/:type/:id/tags", { preHandler: readGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    if (!(TAGGABLE as readonly string[]).includes(request.params.type)) {
      const e = invalid(requestId, "type", `type must be one of ${TAGGABLE.join(", ")}`);
      return reply.status(e.status).send(e.body);
    }
    if (!UUID.test(request.params.id)) {
      const e = invalid(requestId, "id", "Invalid id");
      return reply.status(e.status).send(e.body);
    }
    const rows = await db
      .select({ id: tags.id, name: tags.name })
      .from(entityTags)
      .innerJoin(tags, eq(tags.id, entityTags.tagId))
      .where(
        and(
          eq(entityTags.workspaceId, request.workspaceId!),
          eq(entityTags.entityType, request.params.type),
          eq(entityTags.entityId, request.params.id)
        )
      )
      .orderBy(asc(tags.name));
    return { data: rows };
  });

  type AssignGeneric = { Params: { id: string }; Body: { entity_type?: string; entity_id?: string } };
  app.post<AssignGeneric>(
    "/tags/:id/assign",
    { preHandler: writeGate },
    withCopsIdempotentReply<AssignGeneric>(idempotency, async (request, reply) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      const workspaceId = request.workspaceId!;
      const entityType = request.body?.entity_type ?? "";
      const entityId = request.body?.entity_id ?? "";
      const fail = (path: string, message: string) => {
        const e = invalid(requestId, path, message);
        return reply.status(e.status).send(e.body);
      };
      if (!UUID.test(request.params.id)) return fail("id", "Invalid tag id");
      if (!(TAGGABLE as readonly string[]).includes(entityType)) return fail("entity_type", `entity_type must be one of ${TAGGABLE.join(", ")}`);
      if (!UUID.test(entityId)) return fail("entity_id", "Invalid entity_id");

      const [tag] = await db.select({ id: tags.id }).from(tags).where(and(eq(tags.id, request.params.id), eq(tags.workspaceId, workspaceId))).limit(1);
      if (!tag) {
        const e = notFound(requestId, "Tag not found");
        return reply.status(e.status).send(e.body);
      }
      if (!(await entityInWorkspace(workspaceId, entityType, entityId))) return fail("entity_id", "Record not found in this workspace");

      await db.insert(entityTags).values({ workspaceId, tagId: tag.id, entityType, entityId }).onConflictDoNothing();
      return { data: { tag_id: tag.id, entity_type: entityType, entity_id: entityId } };
    })
  );

  app.post<AssignGeneric>(
    "/tags/:id/unassign",
    { preHandler: writeGate },
    withCopsIdempotentReply<AssignGeneric>(idempotency, async (request, reply) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      const entityType = request.body?.entity_type ?? "";
      const entityId = request.body?.entity_id ?? "";
      if (!UUID.test(request.params.id) || !UUID.test(entityId) || !(TAGGABLE as readonly string[]).includes(entityType)) {
        const e = invalid(requestId, "entity_id", "tag id, entity_type and entity_id are required");
        return reply.status(e.status).send(e.body);
      }
      const removed = await db
        .delete(entityTags)
        .where(
          and(
            eq(entityTags.workspaceId, request.workspaceId!),
            eq(entityTags.tagId, request.params.id),
            eq(entityTags.entityType, entityType),
            eq(entityTags.entityId, entityId)
          )
        )
        .returning({ tagId: entityTags.tagId });
      return { data: { removed: removed.length } };
    })
  );

  // ---- Opportunity contacts (buying committee on a deal) ----

  app.get<{ Params: { id: string } }>("/opportunities/:id/contacts", { preHandler: readGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    if (!UUID.test(request.params.id)) {
      const e = invalid(requestId, "id", "Invalid opportunity id");
      return reply.status(e.status).send(e.body);
    }
    const rows = await db
      .select({ contactId: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, email: contacts.email, role: opportunityContacts.role })
      .from(opportunityContacts)
      .innerJoin(contacts, eq(contacts.id, opportunityContacts.contactId))
      .where(and(eq(opportunityContacts.workspaceId, request.workspaceId!), eq(opportunityContacts.opportunityId, request.params.id)));
    return {
      data: rows.map((r) => ({ contact_id: r.contactId, first_name: r.firstName, last_name: r.lastName, email: r.email, role: r.role })),
    };
  });

  type OppContactGeneric = { Params: { id: string }; Body: { contact_id?: string; role?: string } };
  app.post<OppContactGeneric>(
    "/opportunities/:id/contacts",
    { preHandler: writeGate },
    withCopsIdempotentReply<OppContactGeneric>(idempotency, async (request, reply) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      const workspaceId = request.workspaceId!;
      const contactId = request.body?.contact_id ?? "";
      const role = (request.body?.role ?? "stakeholder").trim();
      const fail = (path: string, message: string) => {
        const e = invalid(requestId, path, message);
        return reply.status(e.status).send(e.body);
      };
      if (!UUID.test(request.params.id)) return fail("id", "Invalid opportunity id");
      if (!UUID.test(contactId)) return fail("contact_id", "Invalid contact_id");
      if (role.length < 1 || role.length > 60) return fail("role", "role must be 1-60 characters");
      if (!(await entityInWorkspace(workspaceId, "opportunity", request.params.id))) {
        const e = notFound(requestId, "Opportunity not found");
        return reply.status(e.status).send(e.body);
      }
      if (!(await entityInWorkspace(workspaceId, "contact", contactId))) return fail("contact_id", "Contact not found in this workspace");

      await db
        .insert(opportunityContacts)
        .values({ workspaceId, opportunityId: request.params.id, contactId, role })
        .onConflictDoUpdate({
          target: [opportunityContacts.workspaceId, opportunityContacts.opportunityId, opportunityContacts.contactId],
          set: { role },
        });
      return reply.status(201).send({ data: { opportunity_id: request.params.id, contact_id: contactId, role } });
    })
  );

  type OppContactDeleteGeneric = { Params: { id: string; contactId: string } };
  app.delete<OppContactDeleteGeneric>(
    "/opportunities/:id/contacts/:contactId",
    { preHandler: writeGate },
    withCopsIdempotentReply<OppContactDeleteGeneric>(idempotency, async (request) => {
      const removed = await db
        .delete(opportunityContacts)
        .where(
          and(
            eq(opportunityContacts.workspaceId, request.workspaceId!),
            eq(opportunityContacts.opportunityId, request.params.id),
            eq(opportunityContacts.contactId, request.params.contactId)
          )
        )
        .returning({ contactId: opportunityContacts.contactId });
      return { data: { removed: removed.length } };
    })
  );

  // ---- Contact channels ----

  app.get<{ Params: { id: string } }>("/contacts/:id/channels", { preHandler: readGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    if (!UUID.test(request.params.id)) {
      const e = invalid(requestId, "id", "Invalid contact id");
      return reply.status(e.status).send(e.body);
    }
    const rows = await db
      .select()
      .from(contactChannels)
      .where(and(eq(contactChannels.workspaceId, request.workspaceId!), eq(contactChannels.contactId, request.params.id)))
      .orderBy(asc(contactChannels.channel), asc(contactChannels.value));
    return {
      data: rows.map((r) => ({
        id: r.id,
        channel: r.channel,
        value: r.value,
        verified: r.verified,
        confidence: Number(r.confidence),
        source: r.source,
        suppressed: r.suppressed,
        bounce_status: r.bounceStatus,
        observed_at: r.observedAt.toISOString(),
      })),
    };
  });

  type ChannelGeneric = {
    Params: { id: string };
    Body: { channel?: string; value?: string; verified?: boolean; confidence?: number; source?: string };
  };
  app.post<ChannelGeneric>(
    "/contacts/:id/channels",
    { preHandler: writeGate },
    withCopsIdempotentReply<ChannelGeneric>(idempotency, async (request, reply) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      const workspaceId = request.workspaceId!;
      const b = request.body ?? {};
      const fail = (path: string, message: string) => {
        const e = invalid(requestId, path, message);
        return reply.status(e.status).send(e.body);
      };
      if (!UUID.test(request.params.id)) return fail("id", "Invalid contact id");
      const channel = (b.channel ?? "").trim();
      const value = (b.value ?? "").trim();
      if (!["email", "phone", "linkedin"].includes(channel)) return fail("channel", "channel must be email, phone or linkedin");
      if (value.length < 1 || value.length > 320) return fail("value", "value must be 1-320 characters");
      const confidence = typeof b.confidence === "number" ? b.confidence : 0.5;
      if (confidence < 0 || confidence > 1) return fail("confidence", "confidence must be between 0 and 1");
      if (!(await entityInWorkspace(workspaceId, "contact", request.params.id))) {
        const e = notFound(requestId, "Contact not found");
        return reply.status(e.status).send(e.body);
      }
      const outcome = await writeContactChannel(db, {
        workspaceId,
        contactId: request.params.id,
        channel,
        value,
        verified: b.verified === true,
        confidence,
        source: (b.source ?? "user").slice(0, 40),
      });
      return { data: { outcome } };
    })
  );

  type ChannelStatusGeneric = {
    Params: { id: string; channelId: string };
    Body: { suppressed?: boolean; bounce_status?: string; reason?: string };
  };
  app.post<ChannelStatusGeneric>(
    "/contacts/:id/channels/:channelId/status",
    { preHandler: writeGate },
    withCopsIdempotentReply<ChannelStatusGeneric>(idempotency, async (request, reply) => {
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      const workspaceId = request.workspaceId!;
      const b = request.body ?? {};
      const fail = (path: string, message: string) => {
        const e = invalid(requestId, path, message);
        return reply.status(e.status).send(e.body);
      };
      if (!UUID.test(request.params.id) || !UUID.test(request.params.channelId)) return fail("channelId", "Invalid id");
      if (b.suppressed === undefined && b.bounce_status === undefined) return fail("suppressed", "Send suppressed or bounce_status");
      if (b.bounce_status !== undefined && !(BOUNCE as readonly string[]).includes(b.bounce_status)) {
        return fail("bounce_status", "bounce_status must be none, soft or hard");
      }
      const reason = (b.reason ?? "").trim();
      if (reason.length < 1 || reason.length > 500) return fail("reason", "reason is required (1-500 characters)");

      const result = await db.transaction(async (tx) => {
        const [before] = await tx
          .select({ suppressed: contactChannels.suppressed, bounceStatus: contactChannels.bounceStatus })
          .from(contactChannels)
          .where(
            and(
              eq(contactChannels.id, request.params.channelId),
              eq(contactChannels.contactId, request.params.id),
              eq(contactChannels.workspaceId, workspaceId)
            )
          )
          .limit(1);
        if (!before) return null;
        const after = {
          suppressed: b.suppressed ?? before.suppressed,
          bounceStatus: b.bounce_status ?? before.bounceStatus,
        };
        await tx.update(contactChannels).set(after).where(eq(contactChannels.id, request.params.channelId));
        // Suppression and bounce decide whether a contact may be emailed, so every change is audited.
        await writeCopsAudit(tx, {
          tenantId: workspaceId,
          actor: { type: "user", id: request.userId ?? null },
          entityType: "contact_channel",
          entityId: request.params.channelId,
          action: "contact_channel.status_changed",
          before: { suppressed: before.suppressed, bounce_status: before.bounceStatus },
          after: { suppressed: after.suppressed, bounce_status: after.bounceStatus },
          reason,
          correlationId: requestId,
          sourceChannel: "api",
        });
        return after;
      });
      if (!result) {
        const e = notFound(requestId, "Channel not found");
        return reply.status(e.status).send(e.body);
      }
      return { data: { suppressed: result.suppressed, bounce_status: result.bounceStatus } };
    })
  );
}
