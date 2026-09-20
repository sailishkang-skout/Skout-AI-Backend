import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema, scopedTo } from "@skout/db";
import type { Db } from "@skout/db";
import { errorResponse } from "../utils/http.js";

const { workspaceSsoConfigs, users, workspaceMembers } = schema;

interface PlannedScimMember {
  email: string;
  clerkUserId: string;
  role: string;
}

/**
 * Applies the real (non-dry-run) half of a SCIM sync: upserts each planned member into Skout's
 * own `users`/`workspace_members` tables — the exact tables `backfill-rbac` reads (per this
 * route's own "next" hint) — so membership/role actually changes, not just gets logged. Additive
 * only, matching backfill-rbac's own "purely additive" precedent (packages/db/src/backfill-rbac.ts):
 * a member dropped from the IdP group is not removed here, to avoid an accidental lockout from a
 * malformed/partial SCIM payload. Clerk organization membership itself is intentionally left
 * alone — there is no existing code path in this repo that creates/updates it, and guessing at
 * Clerk role slugs for a live org would risk a bad write to an external system.
 */
async function applyScimMembers(
  db: Db,
  workspaceId: string,
  planned: PlannedScimMember[]
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  for (const member of planned) {
    const userId = await db.transaction(async (tx) => {
      const [byClerk] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.clerkUserId, member.clerkUserId))
        .limit(1);
      if (byClerk) return byClerk.id;

      const [byEmail] = await tx.select({ id: users.id }).from(users).where(eq(users.email, member.email)).limit(1);
      if (byEmail) {
        await tx
          .update(users)
          .set({ clerkUserId: member.clerkUserId, updatedAt: new Date() })
          .where(eq(users.id, byEmail.id));
        return byEmail.id;
      }

      const [inserted] = await tx
        .insert(users)
        .values({
          email: member.email,
          clerkUserId: member.clerkUserId,
          fullName: member.email.split("@")[0],
          status: "active",
        })
        .onConflictDoUpdate({
          target: users.email,
          set: { clerkUserId: member.clerkUserId, updatedAt: new Date() },
        })
        .returning({ id: users.id });
      return inserted!.id;
    });

    const [existingMembership] = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .limit(1);

    if (existingMembership) {
      if (existingMembership.role !== member.role) {
        await db
          .update(workspaceMembers)
          .set({ role: member.role })
          .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
      }
      updated++;
    } else {
      await db.insert(workspaceMembers).values({ workspaceId, userId, role: member.role });
      created++;
    }
  }

  return { created, updated };
}

/**
 * §11.1 Stage-6 — per-customer SSO/SCIM IdP binding + Clerk membership sync.
 * IdP metadata lives in Clerk; Skout stores the binding so each workspace can be
 * activated at deal time without a code deploy.
 */
const syncSchema = z.object({
  clerkOrgId: z.string().min(1).max(200),
  members: z
    .array(
      z.object({
        clerkUserId: z.string().min(1),
        email: z.string().email(),
        role: z.enum(["owner", "admin", "member", "viewer"]).default("member"),
        groups: z.array(z.string()).optional(),
      })
    )
    .max(500),
  dryRun: z.boolean().optional().default(false),
});

const configSchema = z.object({
  clerkOrgId: z.string().min(1).max(200),
  idpProvider: z.enum(["okta", "azure_ad", "google", "onelogin", "other"]).default("okta"),
  idpConnectionId: z.string().max(200).optional().nullable(),
  idpMetadataUrl: z.string().url().optional().nullable(),
  scimEnabled: z.boolean().optional(),
  groupRoleMap: z.record(z.string()).optional(),
  notes: z.string().max(2000).optional().nullable(),
});

export function mapScimGroupsToRole(groups: string[] | undefined, fallback: string): string {
  const g = (groups ?? []).map((x) => x.toLowerCase());
  if (g.some((x) => x.includes("owner") || x.includes("exec"))) return "owner";
  if (g.some((x) => x.includes("admin"))) return "admin";
  if (g.some((x) => x.includes("viewer") || x.includes("read"))) return "viewer";
  return fallback;
}

