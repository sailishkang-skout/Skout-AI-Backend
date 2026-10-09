import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { reconcileCreditLedger, type Db } from "@skout/db";
import { copsErrorBody, copsErrorStatus, isValidIdempotencyKey, resolveCorrelationId } from "@skout/shared";
import { getMemberPermissions } from "@skout/auth";
import { copsIdempotencyStore, requireAnyCopsPermission } from "../services/cops-platform.service.js";
import { withCopsIdempotentReply, type CopsCapturingReply } from "../services/cops-idempotent.js";
import {
  loadProvisionings,
  PROVISIONING_INTEGRATIONS,
  ProvisioningError,
  retryProvisioning,
  startProvisioning,
  type ProvisioningDeps,
} from "../services/cops-provisioning.service.js";
import { extendTrial, findProvisionedWorkspace, getWallet, postManualCredit, WalletError } from "../services/cops-credits.service.js";
import { buildInviteEmail, sendMail } from "../services/mail.service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reasonText = z.string().trim().min(1, "reason is required").max(1000);

const provisionSchema = z
  .object({
    opportunity_id: z.string().regex(UUID, "Invalid id"),
    admin_email: z.string().trim().email(),
    workspace_name: z.string().trim().min(1).max(120).optional(),
    plan: z.string().trim().min(1).max(64).default("trial"),
    trial_days: z.number().int().min(1).max(90).default(14),
    credits: z.number().int().min(0).max(1_000_000).default(500),
    integrations: z.array(z.enum(PROVISIONING_INTEGRATIONS)).max(3).default(["crm", "email"]),
  })
  .strict();
const grantSchema = z.object({ amount: z.number().int().min(1).max(1_000_000), reason: reasonText }).strict();
const adjustSchema = z
  .object({
    amount: z.number().int().min(-1_000_000).max(1_000_000).refine((v) => v !== 0, "amount must not be zero"),
    reason: reasonText,
    compensates_id: z.string().regex(UUID, "Invalid id").optional(),
  })
  .strict();
const extendSchema = z.object({ days: z.number().int().min(1).max(90), reason: reasonText }).strict();

type Reply = CopsCapturingReply;

/**
 * COPS-04 trial provisioning + credit wallet. Contract: docs/api/copos-04-provisioning.openapi.yaml.
 * Provision uses its own idempotency (sha256(account + Idempotency-Key) on the saga row) so a failed
 * run is resumed by the same key instead of replaying a stored error; other writes use the COPS-01
 * idempotency store.
 */
