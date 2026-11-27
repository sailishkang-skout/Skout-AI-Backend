import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "@skout/db";
import { completeIdempotency, hashRequestBody, isValidIdempotencyKey, reserveIdempotency } from "@skout/shared";
import { createLogger } from "@skout/observability";
import { copsIdempotencyStore } from "../services/cops-platform.service.js";
import { WorkbookV2Error } from "../services/workbook-v2.service.js";
import {
  WEBHOOK_BODY_LIMIT,
  admitRequest,
  assertWorkspaceMayReceive,
  authenticateWebhook,
  noteRefusal,
  parseRows,
  receiveRows,
  type InboundWebhook,
  type WebhookResult,
} from "../services/workbook-webhook-inbound.service.js";
import { describeFailure } from "../services/workbook-import-core.js";
import { apiError } from "../utils/http.js";

const log = createLogger("workbook-webhook");

/** Requests one address may make a minute whatever tokens it sends: a brake on guessing, well above the webhook limit. */
const PER_IP_LIMIT = 600;

type Inbound = FastifyRequest<{ Params: { webhookId: string } }> & { inbound?: InboundWebhook };

/**
 * The public side of a workbook's webhook (WB2-026): `POST /webhooks/workbooks/:webhookId` with the webhook's token in
 * the Authorization header. No Skout sign-in applies; the token is the only way in. It is checked, and the request
 * counted against the limit, before the body is read. Nothing sent here is logged.
 */