export async function ssoScimRoutes(app: FastifyInstance) {
  app.get("/sso/stage6/status", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const [cfg] = await app.db
      .select()
      .from(workspaceSsoConfigs)
      .where(scopedTo(workspaceSsoConfigs, request.workspaceId))
      .limit(1);
    return reply.send({
      data: {
        platformReady: true,
        workspaceBinding: cfg
          ? {
              status: cfg.status,
              clerkOrgId: cfg.clerkOrgId,
              idpProvider: cfg.idpProvider,
              scimEnabled: cfg.scimEnabled,
              activatedAt: cfg.activatedAt?.toISOString() ?? null,
            }
          : null,
        checklist: "docs/ops/sso-stage6-checklist.md",
        skoutProd: {
          deployWorkflow: ".github/workflows/deploy-prod.yml",
          firstDeployChecklist: "docs/ops/skoutprod-first-deploy-checklist.md",
          rbacBackfill: "./scripts/ecs-run-backfill-rbac.sh SkoutProd",
        },
        roleMap: ["owner", "admin", "member", "viewer"],
      },
    });
  });

  app.get("/sso/workspaces/current", async (request, reply) => {
    if (!request.workspaceId || !app.db) return reply.code(401).send(errorResponse("Unauthorized", 401));
    const [cfg] = await app.db
      .select()
      .from(workspaceSsoConfigs)
      .where(scopedTo(workspaceSsoConfigs, request.workspaceId))
      .limit(1);
    return reply.send({ data: cfg ?? null });
  });

  app.put("/sso/workspaces/current", async (request, reply) => {
    if (!request.workspaceId || !request.userId || !app.db) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    if (!request.role || !["owner", "admin"].includes(request.role)) {
      return reply.code(403).send(errorResponse("Requires owner or admin", 403));
    }
    const parsed = configSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(errorResponse("Invalid SSO config", 400, parsed.error.flatten()));
    }
    const now = new Date();
    const [row] = await app.db
      .insert(workspaceSsoConfigs)
      .values({
        workspaceId: request.workspaceId,
        clerkOrgId: parsed.data.clerkOrgId,
        idpProvider: parsed.data.idpProvider,
        idpConnectionId: parsed.data.idpConnectionId ?? null,
        idpMetadataUrl: parsed.data.idpMetadataUrl ?? null,
        scimEnabled: parsed.data.scimEnabled ?? false,
        groupRoleMap: parsed.data.groupRoleMap ?? {
          Owners: "owner",
          Admins: "admin",
          Members: "member",
        },
        notes: parsed.data.notes ?? null,
        status: "pending",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: workspaceSsoConfigs.workspaceId,
        set: {
          clerkOrgId: parsed.data.clerkOrgId,
          idpProvider: parsed.data.idpProvider,
          idpConnectionId: parsed.data.idpConnectionId ?? null,
          idpMetadataUrl: parsed.data.idpMetadataUrl ?? null,
          scimEnabled: parsed.data.scimEnabled ?? false,
          groupRoleMap: parsed.data.groupRoleMap ?? {
            Owners: "owner",
            Admins: "admin",
            Members: "member",
          },
          notes: parsed.data.notes ?? null,
          updatedAt: now,
        },
      })
      .returning();
    return reply.send({ data: row });
  });

  app.post("/sso/workspaces/current/activate", async (request, reply) => {
    if (!request.workspaceId || !request.userId || !app.db) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    if (!request.role || !["owner", "admin"].includes(request.role)) {
      return reply.code(403).send(errorResponse("Requires owner or admin", 403));
    }
    const [cfg] = await app.db
      .select()
      .from(workspaceSsoConfigs)
      .where(scopedTo(workspaceSsoConfigs, request.workspaceId))
      .limit(1);
    if (!cfg) {
      return reply.code(404).send(errorResponse("Save SSO config before activate", 404));
    }
    if (!cfg.idpConnectionId && !cfg.idpMetadataUrl) {
      return reply
        .code(422)
        .send(errorResponse("Activate requires idpConnectionId (Clerk) or idpMetadataUrl", 422));
    }
    const [row] = await app.db
      .update(workspaceSsoConfigs)
      .set({
        status: "active",
        activatedAt: new Date(),
        activatedBy: request.userId,
        updatedAt: new Date(),
      })
      .where(scopedTo(workspaceSsoConfigs, request.workspaceId))
      .returning();
    return reply.send({
      data: row,
      note: "Workspace SSO marked active. Complete IdP bind in Clerk Dashboard if connection id is a placeholder.",
    });
  });

  app.post("/sso/scim/sync-members", async (request, reply) => {
    if (!request.workspaceId || !request.userId || !app.db) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }
    if (!request.role || !["owner", "admin"].includes(request.role)) {
      return reply.code(403).send(errorResponse("Requires owner or admin", 403));
    }

    const parsed = syncSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(errorResponse("Invalid SCIM sync payload", 400, parsed.error.flatten()));
    }

    const [cfg] = await app.db
      .select()
      .from(workspaceSsoConfigs)
      .where(scopedTo(workspaceSsoConfigs, request.workspaceId))
      .limit(1);

    const planned = parsed.data.members.map((m) => ({
      email: m.email,
      clerkUserId: m.clerkUserId,
      role: mapScimGroupsToRole(m.groups, m.role),
    }));

    if (parsed.data.dryRun) {
      return reply.send({
        data: {
          dryRun: true,
          clerkOrgId: parsed.data.clerkOrgId,
          workspaceId: request.workspaceId,
          ssoStatus: cfg?.status ?? "unconfigured",
          planned,
        },
      });
    }

    const { created, updated } = await applyScimMembers(app.db, request.workspaceId, planned);

    app.log.info(
      {
        workspaceId: request.workspaceId,
        clerkOrgId: parsed.data.clerkOrgId,
        count: planned.length,
        created,
        updated,
        ssoStatus: cfg?.status,
      },
      "SCIM member sync applied"
    );

    return reply.code(202).send({
      data: {
        accepted: true,
        clerkOrgId: parsed.data.clerkOrgId,
        workspaceId: request.workspaceId,
        planned,
        applied: { created, updated },
        ssoStatus: cfg?.status ?? "unconfigured",
        next: "Membership applied to workspace_members. Run backfill-rbac to grant RBAC permission rows for any newly-created members.",
      },
    });
  });
}
