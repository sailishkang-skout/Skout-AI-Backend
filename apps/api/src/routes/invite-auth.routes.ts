import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, gt } from "drizzle-orm";
import { schema, scopedTo } from "@skout/db";
import { normalizeEmail } from "@skout/shared";
import { AuthErrorCode, authErrorResponse, linkAuthIdentity } from "@skout/auth";
import { generateOtp, hashOtp, verifyOtp } from "../utils/otp.js";
import { sendMail, buildOtpEmail } from "../services/mail.service.js";
import { errorResponse, HttpError } from "../utils/http.js";
import { hashInviteSessionToken, verifyInviteSession } from "../services/invite-auth.service.js";
import { issueOwnAuthSession } from "./auth-core.routes.js";
import { verifyAccessToken } from "../services/token.service.js";
import { checkPasswordPolicy, hashPassword } from "../services/credential.service.js";
import { logEvent } from "../services/session.service.js";

const OTP_TTL_MS = 10 * 60 * 1000;       // 10 minutes
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function requestMeta(request: FastifyRequest): { ip: string; userAgent?: string } {
  const forwarded = request.headers["x-forwarded-for"];
  const ip = typeof forwarded === "string" ? forwarded.split(",")[0]!.trim() : request.ip || "127.0.0.1";
  const userAgent = typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined;
  return { ip, userAgent };
}

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

      const mail = await sendMail(
        app.config,
        buildOtpEmail({
          to: invite.email,
          otp,
          workspaceName: invite.workspaceName,
          expiresInMinutes: 10,
        })
      );
      if (!mail.sent) {
        return reply
          .code(503)
          .send(errorResponse("Email delivery is not configured — cannot send verification code", 503));
      }

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
      const normalizedEmail = normalizeEmail(invite.email);
      const [existingUser] = await db
        .select({ id: schema.users.id, status: schema.users.status, isBlocked: schema.users.isBlocked })
        .from(schema.users)
        .where(eq(schema.users.email, normalizedEmail))
        .limit(1);

      let userId: string;
      if (existingUser) {
        if (existingUser.status !== "active" || existingUser.isBlocked) {
          return reply
            .code(403)
            .send(authErrorResponse(AuthErrorCode.AUTH_ACCOUNT_BLOCKED, "Account is inactive or blocked", 403));
        }
        userId = existingUser.id;
      } else {
        const [created] = await db
          .insert(schema.users)
          .values({ email: normalizedEmail, fullName: invite.email.split("@")[0], status: "active", isBlocked: false })
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
          scopedTo(schema.workspaceMembers, invite.workspaceId, eq(schema.workspaceMembers.userId, userId))
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

      // Create invite session token (stored hashed in DB — AUTH-BE-26 requirement 3)
      const sessionToken = `isk_${randomBytes(32).toString("hex")}`;
      const sessionExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);
      const sessionTokenHash = hashInviteSessionToken(sessionToken);

      await db.insert(schema.inviteSessions).values({
        userId,
        token: sessionTokenHash,
        expiresAt: sessionExpiresAt,
      });

      // AUTH-BE-26 requirement 2:
      // With custom auth on, complete sign-in as a normal own-auth session (BE-13/BE-14)
      // so the invited user lands authenticated with no second login.
      if (app.config.AUTH_CUSTOM_ENABLED) {
        const meta = requestMeta(request);
        const ownAuth = await issueOwnAuthSession(db, app.config, reply, userId, meta);
        await linkAuthIdentity(db, userId, "password", normalizedEmail, normalizedEmail, now).catch(() => undefined);
        await logEvent(db, app.config, userId, "invite_verify_otp", meta, {
          workspaceId: invite.workspaceId,
          role: invite.role,
          sessionId: ownAuth.sessionId,
        }).catch(() => undefined);

        return reply.send({
          data: {
            accessToken: ownAuth.accessToken,
            expiresIn: ownAuth.expiresIn,
            user: {
              id: userId,
              email: normalizedEmail,
              role: invite.role,
              workspaceId: invite.workspaceId,
            },
            sessionToken,
            sessionExpiresAt: sessionExpiresAt.toISOString(),
            workspaceId: invite.workspaceId,
            role: invite.role,
            email: invite.email,
          },
        });
      }

      // Legacy response when AUTH_CUSTOM_ENABLED is off
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

  // POST /invite-auth/set-password  — protected
  // AUTH-BE-26 requirement 1: writes to user_credentials instead of Clerk when AUTH_CUSTOM_ENABLED is on;
  // keeps the Clerk write when the flag is off.
  app.post<{ Body: { password: string } }>(
    "/invite-auth/set-password",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const db = app.db;
      if (!db) return reply.code(503).send(errorResponse("Database unavailable", 503));

      // Resolve user from request (if set by preHandler) or from Authorization header (isk_ or own-auth access token)
      let userId = request.userId;
      let userEmail = request.userEmail;
      let userWorkspaceId = request.workspaceId;
      let userRole = request.role;

      if (!userId) {
        const authHeader = request.headers.authorization;
        if (authHeader?.startsWith("Bearer ")) {
          const rawToken = authHeader.slice(7);
          if (rawToken.startsWith("isk_")) {
            const session = await verifyInviteSession(db, rawToken);
            if (session) {
              userId = session.userId;
              userEmail = session.email;
              userWorkspaceId = session.workspaceId;
              userRole = session.role;
            }
          } else {
            // Attempt own-auth access token
            try {
              const verified = await verifyAccessToken(rawToken, app.config);
              const [u] = await db
                .select({ id: schema.users.id, email: schema.users.email, status: schema.users.status, isBlocked: schema.users.isBlocked })
                .from(schema.users)
                .where(eq(schema.users.id, verified.sub))
                .limit(1);
              if (u && u.status === "active" && !u.isBlocked) {
                userId = u.id;
                userEmail = u.email;
                const [membership] = await db
                  .select({ workspaceId: schema.workspaceMembers.workspaceId, role: schema.workspaceMembers.role })
                  .from(schema.workspaceMembers)
                  .where(eq(schema.workspaceMembers.userId, u.id))
                  .limit(1);
                userWorkspaceId = membership?.workspaceId;
                userRole = membership?.role;
              }
            } catch {
              // invalid token
            }
          }
        }
      }

      if (!userId || !userEmail) {
        return reply
          .code(401)
          .send(authErrorResponse(AuthErrorCode.AUTH_MISSING_TOKEN, "Unauthorized", 401));
      }

      const { password } = request.body ?? {};
      if (!password) {
        return reply.code(400).send(errorResponse("Password is required", 400));
      }

      // --- When AUTH_CUSTOM_ENABLED is on: write to user_credentials (BE-10/BE-11) ---
      if (app.config.AUTH_CUSTOM_ENABLED) {
        const policy = checkPasswordPolicy(password);
        if (!policy.ok) {
          return reply
            .code(400)
            .send(errorResponse(policy.reasons[0] ?? "Password does not meet policy", 400, policy));
        }

        const hashed = await hashPassword(password);
        const now = new Date();

        await db
          .insert(schema.userCredentials)
          .values({
            userId,
            passwordHash: hashed.hash,
            hashAlgo: hashed.algo,
            hashParams: hashed.params,
            mustReset: false,
            passwordUpdatedAt: now,
          })
          .onConflictDoUpdate({
            target: schema.userCredentials.userId,
            set: {
              passwordHash: hashed.hash,
              hashAlgo: hashed.algo,
              hashParams: hashed.params,
              mustReset: false,
              passwordUpdatedAt: now,
              failedAttempts: 0,
              lockedUntil: null,
            },
          });

        await linkAuthIdentity(db, userId, "password", userEmail, userEmail, now).catch(() => undefined);

        const meta = requestMeta(request);
        await logEvent(db, app.config, userId, "password_set", meta, { source: "invite" }).catch(() => undefined);

        // Issue own-auth session so user has active session tokens
        const ownAuth = await issueOwnAuthSession(db, app.config, reply, userId, meta);

        return reply.send({
          data: {
            message: "Password set. You can now sign in.",
            accessToken: ownAuth.accessToken,
            expiresIn: ownAuth.expiresIn,
            user: {
              id: userId,
              email: userEmail,
              workspaceId: userWorkspaceId,
              role: userRole,
            },
          },
        });
      }

      // --- When AUTH_CUSTOM_ENABLED is off: legacy Clerk write ---
      if (password.length < 8) {
        return reply.code(400).send(errorResponse("Password must be at least 8 characters", 400));
      }

      const secretKey = app.config.CLERK_SECRET_KEY;
      if (!secretKey || secretKey.trim().toLowerCase() === "replace-me") {
        // Dev stub mode — skip Clerk, just confirm
        return reply.send({ data: { message: "Password set (stub mode). Sign in with SSO or email." } });
      }

      try {
        const { createClerkClient } = await import("@clerk/backend");
        const clerk = createClerkClient({ secretKey });

        const { data: existing } = await clerk.users.getUserList({ emailAddress: [userEmail] });

        if (existing[0]) {
          await clerk.users.updateUser(existing[0].id, { password, skipPasswordChecks: true });
        } else {
          await clerk.users.createUser({
            emailAddress: [userEmail],
            password,
            skipPasswordChecks: true,
          });
        }

        return reply.send({ data: { message: "Password set. You can now sign in." } });
      } catch (err: unknown) {
        const clerkErr = err as { errors?: Array<{ longMessage?: string; message?: string }> };
        const msg =
          clerkErr.errors?.[0]?.longMessage ??
          clerkErr.errors?.[0]?.message ??
          (err instanceof Error ? err.message : "Failed to set password");
        app.log.error({ err }, "[set-password] Clerk error");
        throw new HttpError(msg, 400);
      }
    }
  );
}