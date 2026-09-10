import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { createDb, schema, scopedTo, scopedById } from "@skout/db";
import { createLogger } from "@skout/observability";
import type { Env } from "../config/env.js";
import { enqueueWebhookDelivery } from "../workers/webhook-delivery.queue.js";

const log = createLogger("webhook.service");

/**
 * Outbound webhook event types — the subset of SKOUT_EVENT_TYPES that are
 * fan-out delivered to customer webhook endpoints (§12).
 *
 * Source-of-truth for all Skout event types is `@skout/shared` → `event-envelope.ts`.
 * This list is deliberately narrower: not every internal event needs external delivery.
 */
export const WEBHOOK_EVENT_TYPES = [
  // ── Sequence & outreach (§8.6) ──────────────────────────────────────────
  "prospect.enrolled",
  "sequence.step.completed",
  "reply.received",
  // ── Dexter platform lifecycle / event spine (§7.3) ──────────────────────
  "icp.approved",
  "icp.rejected",
  "tam.approved",
  "tam.rejected",
  "regional_brief.approved",
  "regional_brief.rejected",
  "dexter.plan.proposed",
  "dexter.plan.approved",
  "dexter.plan.rejected",
  "dexter.plan.blocked",
  "dexter.action.executed",
  "dexter.outcome.captured",
  "dexter.learning.recommended",
  "dexter.learning.approved",
  // ── GTM outcome / event-spine completion (§7.3) ─────────────────────────
  "signal.detected",
  "enrichment.completed",
  "sequence.approved",
  "touchpoint.completed",
  "reply.classified",
  "meeting.completed",
  "opportunity.updated",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

const { webhookEndpoints, webhookDeliveries } = schema;

type DbClient = ReturnType<typeof createDb>["db"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookEndpointRow {
  id: string;
  workspaceId: string;
  url: string;
  description: string | null;
  enabled: boolean;
  eventTypes: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEndpointInput {
  url: string;
  description?: string;
  eventTypes: WebhookEventType[];
}

export interface UpdateEndpointInput {
  url?: string;
  description?: string | null;
  enabled?: boolean;
  eventTypes?: WebhookEventType[];
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function buildWebhookService(db: DbClient | null) {
  if (!db) return null;

  return {
    async listEndpoints(workspaceId: string): Promise<WebhookEndpointRow[]> {
      const rows = await db
        .select()
        .from(webhookEndpoints)
        .where(scopedTo(webhookEndpoints, workspaceId))
        .orderBy(desc(webhookEndpoints.createdAt));
      return rows.map(toEndpointRow);
    },

    async getEndpoint(id: string, workspaceId: string): Promise<WebhookEndpointRow | null> {
      const [row] = await db
        .select()
        .from(webhookEndpoints)
        .where(scopedById(webhookEndpoints, workspaceId, id))
        .limit(1);
      return row ? toEndpointRow(row) : null;
    },

    async createEndpoint(
      workspaceId: string,
      input: CreateEndpointInput
    ): Promise<WebhookEndpointRow> {
      const secret = randomUUID().replace(/-/g, "");
      const [row] = await db
        .insert(webhookEndpoints)
        .values({
          workspaceId,
          url: input.url,
          secret,
          description: input.description ?? null,
          eventTypes: input.eventTypes,
        })
        .returning();
      if (!row) throw new Error("insert returned no row");
      return { ...toEndpointRow(row), secret } as WebhookEndpointRow & { secret: string };
    },

    async updateEndpoint(
      id: string,
      workspaceId: string,
      input: UpdateEndpointInput
    ): Promise<WebhookEndpointRow | null> {
      const [row] = await db
        .update(webhookEndpoints)
        .set({
          ...(input.url !== undefined && { url: input.url }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.enabled !== undefined && { enabled: input.enabled }),
          ...(input.eventTypes !== undefined && { eventTypes: input.eventTypes }),
          updatedAt: new Date(),
        })
        .where(scopedById(webhookEndpoints, workspaceId, id))
        .returning();
      return row ? toEndpointRow(row) : null;
    },

    async deleteEndpoint(id: string, workspaceId: string): Promise<boolean> {
      const result = await db
        .delete(webhookEndpoints)
        .where(scopedById(webhookEndpoints, workspaceId, id))
        .returning({ id: webhookEndpoints.id });
      return result.length > 0;
    },

    async rotateSecret(id: string, workspaceId: string): Promise<string | null> {
      const newSecret = randomUUID().replace(/-/g, "");
      const [row] = await db
        .update(webhookEndpoints)
        .set({ secret: newSecret, updatedAt: new Date() })
        .where(scopedById(webhookEndpoints, workspaceId, id))
        .returning({ id: webhookEndpoints.id });
      return row ? newSecret : null;
    },

    async listDeliveries(
      endpointId: string,
      workspaceId: string,
      limit = 50
    ) {
      return db
        .select()
        .from(webhookDeliveries)
        .where(
          scopedTo(webhookDeliveries, workspaceId, eq(webhookDeliveries.endpointId, endpointId))
        )
        .orderBy(desc(webhookDeliveries.createdAt))
        .limit(limit);
    },
  };
}

// ---------------------------------------------------------------------------
// Event dispatch — called from workers/services to fan-out to subscribed endpoints
// ---------------------------------------------------------------------------

/**
 * Find all enabled endpoints subscribed to `eventType` in the workspace and
 * enqueue a delivery job for each one. Fire-and-forget — callers should `.catch()`.
 */
export async function dispatchWebhookEvent(
  db: DbClient,
  config: Env,
  eventType: WebhookEventType,
  workspaceId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const endpoints = await db
    .select()
    .from(webhookEndpoints)
    .where(
      scopedTo(
        webhookEndpoints,
        workspaceId,
        eq(webhookEndpoints.enabled, true),
        // jsonb @> operator: endpoint's event_types array contains this event type
        sql`${webhookEndpoints.eventTypes} @> ${JSON.stringify([eventType])}::jsonb`
      )
    );

  if (endpoints.length === 0) return;

  const eventId = randomUUID();

  await Promise.allSettled(
    endpoints.map((ep) =>
      enqueueWebhookDelivery(config, {
        deliveryId: randomUUID(),
        endpointId: ep.id,
        url: ep.url,
        secret: ep.secret,
        workspaceId,
        eventType,
        eventId,
        attempt: 1,
        payload,
      }).catch((err: unknown) => {
        log.warn("Failed to enqueue webhook delivery", {
          endpointId: ep.id,
          eventType,
          err,
        });
      })
    )
  );

  log.debug("Dispatched webhook event", { eventType, workspaceId, endpointCount: endpoints.length });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toEndpointRow(row: typeof webhookEndpoints.$inferSelect): WebhookEndpointRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    url: row.url,
    description: row.description,
    enabled: row.enabled,
    eventTypes: Array.isArray(row.eventTypes) ? (row.eventTypes as string[]) : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

