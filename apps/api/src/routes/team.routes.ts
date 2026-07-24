import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { createTeamService } from "../services/team.service.js";
import { sendMail, buildInviteEmail } from "../services/mail.service.js";
import { errorResponse, HttpError } from "../utils/http.js";
import type { WorkspaceRole } from "../services/team.service.js";

export async function teamRoutes(app: FastifyInstance) {
  function teamSvc() {
    if (!app.db) throw new HttpError("Database not available", 500);
    return createTeamService(app.db);
  }

  // ── Members ───────────────────────────────────────────────────────────────

  // GET /team/members — list all members (any authenticated member)
  app.get("/team/members", async (request, reply) => {
    if (!request.workspaceId) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const members = await teamSvc().listMembers(request.workspaceId);
    return reply.send({ data: members });
  });

  // PATCH /team/members/:userId/role — update a member's role (owner only)
  app.patch<{ Params: { userId: string }; Body: { role: WorkspaceRole } }>(
    "/team/members/:userId/role",
    async (request, reply) => {
      if (!request.workspaceId || !request.userId) {
        return reply.code(401).send(errorResponse("Unauthorized", 401));
      }
      const { role } = request.body;
      const updated = await teamSvc().updateMemberRole(
        request.workspaceId,
        request.params.userId,
        role,
        request.userId,
        request.role
      );
      return reply.send({ data: updated });
    }
  );

  // DELETE /team/members/:userId — remove a member (owner or admin)
  app.delete<{ Params: { userId: string } }>(
    "/team/members/:userId",
    async (request, reply) => {
      if (!request.workspaceId || !request.userId) {
        return reply.code(401).send(errorResponse("Unauthorized", 401));
      }
      await teamSvc().removeMember(
        request.workspaceId,
        request.params.userId,
        request.userId,
        request.role
      );
      return reply.code(204).send();
    }
  );

  // ── Invites ───────────────────────────────────────────────────────────────

  // GET /team/invites — list pending invites (owner or admin)
  app.get("/team/invites", async (request, reply) => {
    if (!request.workspaceId || !request.role) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    if (!["owner", "admin"].includes(request.role)) {
      return reply.code(403).send(errorResponse("Requires role: owner or admin", 403));
    }
    const invites = await teamSvc().listPendingInvites(request.workspaceId);
    return reply.send({ data: invites });
  });

  // POST /team/invites — create invite (owner or admin)
  app.post<{ Body: { email: string; role: WorkspaceRole } }>(
    "/team/invites",
    async (request, reply) => {
      if (!request.workspaceId || !request.userId) {
        return reply.code(401).send(errorResponse("Unauthorized", 401));
      }
      const { email, role } = request.body;
      if (!email || typeof email !== "string") {
        return reply.code(400).send(errorResponse("email is required", 400));
      }

      const svc = teamSvc();
      const invite = await svc.inviteMember(
        request.workspaceId,
        request.userId,
        email,
        role ?? "member",
        request.role
      );

      const baseUrl = app.config.INVITE_BASE_URL ?? app.config.FRONTEND_URL ?? "http://localhost:3000";
      const acceptUrl = `${baseUrl}/invite/${invite.token}`;

      const [ws] = await app.db!
        .select({ name: schema.workspaces.name })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, request.workspaceId))
        .limit(1);

      let emailSent = false;
      let emailError: string | undefined;
      try {
        const mail = await sendMail(
          app.config,
          buildInviteEmail({
            to: invite.email,
            inviterName: request.userEmail ?? "A teammate",
            workspaceName: ws?.name ?? "Skout workspace",
            role: invite.role,
            acceptUrl,
          })
        );
        emailSent = mail.sent;
        if (!emailSent) {
          emailError = "Email delivery is not configured on this environment";
        }
      } catch (err: unknown) {
        app.log.warn({ err }, "Failed to send invite email");
        const msg = err instanceof Error ? err.message : "Email send failed";
        // Surface a short reason for sandbox / verification failures.
        if (/not verified/i.test(msg)) {
          emailError =
            "SES rejected the send (sandbox): From and/or recipient must be a verified identity";
        } else {
          emailError = "Email send failed — use the invite link below";
        }
      }

      return reply.code(201).send({
        data: {
          email: invite.email,
          role: invite.role,
          expiresAt: invite.expiresAt.toISOString(),
          acceptUrl,
          emailSent,
          ...(emailError ? { emailError } : {}),
        },
      });
    }
  );

  // GET /team/invites/:token — get invite details (PUBLIC — no auth needed, checked in isPublicRoute)
  app.get<{ Params: { token: string } }>(
    "/team/invites/:token",
    async (request, reply) => {
      const invite = await teamSvc().getInviteByToken(request.params.token);
      if (!invite) return reply.code(404).send(errorResponse("Invite not found", 404));
      return reply.send({ data: invite });
    }
  );

  // POST /team/invites/:token/accept — accept invite (authenticated)
  app.post<{ Params: { token: string } }>(
    "/team/invites/:token/accept",
    async (request, reply) => {
      if (!request.userId || !request.userEmail) {
        return reply.code(401).send(errorResponse("You must be signed in to accept an invite.", 401));
      }
      const result = await teamSvc().acceptInvite(
        request.params.token,
        request.userId,
        request.userEmail
      );
      return reply.send({ data: result });
    }
  );

  // DELETE /team/invites/:inviteId — revoke invite (owner or admin)
  app.delete<{ Params: { inviteId: string } }>(
    "/team/invites/:inviteId",
    async (request, reply) => {
      if (!request.workspaceId) {
        return reply.code(401).send(errorResponse("Unauthorized", 401));
      }
      await teamSvc().revokeInvite(request.workspaceId, request.params.inviteId, request.role);
      return reply.code(204).send();
    }
  );
}
