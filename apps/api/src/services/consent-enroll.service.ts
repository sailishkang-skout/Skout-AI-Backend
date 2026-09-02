import { eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import type { Env } from "../config/env.js";
import { buildConsentService } from "./consent.service.js";

const { listMembers } = schema;

export async function resolveEnrollProspectIds(
  db: Db,
  input: { prospectIds?: string[]; listId?: string }
): Promise<string[]> {
  const idSet = new Set<string>(input.prospectIds ?? []);
  if (input.listId) {
    const members = await db
      .select({ prospectId: listMembers.prospectId })
      .from(listMembers)
      .where(eq(listMembers.listId, input.listId));
    for (const m of members) idSet.add(m.prospectId);
  }
  return [...idSet];
}

/** §5.1 / §16 — consent gate + audit recording for sequence enroll paths (prospectIds and listId). */
export async function gateEnrollConsent(
  db: Db,
  config: Env,
  opts: {
    workspaceId: string;
    prospectIds?: string[];
    listId?: string;
    consentBasis?: string;
    recordedBy?: string;
  }
): Promise<{ ok: true } | { ok: false; missingConsentProspectIds: string[] }> {
  const ids = await resolveEnrollProspectIds(db, opts);
  if (ids.length === 0) return { ok: true };

  const consentSvc = buildConsentService(db);
  if (!consentSvc) return { ok: true };

  const missing: string[] = [];
  for (const prospectId of ids) {
    const active = await consentSvc.hasActive(opts.workspaceId, "prospect", prospectId, "email");
    if (!active) missing.push(prospectId);
  }

  if (missing.length === 0) return { ok: true };

  if (opts.consentBasis) {
    for (const prospectId of missing) {
      await consentSvc.record({
        workspaceId: opts.workspaceId,
        subjectType: "prospect",
        subjectId: prospectId,
        type: "email",
        basis: opts.consentBasis,
        recordedBy: opts.recordedBy,
      });
    }
    return { ok: true };
  }

  if (config.CONSENT_ENFORCEMENT_ENABLED) {
    return { ok: false, missingConsentProspectIds: missing };
  }

  return { ok: true };
}
