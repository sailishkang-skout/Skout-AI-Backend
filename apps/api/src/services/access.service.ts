import { createHash, randomInt } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { postCreditTransaction, schema, type Db } from "@skout/db";
import { invalidateWorkspaceAccess } from "@skout/auth";
import { PRODUCT_FEATURES, type PlanPresetCode, type ProductFeature } from "@skout/shared";
import { EntitlementsService } from "./entitlements.service.js";
import { writeCopsAudit } from "./cops-platform.service.js";

/**
 * Early access approval (docs/superpowers/specs/2026-11-17-early-access-approval-design.md).
 * A self-signup workspace starts pending with an access request. COPS approves it (plan, credits,
 * feature switches) which emails a single-use invite code; redeeming the code makes it active.
 */

const { accessRequests, workspaces } = schema;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const INVITE_CODE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SOURCE = "cops-access";

export type AccessErrorCode = "NOT_FOUND" | "BUSINESS_STATE_CONFLICT" | "VALIDATION_FAILED";

export class AccessError extends Error {
  constructor(
    readonly code: AccessErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "AccessError";
  }

  get status(): number {
    return this.code === "NOT_FOUND" ? 404 : this.code === "VALIDATION_FAILED" ? 422 : 409;
  }
}

/** Uppercase, letters and digits only: "abcd-efgh" and " ABCD EFGH " are the same code. */
function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashInviteCode(input: string): string {
  return createHash("sha256").update(normalizeCode(input)).digest("hex");
}

export function generateInviteCode(): { code: string; hash: string } {
  let raw = "";
  for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  return { code, hash: hashInviteCode(code) };
}

export interface AccessContext {
  /** The Skout (operator) workspace the COPS caller works in; the audit row lives there. */
  operatorWorkspaceId: string;
  actorId: string;
  requestId: string;
}

export interface AccessDeps {
  /** Sends the invite code; returns whether it was sent. Never throws into the caller. */
  sendEmail: (to: string, code: string, expiresAt: Date) => Promise<boolean>;
}

export interface ApproveInput {
  plan: PlanPresetCode;
  credits: number;
  features: Record<ProductFeature, boolean>;
  note?: string;
}

type AccessRequestRow = typeof accessRequests.$inferSelect;

async function loadRequest(tx: Db, id: string, lock = false): Promise<AccessRequestRow> {
  const q = tx.select().from(accessRequests).where(eq(accessRequests.id, id)).limit(1);
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw new AccessError("NOT_FOUND", "Access request not found");
  return row;
}

async function workspaceStatusOf(tx: Db, workspaceId: string) {
  const [ws] = await tx.select({ status: workspaces.accessStatus }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update").limit(1);
  if (!ws) throw new AccessError("NOT_FOUND", "Workspace not found");
  return ws.status;
}

async function setWorkspaceStatus(tx: Db, workspaceId: string, status: "pending" | "invited" | "active" | "rejected") {
  await tx.update(workspaces).set({ accessStatus: status, updatedAt: new Date() }).where(eq(workspaces.id, workspaceId));
}

/** Writes plan.code and every feature.<key> switch for a workspace. */
export async function applyPlanAndFeatures(
  tx: Db,
  workspaceId: string,
  change: { plan?: PlanPresetCode; features?: Partial<Record<ProductFeature, boolean>> }
): Promise<void> {
  const ent = new EntitlementsService(tx);
  if (change.plan) await ent.set(workspaceId, "plan.code", change.plan, SOURCE);
  for (const f of PRODUCT_FEATURES) {
    const on = change.features?.[f];
    if (typeof on === "boolean") await ent.set(workspaceId, `feature.${f}`, on, SOURCE);
  }
}

/** The pending user's own answers (company, role, use case). Refused once the workspace is active. */
export async function submitAccessRequest(
  db: Db,
  input: { workspaceId: string; userId: string; company: string; roleTitle: string; useCase?: string | null }
): Promise<AccessRequestRow> {
  const [ws] = await db.select({ status: workspaces.accessStatus }).from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1);
  if (!ws) throw new AccessError("NOT_FOUND", "Workspace not found");
  if (ws.status === "active") throw new AccessError("BUSINESS_STATE_CONFLICT", "This workspace already has access");
  const [row] = await db
    .update(accessRequests)
    .set({ company: input.company, roleTitle: input.roleTitle, useCase: input.useCase ?? null, updatedAt: new Date() })
    .where(eq(accessRequests.workspaceId, input.workspaceId))
    .returning();
  if (!row) throw new AccessError("NOT_FOUND", "Access request not found");
  return row;
}

