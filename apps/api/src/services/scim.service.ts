import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { and, eq, like, or } from "drizzle-orm";
import { z } from "zod";
import { schema, scopedTo } from "@skout/db";
import type { Db } from "@skout/db";
import { deprovisionUser } from "./saml.service.js";
import type { Env } from "../config/env.js";
import { HttpError, errorResponse } from "../utils/http.js";
import { parse, filter as createScimFilter } from "scim2-parse-filter";
import { getRedis } from "../lib/redis.js";

const { users, workspaceMembers, workspaceSsoConfigs } = schema;

// SCIM 2.0 constants
const SCIM_BASE = "/scim/v2";
const SCIM_CONTENT_TYPE = "application/scim+json";

// SCIM schema URIs
export const SCIM_SCHEMAS = {
  USER: "urn:ietf:params:scim:schemas:core:2.0:User",
  GROUP: "urn:ietf:params:scim:schemas:core:2.0:Group",
  LIST_RESPONSE: "urn:ietf:params:scim:api:messages:2.0:ListResponse",
  ERROR: "urn:ietf:params:scim:api:messages:2.0:Error",
};

// Schema to validate SCIM bearer token auth
async function validateScimAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  workspaceId: string,
  db: Db,
  config: Env
): Promise<boolean> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    reply.code(401).send(errorResponse("Missing or invalid authorization header", 401));
    return false;
  }

  const token = authHeader.slice(7);
  
  // Get workspace SSO config to check SCIM token
  const [ssoConfig] = await db
      .select({ 
          // @ts-ignore
          scimApiToken: workspaceSsoConfigs.scimApiToken,
          // @ts-ignore
          scimEnabled: workspaceSsoConfigs.scimEnabled
      })
      .from(workspaceSsoConfigs)
      .where(eq(workspaceSsoConfigs.workspaceId, workspaceId))
      .limit(1);

  if (!ssoConfig || !ssoConfig.scimApiToken || ssoConfig.scimApiToken !== token) {
    reply.code(401).send(errorResponse("Invalid SCIM API token", 401));
    return false;
  }

  // Check if SCIM is enabled for this workspace
  if (!ssoConfig.scimEnabled) {
    reply.code(403).send(errorResponse("SCIM is not enabled for this workspace", 403));
    return false;
  }

  return true;
}

// Convert internal user to SCIM user format
function toScimUser(user: any, membership: any) {
  return {
    schemas: [SCIM_SCHEMAS.USER],
    id: user.id,
    userName: user.email,
    displayName: user.fullName,
    active: user.status === "active" && !user.isBlocked,
    emails: [
      {
        value: user.email,
        primary: true,
      },
    ],
    meta: {
      resourceType: "User",
      created: user.createdAt.toISOString(),
      lastModified: user.updatedAt.toISOString(),
    },
  };
}

// Convert internal group to SCIM group format
function toScimGroup(role: string, members: any[]) {
  return {
    schemas: [SCIM_SCHEMAS.GROUP],
    id: role,
    displayName: role,
    members: members.map((m) => ({
      value: m.userId,
      display: m.userEmail,
    })),
    meta: {
      resourceType: "Group",
    },
  };
}

