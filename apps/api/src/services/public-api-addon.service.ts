import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@skout/db";
import { schema } from "@skout/db";
import { HttpError } from "../utils/http.js";
import { subscriptionAccessBlock, SUBSCRIPTION_ENTITLEMENT_KEY } from "./cops-subscription-access.js";
import { notifyPublicKeyChange } from "../lib/public-key-cache.js";

const { workspaceApiSettings, apiTermsAcceptances, entitlements, workspaces, creditTransactions, auditLogs } = schema;

/**
 * Public API add-on (PAPI-020, public API PRD ADD-1 to ADD-5, D2).
 *
 * The add-on is free. `workspace_api_settings.addon_enabled` is the switch; the `api.access`
 * entitlement (ADD-1) is written in the same transaction so entitlement listings show it too.
 */
export const API_ACCESS_ENTITLEMENT_KEY = "api.access";
/** Version of the API terms / acceptable use policy an Owner must accept (ADD-2). Bump on change. */
export const API_TERMS_VERSION = "2026-11-25";

export type LiveKeyBlock =
  | "addon_disabled"
  | "workspace_suspended"
  /** Trial or early-access workspace that hasn't bought credits and has no CustomerOps override (ADD-4). */
  | "live_access_not_enabled";

export interface AddonStatus {
  enabled: boolean;
  enabledAt: string | null;
  disabledReason: string | null;
  currentTermsVersion: string;
  acceptedTermsVersion: string | null;
  canCreateTestKeys: boolean;
  canCreateLiveKeys: boolean;
  liveKeyBlock: LiveKeyBlock | null;
}

async function settingsRow(db: Db, workspaceId: string) {
  const [row] = await db.select().from(workspaceApiSettings).where(eq(workspaceApiSettings.workspaceId, workspaceId)).limit(1);
  return row ?? null;
}

/** True for a workspace still on trial or waiting for early-access approval (ADD-4). */
async function isTrialOrPendingAccess(db: Db, workspaceId: string): Promise<boolean> {
  const [ws] = await db.select({ accessStatus: workspaces.accessStatus }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (ws && (ws.accessStatus === "pending" || ws.accessStatus === "invited")) return true;
  const [sub] = await db
    .select({ value: entitlements.value })
    .from(entitlements)
    .where(and(eq(entitlements.workspaceId, workspaceId), eq(entitlements.key, SUBSCRIPTION_ENTITLEMENT_KEY)))
    .limit(1);
  return (sub?.value as { status?: unknown } | null | undefined)?.status === "trial";
}

async function hasBoughtCredits(db: Db, workspaceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: creditTransactions.id })
    .from(creditTransactions)
    .where(and(eq(creditTransactions.workspaceId, workspaceId), eq(creditTransactions.kind, "purchase")))
    .limit(1);
  return Boolean(row);
}

/**
 * Why this workspace can't create live keys right now, or null if it can (ADD-3, ADD-4).
 * Test keys only need the add-on. The per-user verified-email check happens at key creation.
 */
export async function liveKeyBlock(db: Db, workspaceId: string): Promise<LiveKeyBlock | null> {
  const settings = await settingsRow(db, workspaceId);
  if (!settings?.addonEnabled) return "addon_disabled";
  if (await subscriptionAccessBlock(db, workspaceId)) return "workspace_suspended";
  if (!settings.liveAccessForTrial && (await isTrialOrPendingAccess(db, workspaceId)) && !(await hasBoughtCredits(db, workspaceId))) {
    return "live_access_not_enabled";
  }
  return null;
}

export async function getAddonStatus(db: Db, workspaceId: string): Promise<AddonStatus> {
  const settings = await settingsRow(db, workspaceId);
  const [accepted] = await db
    .select({ version: apiTermsAcceptances.termsVersion })
    .from(apiTermsAcceptances)
    .where(eq(apiTermsAcceptances.workspaceId, workspaceId))
    .orderBy(desc(apiTermsAcceptances.acceptedAt))
    .limit(1);
  const block = await liveKeyBlock(db, workspaceId);
  const enabled = Boolean(settings?.addonEnabled);
  return {
    enabled,
    enabledAt: settings?.addonEnabledAt?.toISOString() ?? null,
    disabledReason: settings?.addonDisabledReason ?? null,
    currentTermsVersion: API_TERMS_VERSION,
    acceptedTermsVersion: accepted?.version ?? null,
    canCreateTestKeys: enabled,
    canCreateLiveKeys: block === null,
    liveKeyBlock: block,
  };
}