export async function copsProvisioningRoutes(app: FastifyInstance, opts: { db: Db; deps?: ProvisioningDeps }) {
  const { db } = opts;
  const perms = (ws: string, user: string) => getMemberPermissions(db, ws, user);
  const writeGate = requireAnyCopsPermission(["onboarding:write", "commercial:send"], perms);
  const readGate = requireAnyCopsPermission(["onboarding:read", "commercial:read", "credits:read"], perms);
  const adjustGate = requireAnyCopsPermission(["credits:adjust"], perms);
  const idempotency = copsIdempotencyStore(db);
  const inviteBaseUrl = app.config.INVITE_BASE_URL ?? app.config.FRONTEND_URL ?? "http://localhost:3000";
  const deps: ProvisioningDeps = opts.deps ?? {
    inviteBaseUrl,
    sendInvite: async ({ to, workspaceName, acceptUrl }) =>
      sendMail(app.config, buildInviteEmail({ to, inviterName: "Skout", workspaceName, role: "owner", acceptUrl })),
  };

  const ctxOf = (request: { workspaceId?: string; userId?: string; headers: Record<string, unknown> }) => ({
    workspaceId: request.workspaceId!,
    userId: request.userId!,
    requestId: resolveCorrelationId(request.headers["x-request-id"] as string | undefined),
  });

  function invalid(reply: Reply, requestId: string, error: z.ZodError | { path: string; message: string }) {
    const fields =
      error instanceof z.ZodError
        ? error.issues.map((i) => ({ path: i.path.join(".") || "body", code: i.code, message: i.message }))
        : [{ path: error.path, code: "invalid", message: error.message }];
    return reply
      .status(copsErrorStatus("VALIDATION_FAILED"))
      .send(copsErrorBody({ code: "VALIDATION_FAILED", message: fields[0]?.message ?? "Invalid request", requestId, details: { fields } }));
  }

  async function run<T>(reply: Reply, requestId: string, fn: () => Promise<T>, onOk: (value: T) => unknown) {
    try {
      return onOk(await fn());
    } catch (error) {
      if (error instanceof ProvisioningError || error instanceof WalletError) {
        return reply.status(error.status).send(
          copsErrorBody({
            code: error.code,
            message: error.message,
            requestId,
            details: error.details,
            retryable: error instanceof ProvisioningError ? error.retryable : false,
          })
        );
      }
      throw error;
    }
  }

  /** A failed saga answers 502 with the per-step status so the client can show it and offer retry. */
  const sagaReply = (reply: Reply, requestId: string, data: { status: string; last_error: string | null }, okStatus: number) =>
    data.status === "failed"
      ? reply.status(502).send({
          ...copsErrorBody({ code: "PROVISIONING_STEP_FAILED", message: data.last_error ?? "A provisioning step failed", requestId, retryable: true }),
          data,
        })
      : reply.status(okStatus).send({ data });

  type IdBody = { Params: { id: string }; Body: unknown };

  app.post<IdBody>("/accounts/:id/provision", { preHandler: writeGate }, async (request, rawReply) => {
    const reply = rawReply as unknown as Reply;
    const ctx = ctxOf(request);
    if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
    const header = request.headers["idempotency-key"];
    const key = Array.isArray(header) ? header[0] : header;
    if (!key || !isValidIdempotencyKey(key)) {
      return invalid(reply, ctx.requestId, { path: "Idempotency-Key", message: "Idempotency-Key header is required (8 to 128 characters)" });
    }
    const parsed = provisionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
    return run(
      reply,
      ctx.requestId,
      () => startProvisioning(db, ctx, request.params.id, key, parsed.data, deps),
      ({ provisioning, replayed }) => sagaReply(reply, ctx.requestId, provisioning, replayed ? 200 : 201)
    );
  });

  app.get<{ Params: { id: string } }>("/accounts/:id/provisioning", { preHandler: readGate }, async (request, reply) => {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    if (!UUID.test(request.params.id)) return invalid(reply as never, requestId, { path: "id", message: "Invalid id" });
    return { data: await loadProvisionings(db, request.workspaceId!, { accountId: request.params.id }, { inviteBaseUrl }) };
  });

  app.post<IdBody>(
    "/provisionings/:id/retry",
    { preHandler: writeGate },
    withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
      return run(
        reply,
        ctx.requestId,
        () => retryProvisioning(db, ctx, request.params.id, deps),
        (provisioning) => sagaReply(reply, ctx.requestId, provisioning, 200)
      );
    })
  );

  app.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    "/accounts/:id/credits",
    { preHandler: readGate },
    async (request, rawReply) => {
      const reply = rawReply as unknown as Reply;
      const requestId = resolveCorrelationId(request.headers["x-request-id"]);
      if (!UUID.test(request.params.id)) return invalid(reply, requestId, { path: "id", message: "Invalid id" });
      return run(
        reply,
        requestId,
        () =>
          getWallet(db, request.workspaceId!, request.params.id, {
            cursor: request.query.cursor,
            limit: request.query.limit ? Number(request.query.limit) : undefined,
          }),
        (wallet) => ({ data: wallet })
      );
    }
  );

  for (const kind of ["grant", "adjustment"] as const) {
    app.post<IdBody>(
      kind === "grant" ? "/accounts/:id/credits/grants" : "/accounts/:id/credits/adjustments",
      { preHandler: adjustGate },
      withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
        const ctx = ctxOf(request);
        if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
        const parsed = (kind === "grant" ? grantSchema : adjustSchema).safeParse(request.body ?? {});
        if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
        const body = parsed.data as { amount: number; reason: string; compensates_id?: string };
        const header = request.headers["idempotency-key"];
        return run(
          reply,
          ctx.requestId,
          () =>
            postManualCredit(db, ctx, request.params.id, {
              kind,
              amount: body.amount,
              reason: body.reason,
              compensatesId: body.compensates_id ?? null,
              requestKey: String(Array.isArray(header) ? header[0] : header),
            }),
          (out) => reply.status(201).send({ data: { ...out!.entry, balance: out!.balance } })
        );
      })
    );
  }

  app.post<IdBody>(
    "/accounts/:id/trial/extend",
    { preHandler: writeGate },
    withCopsIdempotentReply<IdBody>(idempotency, async (request, reply) => {
      const ctx = ctxOf(request);
      if (!UUID.test(request.params.id)) return invalid(reply, ctx.requestId, { path: "id", message: "Invalid id" });
      const parsed = extendSchema.safeParse(request.body ?? {});
      if (!parsed.success) return invalid(reply, ctx.requestId, parsed.error);
      return run(reply, ctx.requestId, () => extendTrial(db, ctx, request.params.id, parsed.data), (dates) => ({ data: dates }));
    })
  );

  /**
   * Live reconciliation of the wallets this workspace provisioned (never other tenants' wallets;
   * the platform-wide daily run is in credit_reconciliation_runs for operators).
   */
  app.get("/credits/reconciliation", { preHandler: adjustGate }, async (request) => {
    const rows = await loadProvisionings(db, request.workspaceId!, {});
    const accounts = [...new Set(rows.filter((r) => r.provisioned_workspace_id).map((r) => r.account_id))];
    const results = [];
    for (const accountId of accounts) {
      const wallet = await findProvisionedWorkspace(db, request.workspaceId!, accountId);
      if (!wallet) continue;
      const { mismatches } = await reconcileCreditLedger(db, { workspaceId: wallet.workspaceId });
      results.push({ account_id: accountId, workspace_id: wallet.workspaceId, ok: mismatches.length === 0, mismatches });
    }
    return { data: { checked_at: new Date().toISOString(), wallets: results } };
  });
}