export async function registerScimRoutes(app: FastifyInstance) {
  // SCIM Users endpoint - GET /api/v1/scim/v2/Users
  app.get(`${SCIM_BASE}/Users`, async (request, reply) => {
    const workspaceId = request.workspaceId;
    if (!workspaceId || !app.db) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }

    const isAuthorized = await validateScimAuth(request, reply, workspaceId, app.db, app.config as Env);
    if (!isAuthorized) return;

    const db = app.db as Db;
    // @ts-ignore - filter and startIndex from query
    const { filter, startIndex = 1, count = 100 } = request.query;

    // Get all workspace members
    const allMembers = await db
      .select({
        userId: workspaceMembers.userId,
        userEmail: users.email,
        role: workspaceMembers.role,
        id: users.id,
        clerkUserId: users.clerkUserId,
        fullName: users.fullName,
        phone: users.phone,
        status: users.status,
        isBlocked: users.isBlocked,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(scopedTo(workspaceMembers, workspaceId));

    // Apply SCIM filter if provided
    let filteredMembers = allMembers;
    if (filter) {
      try {
        const ast = parse(filter);
        const filterFn = createScimFilter(ast);
        filteredMembers = allMembers.filter((m) => filterFn({ ...m, userName: m.userEmail }));
      } catch (err) {
        return reply.code(400).send({
          schemas: [SCIM_SCHEMAS.ERROR],
          status: "400",
          detail: "Invalid filter syntax",
        });
      }
    }

    // Apply pagination
    const start = Number(startIndex) - 1;
    const end = start + Number(count);
    const paginatedMembers = filteredMembers.slice(start, end);

    // Convert to SCIM format
    const resources = paginatedMembers.map((m) => toScimUser(m, m));

    reply.type(SCIM_CONTENT_TYPE).send({
      schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
      totalResults: filteredMembers.length,
      itemsPerPage: paginatedMembers.length,
      startIndex: Number(startIndex),
      resources,
    });
  });

  // SCIM Get single user endpoint - GET /api/v1/scim/v2/Users/:id
  app.get(`${SCIM_BASE}/Users/:id`, async (request, reply) => {
    const workspaceId = request.workspaceId;
    if (!workspaceId || !app.db) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }

    const isAuthorized = await validateScimAuth(request, reply, workspaceId, app.db, app.config as Env);
    if (!isAuthorized) return;

    const db = app.db as Db;
    // @ts-ignore - id from params
    const userId = request.params.id;

    const [member] = await db
      .select({
        userId: workspaceMembers.userId,
        id: users.id,
        clerkUserId: users.clerkUserId,
        email: users.email,
        fullName: users.fullName,
        phone: users.phone,
        status: users.status,
        isBlocked: users.isBlocked,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(and(scopedTo(workspaceMembers, workspaceId), eq(users.id, userId)))
      .limit(1);

    if (!member) {
      return reply.code(404).send({
        schemas: [SCIM_SCHEMAS.ERROR],
        status: "404",
        detail: "User not found",
      });
    }

    reply.type(SCIM_CONTENT_TYPE).send(toScimUser(member, member));
  });

  // SCIM Update user endpoint - PATCH /api/v1/scim/v2/Users/:id
  app.patch(`${SCIM_BASE}/Users/:id`, async (request, reply) => {
    const workspaceId = request.workspaceId;
    if (!workspaceId || !app.db) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }

    const isAuthorized = await validateScimAuth(request, reply, workspaceId, app.db, app.config as Env);
    if (!isAuthorized) return;

    const db = app.db as Db;
    // @ts-ignore - id from params
    const userId = request.params.id;
    // SCIM patch operation body type
    interface ScimPatchOperation {
      op: string;
      path?: string;
      value?: unknown;
    }
    interface ScimPatchBody {
      Operations: ScimPatchOperation[];
    }
    const patchBody = request.body as ScimPatchBody;

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      return reply.code(404).send({
        schemas: [SCIM_SCHEMAS.ERROR],
        status: "404",
        detail: "User not found",
      });
    }

    // Process patch operations (simplified - handle active status change for deprovisioning)
    if (patchBody.Operations) {
      for (const op of patchBody.Operations) {
        if (op.op === "replace" && op.path === "active") {
          const isActive = op.value;
          if (!isActive) {
            // Deprovision the user - revoke all sessions, mark as blocked, remove from workspace
            await deprovisionUser(db, app.config as Env, userId, workspaceId);
          }
        }
      }
    }

    // Return the updated user
    const [updatedUser] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    reply.type(SCIM_CONTENT_TYPE).send(toScimUser(updatedUser, updatedUser));
  });

  // SCIM Groups endpoint - GET /api/v1/scim/v2/Groups
  app.get(`${SCIM_BASE}/Groups`, async (request, reply) => {
    const workspaceId = request.workspaceId;
    if (!workspaceId || !app.db) {
      return reply.code(401).send(errorResponse("Unauthorized", 401));
    }

    const isAuthorized = await validateScimAuth(request, reply, workspaceId, app.db, app.config as Env);
    if (!isAuthorized) return;

    const db = app.db as Db;

    // Get all members grouped by role
    const allMembers = await db
      .select({
        userId: workspaceMembers.userId,
        userEmail: users.email,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(workspaceMembers.userId, users.id))
      .where(scopedTo(workspaceMembers, workspaceId));

    const groupsMap = new Map<string, any[]>();
    for (const member of allMembers) {
      if (!groupsMap.has(member.role)) {
        groupsMap.set(member.role, []);
      }
      groupsMap.get(member.role)!.push(member);
    }

    const resources = Array.from(groupsMap.entries()).map(([role, members]) =>
      toScimGroup(role, members)
    );

    reply.type(SCIM_CONTENT_TYPE).send({
      schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
      totalResults: resources.length,
      itemsPerPage: resources.length,
      startIndex: 1,
      resources,
    });
  });
}