async function issueCode(tx: Db, requestId: string): Promise<{ code: string; expiresAt: Date }> {
  const { code, hash } = generateInviteCode();
  const expiresAt = new Date(Date.now() + INVITE_CODE_TTL_MS);
  await tx
    .update(accessRequests)
    .set({ inviteCodeHash: hash, inviteCodeExpiresAt: expiresAt, inviteCodeRedeemedAt: null, inviteEmailSentAt: null, updatedAt: new Date() })
    .where(eq(accessRequests.id, requestId));
  return { code, expiresAt };
}

async function sendCode(db: Db, row: AccessRequestRow, code: string, expiresAt: Date, deps: AccessDeps): Promise<boolean> {
  let sent = false;
  try {
    sent = await deps.sendEmail(row.email, code, expiresAt);
  } catch {
    sent = false;
  }
  if (sent) await db.update(accessRequests).set({ inviteEmailSentAt: new Date() }).where(eq(accessRequests.id, row.id));
  return sent;
}

/**
 * Approves a pending or rejected request: plan + feature switches, the credit grant (once per
 * request, whatever the retries), a fresh invite code, workspace -> invited, audit. The email goes
 * out after the commit; a failed send leaves the approval in place and is resendable.
 */
export async function approveAccessRequest(db: Db, ctx: AccessContext, id: string, input: ApproveInput, deps: AccessDeps): Promise<AccessRequestRow> {
  if (!Number.isInteger(input.credits) || input.credits < 0 || input.credits > 1_000_000) {
    throw new AccessError("VALIDATION_FAILED", "credits must be a whole number from 0 to 1,000,000");
  }
  const { row, code, expiresAt } = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const req = await loadRequest(tx, id, true);
    if (req.status === "approved") throw new AccessError("BUSINESS_STATE_CONFLICT", "This request is already approved", { status: req.status });
    const wsStatus = await workspaceStatusOf(tx, req.workspaceId);
    if (wsStatus === "active") throw new AccessError("BUSINESS_STATE_CONFLICT", "This workspace already has access");

    await applyPlanAndFeatures(tx, req.workspaceId, { plan: input.plan, features: input.features });
    if (input.credits > 0) {
      await postCreditTransaction(tx, {
        workspaceId: req.workspaceId,
        amount: input.credits,
        kind: "grant",
        action: "early_access",
        reason: `Early access approval (${input.plan})`,
        actor: { type: "user", id: ctx.actorId },
        idempotencyKey: `access-approval:${req.id}`,
        correlationId: ctx.requestId,
      });
    }
    const issued = await issueCode(tx, req.id);
    const now = new Date();
    await tx
      .update(accessRequests)
      .set({ status: "approved", decidedBy: ctx.actorId, decidedAt: now, decisionNote: input.note ?? null, planCode: input.plan, creditsGranted: input.credits, updatedAt: now })
      .where(eq(accessRequests.id, req.id));
    await setWorkspaceStatus(tx, req.workspaceId, "invited");
    await writeCopsAudit(tx, {
      tenantId: ctx.operatorWorkspaceId,
      actor: { type: "user", id: ctx.actorId },
      entityType: "workspace",
      entityId: req.workspaceId,
      action: "access.approved",
      before: { status: req.status, workspace_status: wsStatus },
      after: { plan: input.plan, credits: input.credits, features: input.features, email: req.email },
      reason: input.note ?? null,
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    return { row: req, ...issued };
  });
  invalidateWorkspaceAccess(row.workspaceId);
  await sendCode(db, row, code, expiresAt, deps);
  return loadRequest(db, id);
}

