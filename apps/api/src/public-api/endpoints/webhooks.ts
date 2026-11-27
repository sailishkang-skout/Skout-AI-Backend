import { z } from "zod";
import { and, count, desc, eq } from "drizzle-orm";
import { schema, type Db } from "@skout/db";
import type { Env } from "../../config/env.js";
import { PUBLIC_API_WEBHOOK_EVENTS, buildWebhookService } from "../../services/webhook.service.js";
import { PublicApiError } from "../errors.js";
import type { PublicEndpoint } from "../pipeline.js";

/**
 * GET /webhooks, POST /webhooks, DELETE /webhooks/{id} (PAPI-062, public API PRD §7.3, §7.7).
 *
 * Webhook endpoints made through the public API, on the app's webhook service and delivery worker.
 * They can subscribe to the public API events (JOB-3) and are kept apart from the app's own webhook
 * endpoints: an API key only sees and deletes the ones made through the API. The signing secret is
 * returned once, at creation. Free; needs webhooks:manage.
 */
export const MAX_API_WEBHOOKS = 10;

export interface PublicWebhook {
  id: string;
  url: string;
  events: string[];
  description: string | null;
  enabled: boolean;
  created_at: string;
}

const { webhookEndpoints } = schema;
const API_SOURCE = "public_api";

const toPublic = (encode: (id: string) => string, row: typeof webhookEndpoints.$inferSelect): PublicWebhook => ({
  id: encode(row.id),
  url: row.url,
  events: Array.isArray(row.eventTypes) ? (row.eventTypes as string[]) : [],
  description: row.description,
  enabled: row.enabled,
  created_at: row.createdAt.toISOString(),
});

// --- GET /webhooks -----------------------------------------------------------------

const listInput = z.object({}).strict();

export function createListWebhooksEndpoint(deps: { env: Env; db: Db }): PublicEndpoint<typeof listInput, { webhooks: PublicWebhook[] }> {
  return {
    method: "GET",
    path: "/webhooks",
    scope: "webhooks:manage",
    operation: null,
    input: listInput,
    maxCost: () => 0,
    async handle({ workspaceId, ids }) {
      const rows = await deps.db
        .select()
        .from(webhookEndpoints)
        .where(and(eq(webhookEndpoints.workspaceId, workspaceId), eq(webhookEndpoints.source, API_SOURCE)))
        .orderBy(desc(webhookEndpoints.createdAt));
      return { data: { webhooks: rows.map((r) => toPublic((id) => ids.encode("webhook", id), r)) }, charge: 0 };
    },
    fixture: () => ({ webhooks: [] }),
  };
}

// --- POST /webhooks ----------------------------------------------------------------

const createInput = z
  .object({
    // JOB-6: https only. Private / loopback address blocking (at save and delivery) is PAPI-071.
    url: z
      .string()
      .trim()
      .max(2000)
      .url()
      .refine((u) => u.startsWith("https://"), { message: "Webhook URLs must use https" }),
    events: z.array(z.enum(PUBLIC_API_WEBHOOK_EVENTS)).min(1).max(PUBLIC_API_WEBHOOK_EVENTS.length),
    description: z.string().trim().max(200).optional(),
  })
  .strict();

export function createCreateWebhookEndpoint(deps: { env: Env; db: Db }): PublicEndpoint<typeof createInput, PublicWebhook & { secret: string }> {
  return {
    method: "POST",
    path: "/webhooks",
    scope: "webhooks:manage",
    operation: null,
    input: createInput,
    maxCost: () => 0,
    async handle({ input, workspaceId, ids }) {
      const [{ n }] = (await deps.db
        .select({ n: count() })
        .from(webhookEndpoints)
        .where(and(eq(webhookEndpoints.workspaceId, workspaceId), eq(webhookEndpoints.source, API_SOURCE)))) as [{ n: number }];
      if (n >= MAX_API_WEBHOOKS) {
        throw new PublicApiError("invalid_request", `A workspace can have up to ${MAX_API_WEBHOOKS} API webhooks. Delete one first.`);
      }
      const created = (await buildWebhookService(deps.db)!.createEndpoint(workspaceId, {
        url: input.url,
        description: input.description,
        eventTypes: [...new Set(input.events)],
        source: API_SOURCE,
      })) as unknown as { id: string; secret: string };
      const [row] = await deps.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, created.id)).limit(1);
      return { data: { ...toPublic((id) => ids.encode("webhook", id), row!), secret: created.secret }, charge: 0, status: 201 };
    },
    fixture: (input) => ({
      id: "whk_test_example",
      url: input.url,
      events: [...new Set(input.events)],
      description: input.description ?? null,
      enabled: true,
      created_at: "2026-01-01T00:00:00.000Z",
      secret: "test_webhook_secret_not_real",
    }),
  };
}

// --- DELETE /webhooks/{id} -----------------------------------------------------------

const deleteInput = z.object({ id: z.string().min(1).max(600) }).strict();

export function createDeleteWebhookEndpoint(deps: { env: Env; db: Db }): PublicEndpoint<typeof deleteInput, { id: string; deleted: true }> {
  return {
    method: "DELETE",
    path: "/webhooks/:id",
    scope: "webhooks:manage",
    operation: null,
    input: deleteInput,
    maxCost: () => 0,
    async handle({ input, workspaceId, ids }) {
      const internal = ids.decode("webhook", input.id);
      const deleted = internal
        ? await deps.db
            .delete(webhookEndpoints)
            .where(and(eq(webhookEndpoints.id, internal), eq(webhookEndpoints.workspaceId, workspaceId), eq(webhookEndpoints.source, API_SOURCE)))
            .returning({ id: webhookEndpoints.id })
        : [];
      if (deleted.length === 0) throw new PublicApiError("not_found", "No webhook matches.");
      return { data: { id: input.id, deleted: true }, charge: 0 };
    },
    fixture: (input) => ({ id: input.id, deleted: true }),
  };
}
