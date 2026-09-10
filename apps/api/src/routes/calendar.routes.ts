import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  getGoogleCalendarConnectUrl,
  handleGoogleCalendarCallback,
  getCalendarConnectionStatus,
  disconnectCalendar,
  listConnectedGoogleCalendarEvents,
} from "../services/google-calendar-oauth.service.js";
import { HttpError, requireWorkspaceId } from "../utils/http.js";

const calendarEventsQuery = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

export async function calendarRoutes(app: FastifyInstance) {
  const db = app.db;

  // GET /calendar/connect/google — returns the Google consent URL as JSON rather than
  // redirecting: this route requires the caller's own Bearer token (like every other
  // authenticated route), which a bare top-level browser navigation can't carry. The
  // frontend calls this via an authenticated fetch, then navigates the browser to the
  // returned URL itself — same shape as the existing Unipile hosted-auth flow.
  app.get("/calendar/connect/google", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const userId = request.userId;
    if (!userId) return reply.status(401).send({ error: "unauthenticated" });
    try {
      const url = getGoogleCalendarConnectUrl(workspaceId, userId, app.config);
      return reply.send({ url });
    } catch (err) {
      if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  // GET /calendar/connect/google/callback
  app.get("/calendar/connect/google/callback", async (request, reply) => {
    const { code, state, error } = request.query as { code?: string; state?: string; error?: string };
    const frontend = (app.config.FRONTEND_URL ?? app.config.CORS_ORIGIN[0] ?? "http://localhost:3000").replace(/\/$/, "");
    // The frontend is served under Next.js basePath "/app" — every route lives at
    // <frontend>/app/... Omitting it here 404'd this redirect even on a successful connect.
    const failUrl = `${frontend}/app/settings/calendar?connected=google_error`;
    if (error || !code || !state || !db) return reply.redirect(failUrl);
    try {
      const { redirectUrl } = await handleGoogleCalendarCallback(code, state, db, app.config);
      return reply.redirect(redirectUrl);
    } catch (err) {
      app.log.error({ err }, "Google calendar OAuth callback failed");
      return reply.redirect(failUrl);
    }
  });

  // GET /calendar/events?from=&to= — overlay for CRM → Calendar. Lives here (not CRM)
  // because calendar_connections and the OAuth tokens are owned by this service.
  app.get("/calendar/events", async (request, reply) => {
    const userId = request.userId;
    if (!userId) return reply.status(401).send({ error: "unauthenticated" });
    if (!db) return reply.send({ data: [], connected: false });

    const query = calendarEventsQuery.parse(request.query);
    const timeMin = new Date(query.from);
    const timeMax = new Date(query.to);
    if (Number.isNaN(timeMin.getTime()) || Number.isNaN(timeMax.getTime())) {
      return reply.status(400).send({ error: "invalid_datetime_range" });
    }

    try {
      const result = await listConnectedGoogleCalendarEvents(
        db,
        requireWorkspaceId(request),
        userId,
        app.config,
        { timeMin, timeMax }
      );
      return reply.send(result);
    } catch (err) {
      app.log.warn({ err }, "Failed to fetch Google Calendar events");
      return reply.send({
        data: [],
        connected: true,
        error: "google_fetch_failed",
      });
    }
  });

  // GET /calendar/connection — status for the current user (frontend settings page)
  app.get("/calendar/connection", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const userId = request.userId;
    if (!userId) return reply.status(401).send({ error: "unauthenticated" });
    if (!db) return reply.send({ connected: false, connectedEmail: null });
    return reply.send(await getCalendarConnectionStatus(db, workspaceId, userId));
  });

  // DELETE /calendar/connection — disconnect the current user's Google Calendar
  app.delete("/calendar/connection", async (request, reply) => {
    const workspaceId = requireWorkspaceId(request);
    const userId = request.userId;
    if (!userId) return reply.status(401).send({ error: "unauthenticated" });
    if (!db) return reply.status(503).send({ error: "database_unavailable" });
    await disconnectCalendar(db, workspaceId, userId);
    return reply.status(204).send();
  });
}
