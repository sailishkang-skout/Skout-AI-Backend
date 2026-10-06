import type { FastifyReply, FastifyRequest, RouteGenericInterface } from "fastify";
import {
  completeIdempotency,
  copsErrorBody,
  copsErrorStatus,
  hashRequestBody,
  isValidIdempotencyKey,
  reserveIdempotency,
  resolveCorrelationId,
  type IdempotencyStore,
} from "@skout/shared";

/**
 * Wraps a mutating COPS handler with Idempotency-Key rules (Bible p.81). A missing key on a
 * high-impact POST is rejected; a replay returns the stored status and body; a reused key with a
 * different body is rejected. A unique database reservation prevents concurrent duplicate runs.
 */
export function withCopsIdempotency(
  store: IdempotencyStore,
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<{ status: number; body: unknown }>
) {
  return async function copsIdempotentHandler(request: FastifyRequest, reply: FastifyReply) {
    const requestId = resolveCorrelationId(request.headers["x-request-id"]);
    const headerKey = request.headers["idempotency-key"];
    const key = Array.isArray(headerKey) ? headerKey[0] : headerKey;
    const scope = request.workspaceId;
    if (!scope) {
      return reply.status(401).send(
        copsErrorBody({ code: "UNAUTHENTICATED", message: "Missing workspace context", requestId })
      );
    }
    if (!key) {
      return reply.status(copsErrorStatus("VALIDATION_FAILED")).send(
        copsErrorBody({
          code: "VALIDATION_FAILED",
          message: "Idempotency-Key header is required",
          requestId,
          details: { fields: [{ path: "Idempotency-Key", code: "required", message: "Required" }] },
        })
      );
    }
    if (!isValidIdempotencyKey(key)) {
      return reply.status(copsErrorStatus("VALIDATION_FAILED")).send(
        copsErrorBody({
          code: "VALIDATION_FAILED",
          message: "Idempotency-Key must be 8 to 128 characters",
          requestId,
          details: { fields: [{ path: "Idempotency-Key", code: "length", message: "8 to 128 characters" }] },
        })
      );
    }
    // The fingerprint covers method and path as well as the body. Without the path, one key reused
    // on POST /tasks/A/complete and /tasks/B/complete (both empty bodies) would replay A's result
    // for B and B would never run.
    const fingerprint = { method: request.method, path: request.url.split("?")[0], body: request.body ?? null };
    const decision = await reserveIdempotency(store, scope, key, fingerprint);
    if (decision.kind === "conflict") {
      return reply.status(copsErrorStatus("IDEMPOTENCY_KEY_REUSED")).send(
        copsErrorBody({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "This Idempotency-Key was already used with a different request body",
          requestId,
        })
      );
    }
    if (decision.kind === "in_progress") {
      return reply.status(409).send(
        copsErrorBody({
          code: "BUSINESS_STATE_CONFLICT",
          message: "A request with this Idempotency-Key is still in progress",
          requestId,
          retryable: true,
        })
      );
    }
    if (decision.kind === "replay") {
      return reply.status(decision.status).send(decision.response);
    }
    let result: { status: number; body: unknown };
    try {
      result = await handler(request, reply);
    } catch (error) {
      await store.release(scope, key, hashRequestBody(fingerprint));
      throw error;
    }
    await completeIdempotency(store, scope, key, fingerprint, result.status, result.body);
    return reply.status(result.status).send(result.body);
  };
}

const CAPTURED = Symbol("copsCapturedReply");
type CapturedReply = { [CAPTURED]: true; status: number; body: unknown };

/** The subset of a Fastify reply that an idempotent handler may use: status(code).send(body). */
export interface CopsCapturingReply {
  status(code: number): { send(body?: unknown): CapturedReply };
}

/**
 * Adapter so a handler written as `return reply.status(422).send(body)` / `return { data }` can sit
 * behind withCopsIdempotency, which stores and replays `{ status, body }`. A plain return value is
 * a 200. Keeps one idempotency path for every COPS write route.
 */
export function withCopsIdempotentReply<G extends RouteGenericInterface>(
  store: IdempotencyStore,
  handler: (request: FastifyRequest<G>, reply: CopsCapturingReply) => Promise<unknown>
) {
  return withCopsIdempotency(store, async (request) => {
    const capture: CopsCapturingReply = {
      status: (code) => ({ send: (body) => ({ [CAPTURED]: true, status: code, body }) }),
    };
    const out = await handler(request as unknown as FastifyRequest<G>, capture);
    if (out && typeof out === "object" && CAPTURED in out) {
      const captured = out as CapturedReply;
      return { status: captured.status, body: captured.body };
    }
    return { status: 200, body: out };
  });
}
