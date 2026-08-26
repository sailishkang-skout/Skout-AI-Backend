import type { Env } from "../config/env.js";

/**
 * §5 / §7.1 — HTTP client for apps/crm internal API.
 * Returns null when CRM_INTERNAL_BASE_URL or INTERNAL_SERVICE_TOKEN is unset (SQL fallback).
 */
export function buildCrmInternalClient(config: Env) {
  const base = config.CRM_INTERNAL_BASE_URL?.replace(/\/$/, "");
  const token = config.INTERNAL_SERVICE_TOKEN;
  if (!base || !token) return null;

  async function getJson<T>(path: string, workspaceId: string): Promise<T | null> {
    const res = await fetch(`${base}${path}`, {
      headers: {
        "X-Internal-Service-Token": token!,
        "X-Workspace-Id": workspaceId,
        Accept: "application/json",
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`crm_internal_${res.status}`);
    }
    const body = (await res.json()) as { data: T };
    return body.data;
  }

  return {
    getContactById(workspaceId: string, id: string) {
      return getJson<Record<string, unknown>>(`/internal/v1/contacts/${id}`, workspaceId);
    },
    getContactByProspectId(workspaceId: string, prospectId: string) {
      return getJson<Record<string, unknown>>(
        `/internal/v1/contacts/by-prospect/${encodeURIComponent(prospectId)}`,
        workspaceId
      );
    },
    getCompanyById(workspaceId: string, id: string) {
      return getJson<Record<string, unknown>>(`/internal/v1/companies/${id}`, workspaceId);
    },
    getDealSummary(workspaceId: string, id: string) {
      return getJson<Record<string, unknown>>(`/internal/v1/deals/${id}/summary`, workspaceId);
    },
  };
}
