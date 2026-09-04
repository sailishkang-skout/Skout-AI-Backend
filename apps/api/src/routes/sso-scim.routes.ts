import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema, scopedTo } from "@skout/db";
import { errorResponse } from "../utils/http.js";

const { workspaceSsoConfigs } = schema;

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

    app.log.info(
      {
        workspaceId: request.workspaceId,
        clerkOrgId: parsed.data.clerkOrgId,
        count: planned.length,
        ssoStatus: cfg?.status,
      },
      "SCIM member sync accepted"
    );

    return reply.code(202).send({
      data: {
        accepted: true,
        clerkOrgId: parsed.data.clerkOrgId,
        workspaceId: request.workspaceId,
        planned,
        ssoStatus: cfg?.status ?? "unconfigured",
        next: "Members continue via Clerk org membership; run backfill-rbac after first SCIM sync.",
      },
    });
  });
}
