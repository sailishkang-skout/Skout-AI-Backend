import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "@skout/db";
import { assertPermission } from "@skout/auth";
import { copsIdempotencyStore } from "../services/cops-platform.service.js";
import { withCopsIdempotency } from "../services/cops-idempotent.js";
import { WorkbookV2Error, type WorkbookActor } from "../services/workbook-v2.service.js";
import { HttpError, apiError, requireWorkspaceId } from "../utils/http.js";

/** What every Workbooks V2 route shares: who is asking, what they may do, errors and idempotency. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Viewing needs `enrichment:read`; creating or changing anything needs `enrichment:capture` (manage enrichment data). */
export type WorkbookPermission = "enrichment:read" | "enrichment:capture";
export type Outcome = { status: number; body: unknown };
export type WorkbookAuth = { db: Db; actor: WorkbookActor };

export function workbookRouteHelpers(app: FastifyInstance) {
  /** The workspace and user come from the authenticated session only, never from the request payload. */
  async function authorize(request: FastifyRequest, permission: WorkbookPermission): Promise<WorkbookAuth> {
    if (!app.db) throw new HttpError("database_unavailable", 503);
    const workspaceId = requireWorkspaceId(request);
    if (!request.userId) throw new HttpError("unauthorized", 401);
    await assertPermission(app.db, workspaceId, request.userId, permission);
    return { db: app.db, actor: { workspaceId, userId: UUID.test(request.userId) ? request.userId : null } };
  }

  function sendError(request: FastifyRequest, reply: FastifyReply, error: unknown) {
    if (!(error instanceof WorkbookV2Error)) throw error;
    return reply.status(error.statusCode).send(apiError(error.code, error.message, error.statusCode, { requestId: request.id, details: error.details }));
  }

  /** Runs a handler and turns workbook errors into the standard error envelope. */
  const handle = (run: (request: FastifyRequest) => Promise<Outcome>) => async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const out = await run(request);
      return reply.status(out.status).send(out.body);
    } catch (error) {
      return sendError(request, reply, error);
    }
  };

  /**
   * For requests that make something new: with an `Idempotency-Key` header, a retried or double-submitted request
   * replays the first answer instead of making a second copy. Permission is checked first, so a stored answer is
   * never replayed to someone who may not make the request.
   */
  const handleOnce = (run: (request: FastifyRequest, auth: WorkbookAuth) => Promise<Outcome>) => async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await authorize(request, "enrichment:capture");
    if (request.headers["idempotency-key"] === undefined) return handle((req) => run(req, auth))(request, reply);
    try {
      return await withCopsIdempotency(copsIdempotencyStore(auth.db), (req) => run(req, auth))(request, reply);
    } catch (error) {
      return sendError(request, reply, error);
    }
  };

  return { authorize, handle, handleOnce };
}