/** 403 addon_disabled: every key in a workspace without the add-on is refused (ADD-5). */
export async function assertAddonEnabled(db: Db, workspaceId: string): Promise<void> {
  const settings = await settingsRow(db, workspaceId);
  if (!settings?.addonEnabled) {
    throw new HttpError("addon_disabled", 403, { message: "The API add-on is not enabled for this workspace." });
  }
}

export interface EnableAddonInput {
  workspaceId: string;
  userId: string;
  role: string | undefined;
  /** The terms version the Owner saw and accepted; must be the current one. */
  acceptTerms: boolean;
  termsVersion: string | undefined;
  ip: string | null;
}

/** Owner-only (ADD-2): records the terms acceptance and turns the add-on on. */
export async function enableAddon(db: Db, input: EnableAddonInput): Promise<AddonStatus> {
  if (input.role !== "owner") {
    throw new HttpError("forbidden", 403, { message: "Only the workspace owner can enable the API add-on." });
  }
  if (!input.acceptTerms || input.termsVersion !== API_TERMS_VERSION) {
    throw new HttpError("terms_not_accepted", 422, {
      message: "Accept the current API terms to enable the add-on.",
      current_terms_version: API_TERMS_VERSION,
    });
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(workspaceApiSettings).where(eq(workspaceApiSettings.workspaceId, input.workspaceId)).limit(1);
    await tx.insert(apiTermsAcceptances).values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      termsVersion: API_TERMS_VERSION,
      acceptedAt: now,
      ip: input.ip,
    });
    await tx
      .insert(workspaceApiSettings)
      .values({ workspaceId: input.workspaceId, addonEnabled: true, addonEnabledAt: now, addonEnabledBy: input.userId, updatedAt: now, updatedBy: input.userId })
      .onConflictDoUpdate({
        target: workspaceApiSettings.workspaceId,
        set: { addonEnabled: true, addonEnabledAt: now, addonEnabledBy: input.userId, addonDisabledReason: null, updatedAt: now, updatedBy: input.userId },
      });
    await setAccessEntitlement(tx as unknown as Db, input.workspaceId, true, "self_serve");
    await tx.insert(auditLogs).values({
      workspaceId: input.workspaceId,
      actorId: input.userId,
      action: "api_addon.enabled",
      entityType: "workspace_api_settings",
      entityId: input.workspaceId,
      beforeState: { addon_enabled: Boolean(before?.addonEnabled) },
      afterState: { addon_enabled: true, terms_version: API_TERMS_VERSION },
    });
  });
  await notifyPublicKeyChange({ workspaceId: input.workspaceId });
  return getAddonStatus(db, input.workspaceId);
}

export interface DisableAddonInput {
  workspaceId: string;
  /** The CustomerOps staff member (or system) turning it off. */
  actorId: string | null;
  actorType: "user" | "staff" | "system";
  reason: string;
}

/**
 * Turns the add-on off (ADD-5, used by CustomerOps). Every key in the workspace stops working
 * because the public auth hook checks `assertAddonEnabled` on each request.
 */
export async function disableAddon(db: Db, input: DisableAddonInput): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) throw new HttpError("reason_required", 422, { message: "Give a reason for disabling the API add-on." });
  const now = new Date();
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(workspaceApiSettings).where(eq(workspaceApiSettings.workspaceId, input.workspaceId)).limit(1);
    await tx
      .insert(workspaceApiSettings)
      .values({ workspaceId: input.workspaceId, addonEnabled: false, addonDisabledReason: reason, updatedAt: now })
      .onConflictDoUpdate({ target: workspaceApiSettings.workspaceId, set: { addonEnabled: false, addonDisabledReason: reason, updatedAt: now } });
    await setAccessEntitlement(tx as unknown as Db, input.workspaceId, false, "customerops");
    await tx.insert(auditLogs).values({
      workspaceId: input.workspaceId,
      actorId: input.actorType === "user" ? input.actorId : null,
      actorType: input.actorType,
      actorRef: input.actorType === "user" ? null : input.actorId,
      action: "api_addon.disabled",
      entityType: "workspace_api_settings",
      entityId: input.workspaceId,
      beforeState: { addon_enabled: Boolean(before?.addonEnabled) },
      afterState: { addon_enabled: false },
      reason,
    });
  });
  // ADD-5 / KEY-9: every cached key of the workspace is dropped on every instance.
  await notifyPublicKeyChange({ workspaceId: input.workspaceId });
}

async function setAccessEntitlement(db: Db, workspaceId: string, enabled: boolean, source: string): Promise<void> {
  await db
    .insert(entitlements)
    .values({ workspaceId, key: API_ACCESS_ENTITLEMENT_KEY, value: { enabled }, source, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [entitlements.workspaceId, entitlements.key],
      set: { value: { enabled }, source, updatedAt: new Date() },
    });
}
