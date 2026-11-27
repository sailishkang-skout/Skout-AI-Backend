import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { assertStepUp } from "@skout/auth";
import { HttpError, requireWorkspaceId } from "../utils/http.js";
import { sendMail } from "../services/mail.service.js";
import { notifyOwnersOfNewLiveKey } from "../services/public-api-key-notify.service.js";
import { dispatchWebhookEvent } from "../services/webhook.service.js";
import {
  createPublicApiKey,
  listPublicApiKeys,
  MAX_KEY_LIFETIME_DAYS,
  PUBLIC_API_SCOPES,
  revokePublicApiKey,
  rotatePublicApiKey,
  updatePublicApiKey,
  type KeyServiceConfig,
} from "../services/public-api-keys.service.js";

const scopes = z.array(z.enum(PUBLIC_API_SCOPES)).min(1).max(PUBLIC_API_SCOPES.length);
const cap = z.number().int().min(0).max(100_000_000).nullable();
const ipList = z.array(z.string().min(1).max(64)).max(50);

const createBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    type: z.enum(["live", "test"]),
    scopes,
    ip_allowlist: ipList.optional(),
    expires_in_days: z.number().int().min(1).max(MAX_KEY_LIFETIME_DAYS).optional(),
    daily_credit_cap: cap.optional(),
    monthly_credit_cap: cap.optional(),
  })
  .strict();

const updateBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    scopes: scopes.optional(),
    ip_allowlist: ipList.optional(),
    daily_credit_cap: cap.optional(),
    monthly_credit_cap: cap.optional(),
    expires_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

const rotateBody = z.object({ grace_hours: z.union([z.literal(0), z.literal(24), z.literal(168)]) }).strict();
const revokeBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const idParams = z.object({ id: z.string().uuid() });

function parse<T>(schemaDef: z.ZodType<T>, value: unknown): T {
  const r = schemaDef.safeParse(value ?? {});
  if (!r.success) throw new HttpError("Invalid request", 422, r.error.flatten());
  return r.data;
}

/**
 * PAPI-027: Settings → Developers key management (app side, session auth). KEY-2, KEY-12, D7.
 * - Owner or Admin only; Members get 403.
 * - Creating or rotating a live key needs a fresh step-up token (x-reauth-token from POST /auth/step-up).
 * - The full key is in the create and rotate responses only.
 * - Every Owner is emailed about every new live key, including one issued by rotation.
 * - Every change writes an audit event (in the key service).
 */
export async function developerApiKeysRoutes(app: FastifyInstance) {
  const keyCfg = (): KeyServiceConfig => ({
    pepper: app.config.API_KEY_PEPPER,
    maxActiveKeys: app.config.PUBLIC_API_MAX_ACTIVE_KEYS,
  });

  const actorFor = (request: FastifyRequest) => {
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) throw new HttpError("Database unavailable", 503);
    const role = request.role;
    if (role !== "owner" && role !== "admin") {
      throw new HttpError("Only workspace owners and admins can manage API keys", 403);
    }
    if (!request.userId) throw new HttpError("Missing user context", 401);
    return { db: app.db, actor: { workspaceId, userId: request.userId } };
  };

  /** Live keys need the member to have just re-authenticated (D7). */
  const requireStepUp = (request: FastifyRequest) => {
    const secret = app.config.STEP_UP_SIGNING_SECRET;
    if (!secret) throw new HttpError("Step-up re-authentication is not configured, so live keys can't be created", 503);
    assertStepUp(request.headers, secret, request.userId!);
  };

  const appUrl = () => app.config.INVITE_BASE_URL ?? app.config.FRONTEND_URL;

  app.get("/developer/keys", async (request) => {
    const { db, actor } = actorFor(request);
    return { data: await listPublicApiKeys(db, actor.workspaceId) };
  });

  app.post("/developer/keys", async (request, reply) => {
    const { db, actor } = actorFor(request);
    const body = parse(createBody, request.body);
    if (body.type === "live") requireStepUp(request);
    const created = await createPublicApiKey(db, keyCfg(), actor, {
      name: body.name,
      type: body.type,
      scopes: body.scopes,
      ipAllowlist: body.ip_allowlist,
      expiresInDays: body.expires_in_days,
      dailyCreditCap: body.daily_credit_cap,
      monthlyCreditCap: body.monthly_credit_cap,
    });
    if (created.type === "live") {
      await notifyOwnersOfNewLiveKey(db, (m) => sendMail(app.config, m), {
        workspaceId: actor.workspaceId,
        keyName: created.name,
        maskedKey: created.masked_key,
        scopes: created.scopes,
        expiresAt: created.expires_at,
        createdByEmail: request.userEmail ?? null,
        reason: "created",
        appUrl: appUrl(),
      });
    }
    reply.header("cache-control", "no-store");
    return reply.code(201).send({ data: created, notice: "Copy this key now. You won't be able to see it again." });
  });

  app.patch("/developer/keys/:id", async (request) => {
    const { db, actor } = actorFor(request);
    const { id } = parse(idParams, request.params);
    const body = parse(updateBody, request.body);
    const view = await updatePublicApiKey(db, actor, id, {
      name: body.name,
      scopes: body.scopes,
      ipAllowlist: body.ip_allowlist,
      dailyCreditCap: body.daily_credit_cap,
      monthlyCreditCap: body.monthly_credit_cap,
      expiresAt: body.expires_at ? new Date(body.expires_at) : undefined,
    });
    return { data: view };
  });

  app.post("/developer/keys/:id/rotate", async (request, reply) => {
    const { db, actor } = actorFor(request);
    const { id } = parse(idParams, request.params);
    const body = parse(rotateBody, request.body);
    const [existing] = await db
      .select({ type: schema.apiKeys.type })
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.workspaceId, actor.workspaceId)))
      .limit(1);
    if (!existing) throw new HttpError("Key not found", 404);
    if (existing.type === "live") requireStepUp(request);
    const rotated = await rotatePublicApiKey(db, keyCfg(), actor, id, body.grace_hours);
    if (rotated.replacement.type === "live") {
      await notifyOwnersOfNewLiveKey(db, (m) => sendMail(app.config, m), {
        workspaceId: actor.workspaceId,
        keyName: rotated.replacement.name,
        maskedKey: rotated.replacement.masked_key,
        scopes: rotated.replacement.scopes,
        expiresAt: rotated.replacement.expires_at,
        createdByEmail: request.userEmail ?? null,
        reason: "rotated",
        appUrl: appUrl(),
      });
    }
    reply.header("cache-control", "no-store");
    return { data: rotated, notice: "Copy the new key now. You won't be able to see it again." };
  });

  app.post("/developer/keys/:id/revoke", async (request) => {
    const { db, actor } = actorFor(request);
    const { id } = parse(idParams, request.params);
    const body = parse(revokeBody, request.body);
    const revoked = await revokePublicApiKey(db, actor, id, body.reason);
    // JOB-3: api_key.revoked to the workspace's webhooks; a failed dispatch never fails the revoke.
    await dispatchWebhookEvent(db, app.config, "api_key.revoked", actor.workspaceId, {
      key_id: revoked.id,
      name: revoked.name,
      type: revoked.type,
      masked_key: revoked.masked_key,
      revoked_at: new Date().toISOString(),
    }).catch((err: unknown) => request.log.warn({ err }, "api_key.revoked webhook dispatch failed"));
    return { data: revoked };
  });
}
