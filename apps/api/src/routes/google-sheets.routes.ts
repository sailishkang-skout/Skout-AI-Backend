import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "@skout/db";
import { HttpError, apiError, errorResponse, requireWorkspaceId } from "../utils/http.js";
import { completeSheetsConnection, disconnectSheets, sheetsConnection, startSheetsConnection } from "../services/google-sheets-connection.service.js";
import { cancelSheetPreviews } from "../services/workbook-sheets.service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const completeBody = z.object({ code: z.string().min(1).max(2_000), state: z.string().min(1).max(200) }).strict();

/** What a person is told; the key is the response's code. */
const MESSAGES: Record<string, string> = {
  google_sheets_not_configured: "Google Sheets import isn't set up on this server.",
  invalid_oauth_state: "This sign-in link expired or was already used. Start connecting again.",
  google_permission_not_granted: "Access to your spreadsheets wasn't allowed. Connect again and leave the permission ticked.",
  google_sign_in_failed: "Google didn't complete the sign-in. Start connecting again.",
  google_unavailable: "Google couldn't be reached. Start connecting again shortly.",
};

/**
 * The signed-in member's own Google Sheets connection (WB2-025), managed in Settings. Every route acts on the session's
 * workspace and user only.
 */
export async function googleSheetsRoutes(app: FastifyInstance) {
  const handle =
    (run: (who: { db: Db; workspaceId: string; userId: string }, request: FastifyRequest) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
      const workspaceId = requireWorkspaceId(request);
      // A caller that is not a user has no Google account to connect.
      if (!request.userId || !UUID.test(request.userId)) return reply.status(401).send(errorResponse("unauthorized", 401));
      if (!app.db) return reply.status(503).send(errorResponse("database_unavailable", 503));
      try {
        return reply.send({ data: await run({ db: app.db, workspaceId, userId: request.userId }, request) });
      } catch (error) {
        if (error instanceof HttpError) {
          return reply.status(error.statusCode).send(apiError(error.message, MESSAGES[error.message] ?? error.message, error.statusCode, { requestId: request.id }));
        }
        throw error;
      }
    };

  app.get(
    "/google-sheets/connection",
    handle(({ db, workspaceId, userId }) => sheetsConnection(db, app.config, workspaceId, userId))
  );
  app.post(
    "/google-sheets/connection/start",
    handle(({ db, workspaceId, userId }) => startSheetsConnection(db, app.config, workspaceId, userId))
  );
  app.post(
    "/google-sheets/connection",
    handle(({ db, workspaceId, userId }, request) => completeSheetsConnection(db, app.config, workspaceId, userId, completeBody.parse(request.body ?? {})))
  );
  app.delete(
    "/google-sheets/connection",
    handle(async ({ db, workspaceId, userId }) => {
      const result = await disconnectSheets(db, app.config, workspaceId, userId);
      // Previews hold what was read through this connection and can no longer be confirmed.
      await cancelSheetPreviews(db, app.config, workspaceId, userId);
      return result;
    })
  );
}