export async function workbookWebhookInboundRoutes(app: FastifyInstance) {
  await app.register(async (hooks) => {
    const refuse = (request: FastifyRequest, reply: FastifyReply, error: WorkbookV2Error) =>
      reply.status(error.statusCode).send(apiError(error.code, error.message, error.statusCode, { requestId: request.id, details: error.details }));
    const record = (request: Inbound, code: string) =>
      request.inbound
        ? noteRefusal(app.db!, request.inbound, request.id, code).catch((error) => log.error("could not record a refused webhook request", undefined, { failure: describeFailure(error) }))
        : Promise.resolve();

    // The body is taken as text whatever it claims to be, so that it is parsed, and refused, here.
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser("*", { parseAs: "string", bodyLimit: WEBHOOK_BODY_LIMIT }, (_request, body, done) => done(null, body));

    hooks.setErrorHandler(async (error: Error & { statusCode?: number; code?: string }, request, reply) => {
      if (error instanceof WorkbookV2Error) return refuse(request, reply, error);
      if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        await record(request as Inbound, "PAYLOAD_TOO_LARGE");
        return refuse(request, reply, new WorkbookV2Error("PAYLOAD_TOO_LARGE", 413, `The body is larger than ${WEBHOOK_BODY_LIMIT / 1024 / 1024} MB.`, { limitBytes: WEBHOOK_BODY_LIMIT }));
      }
      if (error.statusCode === 429) return reply.status(429).send(apiError("RATE_LIMITED", "Too many requests from this address. Try again shortly.", 429, { requestId: request.id }));
      if (error.statusCode && error.statusCode < 500) return reply.status(error.statusCode).send(apiError("BAD_REQUEST", "The request couldn't be read.", error.statusCode, { requestId: request.id }));
      // Only the kind of failure: a database error's own text quotes the statement's values, which are what was sent.
      log.error("webhook request failed", undefined, { requestId: request.id, failure: describeFailure(error) });
      return reply.status(500).send(apiError("INTERNAL_ERROR", "The rows couldn't be added. Nothing from this request was saved; send it again.", 500, { requestId: request.id }));
    });

    hooks.post<{ Params: { webhookId: string } }>(
      "/webhooks/workbooks/:webhookId",
      {
        bodyLimit: WEBHOOK_BODY_LIMIT,
        config: { rateLimit: { max: PER_IP_LIMIT, timeWindow: 60_000, keyGenerator: (request: FastifyRequest) => `workbook-webhook:${request.ip}` } },
        // Not onRequest: the rate limit per address is added there, after any hook set here, and must come first.
        preParsing: async (request: Inbound, reply: FastifyReply) => {
          if (!app.db) return reply.status(503).send(apiError("database_unavailable", "Try again shortly.", 503, { requestId: request.id }));
          try {
            const hook = await authenticateWebhook(app.db, request.params.webhookId, request.headers.authorization);
            await assertWorkspaceMayReceive(app.db, app.config, hook.workspaceId);
            const admitted = await admitRequest(app.db, hook, request.id);
            if (!admitted.allowed) {
              reply.header("retry-after", String(admitted.retryAfterSeconds));
              return refuse(request, reply, new WorkbookV2Error("RATE_LIMITED", 429, "This webhook takes at most 60 requests a minute.", { retryAfterSeconds: admitted.retryAfterSeconds }));
            }
            request.inbound = hook;
            if (!/^application\/(?:[\w.+-]+\+)?json\s*(;|$)/i.test(request.headers["content-type"] ?? "")) {
              await record(request, "UNSUPPORTED_MEDIA_TYPE");
              return refuse(request, reply, new WorkbookV2Error("UNSUPPORTED_MEDIA_TYPE", 415, "Send the rows as JSON, with Content-Type: application/json."));
            }
          } catch (error) {
            if (error instanceof WorkbookV2Error) return refuse(request, reply, error);
            throw error;
          }
        },
      },
      async (request: Inbound, reply) => {
        const db = app.db!;
        const hook = request.inbound!;
        /** What a processed request is answered with: a refusal when nothing in it could be added. */
        const respond = (result: WebhookResult): { status: number; body: unknown } => {
          if (result.inserted || result.duplicates || !result.rejected) return { status: 200, body: { data: result } };
          const full = result.errors.every((e) => e.code === "ROW_LIMIT_EXCEEDED");
          const code = full ? "ROW_LIMIT_EXCEEDED" : "NO_ROWS_ACCEPTED";
          const message = full ? "The workbook has no room for more rows." : "None of the rows could be added.";
          return { status: 422, body: apiError(code, message, 422, { requestId: request.id, details: result }) };
        };
        /** Adds the rows, or answers why the request as a whole was refused. */
        const answer = async (settle?: (tx: Db, result: WebhookResult) => Promise<void>): Promise<{ status: number; body: unknown }> => {
          try {
            return respond(await receiveRows(db, hook, parseRows(request.body), request.id, settle));
          } catch (error) {
            if (!(error instanceof WorkbookV2Error)) throw error;
            if (error.statusCode !== 401) await record(request, error.code);
            return { status: error.statusCode, body: apiError(error.code, error.message, error.statusCode, { requestId: request.id, details: error.details }) };
          }
        };

        const header = request.headers["idempotency-key"];
        if (header === undefined) {
          const { status, body } = await answer();
          return reply.status(status).send(body);
        }
        if (typeof header !== "string" || !isValidIdempotencyKey(header)) {
          await record(request, "VALIDATION_FAILED");
          return refuse(request, reply, new WorkbookV2Error("VALIDATION_FAILED", 422, "Idempotency-Key must be 8 to 128 characters."));
        }
        // A retry with the same key and body is answered as the first was, and adds nothing more.
        const store = copsIdempotencyStore(db);
        const key = `workbook-webhook:${hook.webhookId}:${header}`;
        const fingerprint = { method: request.method, path: `/webhooks/workbooks/${hook.webhookId}`, body: request.body };
        const decision = await reserveIdempotency(store, hook.workspaceId, key, fingerprint);
        if (decision.kind === "replay") {
          reply.header("idempotency-replayed", "true");
          return reply.status(decision.status).send(decision.response);
        }
        if (decision.kind === "conflict") return refuse(request, reply, new WorkbookV2Error("IDEMPOTENCY_KEY_REUSED", 409, "This Idempotency-Key was used with a different body."));
        if (decision.kind === "in_progress") {
          reply.header("retry-after", "5");
          return refuse(request, reply, new WorkbookV2Error("IDEMPOTENCY_KEY_REUSED", 409, "A request with this Idempotency-Key is still being handled. Try again shortly."));
        }
        const release = () => store.release(hook.workspaceId, key, hashRequestBody(fingerprint));
        let outcome: { status: number; body: unknown };
        try {
          // The answer is saved in the transaction that adds the rows: never one without the other. If another request
          // saved an answer for this key first, saving fails and this one's rows are not added.
          outcome = await answer(async (tx, result) => {
            const { status, body } = respond(result);
            if (status === 200) await completeIdempotency(copsIdempotencyStore(tx), hook.workspaceId, key, fingerprint, status, body);
          });
        } catch (error) {
          await release();
          throw error;
        }
        // A refusal that may not stand, such as a full workbook, is not remembered: the same request may succeed later.
        if (outcome.status !== 200) await release();
        return reply.status(outcome.status).send(outcome.body);
      }
    );
  });
}
