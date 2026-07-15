import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, gt } from "drizzle-orm";
import { schema } from "@skout/db";
import { generateOtp, hashOtp, verifyOtp } from "../utils/otp.js";
import { sendMail, buildOtpEmail } from "../services/mail.service.js";
import { errorResponse } from "../utils/http.js";

const OTP_TTL_MS = 10 * 60 * 1000;       // 10 minutes
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function inviteAuthRoutes(app: FastifyInstance) {
  // POST /invite-auth/send-otp  — public
  // Validates invite, sends 6-digit OTP to the invite email
  app.post<{ Body: { inviteToken: string } }>(
    "/invite-auth/send-otp",
    async (request, reply) => {
      const { inviteToken } = request.body ?? {};
      if (!inviteToken) return reply.code(400).send(errorResponse("inviteToken is required", 400));

      const db = app.db!;
      const now = new Date();

      const [invite] = await db
        .select({
          id: schema.workspaceInvites.id,
          email: schema.workspaceInvites.email,
          expiresAt: schema.workspaceInvites.expiresAt,
          acceptedAt: schema.workspaceInvites.acceptedAt,
          workspaceName: schema.workspaces.name,
        })
        .from(schema.workspaceInvites)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.workspaceInvites.workspaceId))
        .where(eq(schema.workspaceInvites.token, inviteToken))
        .limit(1);

      if (!invite) return reply.code(404).send(errorResponse("Invite not found", 404));
      if (invite.acceptedAt) return reply.code(409).send(errorResponse("Invite already accepted", 409));
      if (now > invite.expiresAt) return reply.code(410).send(errorResponse("Invite has expired", 410));

      const otp = generateOtp();
      const expiresAt = new Date(now.getTime() + OTP_TTL_MS);

      await db.insert(schema.inviteOtps).values({
        inviteToken,
        otpHash: hashOtp(otp),
        expiresAt,
      });

      await sendMail(
        app.config,
        buildOtpEmail({
          to: invite.email,
          otp,
          workspaceName: invite.workspaceName,
          expiresInMinutes: 10,
        })
      );

      return reply.send({ data: { email: invite.email, expiresInMinutes: 10 } });
    }
  );

  // POST /invite-auth/verify-otp  — public
  // Verifies OTP, provisions user, auto-accepts invite, returns session token
  app.post<{ Body: { inviteToken: string; otp: string } }>(
    "/invite-auth/verify-otp",
    async (request, reply) => {
      const { inviteToken, otp } = request.body ?? {};
      if (!inviteToken || !otp) {
        return reply.code(400).send(errorResponse("inviteToken and otp are required", 400));
      }

      const db = app.db!;
      const now = new Date();

      const [invite] = await db
        .select()
        .from(schema.workspaceInvites)
        .where(eq(schema.workspaceInvites.token, inviteToken))
        .limit(1);

      if (!invite) return reply.code(404).send(errorResponse("Invite not found", 404));
      if (invite.acceptedAt) return reply.code(409).send(errorResponse("Invite already accepted", 409));
      if (now > invite.expiresAt) return reply.code(410).send(errorResponse("Invite has expired", 410));

      // Find valid unused OTP
      const otpRows = await db
        .select()
        .from(schema.inviteOtps)
        .where(
          and(
            eq(schema.inviteOtps.inviteToken, inviteToken),
            eq(schema.inviteOtps.used, false),
            gt(schema.inviteOtps.expiresAt, now)
          )
        );

      const validOtp = otpRows.find((row) => verifyOtp(otp, row.otpHash));
      if (!validOtp) {
        return reply.code(401).send(errorResponse("Invalid or expired verification code", 401));
      }

      // Mark OTP used
      await db
        .update(schema.inviteOtps)
        .set({ used: true })
        .where(eq(schema.inviteOtps.id, validOtp.id));

      // Provision user (create if not exists)
      const [existingUser] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, invite.email.toLowerCase()))
        .limit(1);

      let userId: string;
      if (existingUser) {
        userId = existingUser.id;
      } else {
        const [created] = await db
          .insert(schema.users)
          .values({ email: invite.email.toLowerCase(), fullName: invite.email.split("@")[0], status: "active", isBlocked: false })
          .onConflictDoUpdate({ target: schema.users.email, set: { updatedAt: new Date() } })
          .returning({ id: schema.users.id });
        if (!created) return reply.code(500).send(errorResponse("Failed to create user", 500));
        userId = created.id;
      }

      // Add to workspace (idempotent)
      const [alreadyMember] = await db
        .select({ userId: schema.workspaceMembers.userId })
        .from(schema.workspaceMembers)
        .where(
          and(
            eq(schema.workspaceMembers.workspaceId, invite.workspaceId),
            eq(schema.workspaceMembers.userId, userId)
          )
        )
        .limit(1);

      if (!alreadyMember) {
        await db.insert(schema.workspaceMembers).values({
          workspaceId: invite.workspaceId,
          userId,
          role: invite.role,
        });
      }

      // Mark invite accepted
      await db
        .update(schema.workspaceInvites)
        .set({ acceptedAt: now })
        .where(eq(schema.workspaceInvites.id, invite.id));

      // Create invite session token
      const sessionToken = `isk_${randomBytes(32).toString("hex")}`;
      const sessionExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);

      await db.insert(schema.inviteSessions).values({
        userId,
        token: sessionToken,
        expiresAt: sessionExpiresAt,
      });

      return reply.send({
        data: {
          sessionToken,
          sessionExpiresAt: sessionExpiresAt.toISOString(),
          workspaceId: invite.workspaceId,
          role: invite.role,
          email: invite.email,
        },
      });
    }
  );
}