/** Closes a pending request, or one approved but not redeemed. No email. */
export async function rejectAccessRequest(db: Db, ctx: AccessContext, id: string, input: { note?: string }): Promise<AccessRequestRow> {
  const row = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const req = await loadRequest(tx, id, true);
    const wsStatus = await workspaceStatusOf(tx, req.workspaceId);
    if (wsStatus === "active") throw new AccessError("BUSINESS_STATE_CONFLICT", "This workspace already has access");
    if (req.status === "rejected") return req;
    const now = new Date();
    await tx
      .update(accessRequests)
      .set({ status: "rejected", decidedBy: ctx.actorId, decidedAt: now, decisionNote: input.note ?? null, inviteCodeHash: null, inviteCodeExpiresAt: null, updatedAt: now })
      .where(eq(accessRequests.id, req.id));
    await setWorkspaceStatus(tx, req.workspaceId, "rejected");
    await writeCopsAudit(tx, {
      tenantId: ctx.operatorWorkspaceId,
      actor: { type: "user", id: ctx.actorId },
      entityType: "workspace",
      entityId: req.workspaceId,
      action: "access.rejected",
      before: { status: req.status, workspace_status: wsStatus },
      after: { status: "rejected" },
      reason: input.note ?? null,
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    return req;
  });
  invalidateWorkspaceAccess(row.workspaceId);
  return loadRequest(db, id);
}

/** A fresh code for an approved, not yet redeemed request; the previous code stops working. */
export async function resendAccessCode(db: Db, ctx: AccessContext, id: string, deps: AccessDeps): Promise<AccessRequestRow> {
  const { row, code, expiresAt } = await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    const req = await loadRequest(tx, id, true);
    const wsStatus = await workspaceStatusOf(tx, req.workspaceId);
    if (req.status !== "approved" || wsStatus !== "invited") {
      throw new AccessError("BUSINESS_STATE_CONFLICT", "There is no unredeemed invite code to resend", { status: req.status, workspace_status: wsStatus });
    }
    const issued = await issueCode(tx, req.id);
    await writeCopsAudit(tx, {
      tenantId: ctx.operatorWorkspaceId,
      actor: { type: "user", id: ctx.actorId },
      entityType: "workspace",
      entityId: req.workspaceId,
      action: "access.code_resent",
      after: { email: req.email },
      correlationId: ctx.requestId,
      sourceChannel: "api",
    });
    return { row: req, ...issued };
  });
  await sendCode(db, row, code, expiresAt, deps);
  return loadRequest(db, id);
}

export type RedeemResult = { ok: true } | { ok: false; reason: "invalid" | "expired" | "used" };

/** Redeems the code for the caller's own workspace only. */
export async function redeemAccessCode(db: Db, input: { workspaceId: string; userId: string; code: string }): Promise<RedeemResult> {
  const hash = hashInviteCode(input.code);
  const result = await db.transaction(async (raw): Promise<RedeemResult> => {
    const tx = raw as unknown as Db;
    const [req] = await tx.select().from(accessRequests).where(eq(accessRequests.workspaceId, input.workspaceId)).for("update").limit(1);
    if (!req || !req.inviteCodeHash || req.status !== "approved") return { ok: false, reason: "invalid" };
    if (req.inviteCodeHash !== hash) return { ok: false, reason: "invalid" };
    if (req.inviteCodeRedeemedAt) return { ok: false, reason: "used" };
    if (!req.inviteCodeExpiresAt || req.inviteCodeExpiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };
    const now = new Date();
    await tx.update(accessRequests).set({ inviteCodeRedeemedAt: now, updatedAt: now }).where(and(eq(accessRequests.id, req.id)));
    await setWorkspaceStatus(tx, input.workspaceId, "active");
    await writeCopsAudit(tx, {
      tenantId: input.workspaceId,
      actor: { type: "user", id: input.userId },
      entityType: "workspace",
      entityId: input.workspaceId,
      action: "access.code_redeemed",
      after: { status: "active" },
      correlationId: `access-redeem:${req.id}`,
      sourceChannel: "api",
    });
    return { ok: true };
  });
  if (result.ok) invalidateWorkspaceAccess(input.workspaceId);
  return result;
}
