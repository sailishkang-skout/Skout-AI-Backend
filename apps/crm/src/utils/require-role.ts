import type { FastifyRequest } from "fastify";
import { HttpError } from "@skout/auth";

/**
 * Guards a route to workspace members whose role is in `allowedRoles`.
 * `request.role` is populated by the auth plugin from `workspace_members.role`.
 * Role values are "owner" | "admin" | "member" — owner/admin assignment happens via
 * apps/api's team invite flow (team.routes.ts / team.service.ts, workspace_invites
 * table), which writes to the same workspace_members.role column this reads.
 */
export function requireRole(request: FastifyRequest, allowedRoles: string[]): void {
  if (!request.role || !allowedRoles.includes(request.role)) {
    throw new HttpError("forbidden", 403, { requiredRoles: allowedRoles });
  }
}
