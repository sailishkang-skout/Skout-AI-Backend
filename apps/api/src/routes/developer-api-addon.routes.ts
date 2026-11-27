import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireWorkspaceId } from "../utils/http.js";
import { API_TERMS_VERSION, enableAddon, getAddonStatus } from "../services/public-api-addon.service.js";

const enableBody = z.object({
  accept_terms: z.literal(true, { errorMap: () => ({ message: "Accept the API terms to enable the add-on" }) }),
  terms_version: z.string().min(1).max(40),
});

/**
 * PAPI-020: Settings → Developers, the API add-on (ADD-1 to ADD-4). App-side, session auth.
 * - GET  /api/v1/developer/api-addon         status for any member
 * - POST /api/v1/developer/api-addon/enable  Owner only; accepts the current API terms
 */
export async function developerApiAddonRoutes(app: FastifyInstance) {
  app.get("/developer/api-addon", async (request) => {
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) throw new HttpError("Database unavailable", 503);
    return getAddonStatus(app.db, workspaceId, request.userId ?? undefined);
  });

  app.post("/developer/api-addon/enable", async (request) => {
    const workspaceId = requireWorkspaceId(request);
    if (!app.db) throw new HttpError("Database unavailable", 503);
    const role = (request as { role?: string }).role;
    if (role !== "owner") {
      throw new HttpError("Only the workspace owner can enable the API add-on", 403);
    }
    const parsed = enableBody.safeParse(request.body ?? {});
    if (!parsed.success || parsed.data.terms_version !== API_TERMS_VERSION) {
      throw new HttpError("Accept the current API terms to enable the add-on", 422, {
        current_terms_version: API_TERMS_VERSION,
      });
    }
    const userId = (request as { userId?: string }).userId;
    if (!userId) throw new HttpError("Missing user context", 401);
    return enableAddon(app.db, {
      workspaceId,
      userId,
      role,
      acceptTerms: parsed.data.accept_terms,
      termsVersion: parsed.data.terms_version,
      ip: request.ip ?? null,
    });
  });
}
