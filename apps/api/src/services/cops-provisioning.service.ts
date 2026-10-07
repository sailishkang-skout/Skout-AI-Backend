import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { postCreditTransaction, schema, type Db } from "@skout/db";
import { appendCopsEvent, createCopsEvent, normalizeEmail } from "@skout/shared";
import { createLogger } from "@skout/observability";
import { writeCopsAudit } from "./cops-platform.service.js";
import { EntitlementsService } from "./entitlements.service.js";

/**
 * COPS-04 trial provisioning saga (Bible p.39, Appendix H "provisioning partial failure").
 *
 * A provisioning belongs to the operator workspace (the Skout team's CRM) and creates a real,
 * separate workspace for the customer account. Steps run in order; each runs in its own transaction
 * together with its "succeeded" mark, so a step is either fully done or not done at all. A failed
 * step leaves the earlier ones done, and a retry continues from the failed step. Every step is also
 * idempotent on its own (it checks what it already created), so a resumed run never duplicates the
 * workspace, the invite or the wallet.
 *
 * Section 7.1 / Section 5 DOCUMENTED READ-MODEL EXCEPTION - see docs/adr/0003-read-model-exceptions.md
 * (COPS-04): reads companies/deals/commercial_gates and writes workspaces, workspace_invites,
 * entitlements and the credit ledger in the same transactions as the saga state and outbox events.
 */

const log = createLogger("cops-provisioning");

const {
  companies,
  deals,
  commercialGates,
  copsProvisionings,
  copsProvisioningSteps,
  workspaces,
  roles,
  workspaceInvites,
  creditBalances,
  copsLifecycleStates,
} = schema;

export const PROVISIONING_STEPS = [
  "create_workspace",
  "default_roles",
  "entitlements",
  "credit_wallet",
  "integration_placeholders",
  "admin_invite",
  "link_crm",
] as const;
export type ProvisioningStepName = (typeof PROVISIONING_STEPS)[number];

export const PROVISIONING_INTEGRATIONS = ["crm", "email", "calendar"] as const;

/** Bible p.4: a standard trial is provisioned in under 2 minutes. */
export const PROVISIONING_TARGET_MS = 120_000;
/** A run still "running" after this long is treated as crashed and may be resumed. */
const STALE_RUN_MS = 5 * 60_000;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The customer's admin joins as owner of their own workspace (system role, backfill-rbac.ts). */
export const PROVISIONED_ADMIN_ROLE = "owner";
const ENTITLEMENT_SOURCE = "cops_provisioning";

export interface ProvisionRequest {
  opportunity_id: string;
  admin_email: string;
  workspace_name?: string | null;
  plan: string;
  trial_days: number;
  credits: number;
  integrations: (typeof PROVISIONING_INTEGRATIONS)[number][];
}

export type ProvisioningErrorCode =
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "GATE_CLOSED"
  | "ALREADY_PROVISIONED"
  | "PROVISIONING_IN_PROGRESS"
  | "IDEMPOTENCY_KEY_REUSED"
  | "BUSINESS_STATE_CONFLICT";

export class ProvisioningError extends Error {
  constructor(
    readonly code: ProvisioningErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ProvisioningError";
  }

  get status(): number {
    switch (this.code) {
      case "NOT_FOUND":
        return 404;
      case "VALIDATION_FAILED":
      case "IDEMPOTENCY_KEY_REUSED":
        return 422;
      default:
        return 409;
    }
  }

  get retryable(): boolean {
    return this.code === "PROVISIONING_IN_PROGRESS";
  }
}

export interface ProvisioningContext {
  workspaceId: string;
  userId: string;
  requestId: string;
}

export interface ProvisioningDeps {
  /** Sends the admin invitation. A send failure never fails the step (the invite exists either way). */
  sendInvite?: (input: { to: string; workspaceName: string; acceptUrl: string }) => Promise<{ sent: boolean }>;
  /** Base for the invite accept link, e.g. https://app.skout.ai. */
  inviteBaseUrl?: string;
  /** Test hook: called inside each step's transaction after its writes; throwing rolls the step back. */
  injectFailure?: (step: ProvisioningStepName, attempt: number) => void;
}

/** Bible p.39: idempotency key derived from account + provisioning request. */
export function provisioningIdempotencyKey(accountId: string, requestKey: string): string {
  return createHash("sha256").update(`${accountId}:${requestKey}`).digest("hex");
}

/** Stable form of the request, so a replay compares equal whatever order jsonb stored the keys in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function normalizeRequest(input: ProvisionRequest): ProvisionRequest {
  return {
    opportunity_id: input.opportunity_id.toLowerCase(),
    admin_email: normalizeEmail(input.admin_email),
    workspace_name: input.workspace_name?.trim() || null,
    plan: input.plan,
    trial_days: input.trial_days,
    credits: input.credits,
    integrations: [...new Set(input.integrations)].sort(),
  };
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "workspace";
}

// ---------------------------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------------------------

export interface ProvisioningStepDto {
  step: ProvisioningStepName;
  status: string;
  attempts: number;
  error: string | null;
  duration_ms: number | null;
  finished_at: string | null;
}

export interface ProvisioningDto {
  id: string;
  account_id: string;
  opportunity_id: string;
  status: string;
  provisioned_workspace_id: string | null;
  invite_id: string | null;
  admin_invite: { email: string; accepted_at: string | null; expires_at: string; accept_url: string | null } | null;
  plan: string;
  trial_starts_at: string | null;
  trial_ends_at: string | null;
  credits: number;
  integrations: string[];
  attempts: number;
  last_error: string | null;
  duration_ms: number | null;
  within_target: boolean | null;
  created_at: string;
  completed_at: string | null;
  steps: ProvisioningStepDto[];
}

export async function loadProvisionings(
  db: Db,
  workspaceId: string,
  filter: { accountId?: string; provisioningId?: string },
  opts: { inviteBaseUrl?: string } = {}
): Promise<ProvisioningDto[]> {
  const where = [eq(copsProvisionings.workspaceId, workspaceId)];
  if (filter.accountId) where.push(eq(copsProvisionings.accountId, filter.accountId));
  if (filter.provisioningId) where.push(eq(copsProvisionings.id, filter.provisioningId));
  const rows = await db
    .select()
    .from(copsProvisionings)
    .where(and(...where))
    .orderBy(desc(copsProvisionings.createdAt));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const steps = await db
    .select()
    .from(copsProvisioningSteps)
    .where(and(eq(copsProvisioningSteps.workspaceId, workspaceId), inArray(copsProvisioningSteps.provisioningId, ids)))
    .orderBy(asc(copsProvisioningSteps.position));
  const inviteIds = rows.map((r) => r.inviteId).filter((v): v is string => Boolean(v));
  const invites = inviteIds.length
    ? await db
        .select({
          id: workspaceInvites.id,
          email: workspaceInvites.email,
          token: workspaceInvites.token,
          acceptedAt: workspaceInvites.acceptedAt,
          expiresAt: workspaceInvites.expiresAt,
        })
        .from(workspaceInvites)
        .where(inArray(workspaceInvites.id, inviteIds))
    : [];

  return rows.map((r) => {
    const request = r.request as ProvisionRequest;
    const invite = invites.find((i) => i.id === r.inviteId);
    return {
      id: r.id,
      account_id: r.accountId,
      opportunity_id: r.opportunityId,
      status: r.status,
      provisioned_workspace_id: r.provisionedWorkspaceId,
      invite_id: r.inviteId,
      admin_invite: invite
        ? {
            email: invite.email,
            accepted_at: invite.acceptedAt?.toISOString() ?? null,
            expires_at: invite.expiresAt.toISOString(),
            accept_url: opts.inviteBaseUrl && !invite.acceptedAt ? `${opts.inviteBaseUrl}/invite/${invite.token}` : null,
          }
        : null,
      plan: request.plan,
      trial_starts_at: r.trialStartsAt?.toISOString() ?? null,
      trial_ends_at: r.trialEndsAt?.toISOString() ?? null,
      credits: request.credits,
      integrations: request.integrations,
      attempts: r.attempts,
      last_error: r.lastError,
      duration_ms: r.durationMs,
      within_target: r.durationMs === null ? null : r.durationMs <= PROVISIONING_TARGET_MS,
      created_at: r.createdAt.toISOString(),
      completed_at: r.completedAt?.toISOString() ?? null,
      steps: steps
        .filter((s) => s.provisioningId === r.id)
        .map((s) => ({
          step: s.step as ProvisioningStepName,
          status: s.status,
          attempts: s.attempts,
          error: s.error,
          duration_ms: s.durationMs,
          finished_at: s.finishedAt?.toISOString() ?? null,
        })),
    };
  });
}

async function loadOne(db: Db, workspaceId: string, provisioningId: string, deps: ProvisioningDeps) {
  const [p] = await loadProvisionings(db, workspaceId, { provisioningId }, { inviteBaseUrl: deps.inviteBaseUrl });
  if (!p) throw new ProvisioningError("NOT_FOUND", "Provisioning not found");
  return p;
}

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

/**
 * POST /accounts/:id/provision. The same (account, Idempotency-Key) returns the same provisioning and
 * resumes it if it had failed. A different key for an account that already has a provisioning is
 * refused (409), so a double click or a second rep never creates a second workspace.
 */
export async function startProvisioning(
  db: Db,
  ctx: ProvisioningContext,
  accountId: string,
  requestKey: string,
  input: ProvisionRequest,
  deps: ProvisioningDeps = {}
): Promise<{ provisioning: ProvisioningDto; replayed: boolean }> {
  const key = provisioningIdempotencyKey(accountId, requestKey);
  const request = normalizeRequest(input);

  const { id, replayed } = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    // Lock the account: two requests with different keys cannot both create a provisioning.
    const [account] = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.id, accountId), eq(companies.workspaceId, ctx.workspaceId), isNull(companies.deletedAt)))
      .for("update")
      .limit(1);
    if (!account) throw new ProvisioningError("NOT_FOUND", "Account not found");

    const [sameKey] = await tx
      .select({ id: copsProvisionings.id, request: copsProvisionings.request })
      .from(copsProvisionings)
      .where(and(eq(copsProvisionings.workspaceId, ctx.workspaceId), eq(copsProvisionings.idempotencyKey, key)))
      .limit(1);
    if (sameKey) {
      if (canonical(sameKey.request) !== canonical(request)) {
        throw new ProvisioningError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used with a different provisioning request");
      }
      return { id: sameKey.id, replayed: true };
    }

    const [previous] = await tx
      .select({ id: copsProvisionings.id, status: copsProvisionings.status, workspaceId: copsProvisionings.provisionedWorkspaceId })
      .from(copsProvisionings)
      .where(and(eq(copsProvisionings.workspaceId, ctx.workspaceId), eq(copsProvisionings.accountId, accountId)))
      .orderBy(desc(copsProvisionings.createdAt))
      .limit(1);
    if (previous?.status === "succeeded") {
      throw new ProvisioningError("ALREADY_PROVISIONED", "This account already has a provisioned workspace", {
        provisioning_id: previous.id,
        provisioned_workspace_id: previous.workspaceId,
      });
    }
    if (previous) {
      throw new ProvisioningError(
        "PROVISIONING_IN_PROGRESS",
        "This account has a provisioning that has not finished; retry that one instead of starting another",
        { provisioning_id: previous.id, status: previous.status }
      );
    }

    const [opportunity] = await tx
      .select({ id: deals.id, companyId: deals.companyId })
      .from(deals)
      .where(and(eq(deals.id, request.opportunity_id), eq(deals.workspaceId, ctx.workspaceId), isNull(deals.deletedAt)))
      .limit(1);
    if (!opportunity || opportunity.companyId !== accountId) {
      throw new ProvisioningError("VALIDATION_FAILED", "The opportunity does not belong to this account", {
        fields: [{ path: "opportunity_id", code: "invalid", message: "The opportunity does not belong to this account" }],
      });
    }
    const [gate] = await tx
      .select({ firedAt: commercialGates.firedAt })
      .from(commercialGates)
      .where(and(eq(commercialGates.opportunityId, opportunity.id), eq(commercialGates.workspaceId, ctx.workspaceId)))
      .limit(1);
    if (!gate?.firedAt) {
      throw new ProvisioningError("GATE_CLOSED", "The commercial gate for this opportunity has not opened yet", {
        opportunity_id: opportunity.id,
      });
    }

    const now = new Date();
    const [row] = await tx
      .insert(copsProvisionings)
      .values({
        workspaceId: ctx.workspaceId,
        accountId,
        opportunityId: opportunity.id,
        idempotencyKey: key,
        status: "pending",
        request,
        trialStartsAt: now,
        trialEndsAt: new Date(now.getTime() + request.trial_days * DAY_MS),
        requestedBy: ctx.userId,
      })
      .returning({ id: copsProvisionings.id });
    await tx.insert(copsProvisioningSteps).values(
      PROVISIONING_STEPS.map((step, i) => ({ workspaceId: ctx.workspaceId, provisioningId: row!.id, step, position: i + 1 }))
    );
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor: { type: "user", id: ctx.userId },
      entityType: "account",
      entityId: accountId,
      action: "provisioning.requested",
      after: {
        provisioning_id: row!.id,
        opportunity_id: opportunity.id,
        plan: request.plan,
        trial_days: request.trial_days,
        credits: request.credits,
        admin_email: request.admin_email,
      },
      correlationId: ctx.requestId,
      sourceChannel: "api",
      occurredAt: now,
    });
    return { id: row!.id, replayed: false };
  });

  const current = await loadOne(db, ctx.workspaceId, id, deps);
  if (current.status === "succeeded") return { provisioning: current, replayed };
  return { provisioning: await runSaga(db, ctx, id, deps), replayed };
}

/** POST /provisionings/:id/retry: resume a failed (or crashed) provisioning from its failed step. */
export async function retryProvisioning(db: Db, ctx: ProvisioningContext, provisioningId: string, deps: ProvisioningDeps = {}) {
  const current = await loadOne(db, ctx.workspaceId, provisioningId, deps);
  if (current.status === "succeeded") {
    throw new ProvisioningError("BUSINESS_STATE_CONFLICT", "This provisioning already succeeded", { provisioning_id: provisioningId });
  }
  return runSaga(db, ctx, provisioningId, deps);
}

// ---------------------------------------------------------------------------------------------
// Saga runner
// ---------------------------------------------------------------------------------------------

interface RunState {
  operatorWorkspaceId: string;
  provisioningId: string;
  accountId: string;
  accountName: string;
  request: ProvisionRequest;
  requestedBy: string | null;
  requestId: string;
  trialStartsAt: Date;
  trialEndsAt: Date;
  /** Filled by create_workspace / admin_invite once their transaction commits. */
  workspaceId: string | null;
  inviteId: string | null;
}

type StepOutcome = {
  result: Record<string, unknown>;
  /** Runs after the step committed (outside the transaction), e.g. sending an email. */
  afterCommit?: (db: Db) => Promise<Record<string, unknown>>;
};

type StepRunner = (tx: Db, run: RunState, deps: ProvisioningDeps) => Promise<StepOutcome>;

function requireWorkspace(run: RunState): string {
  if (!run.workspaceId) throw new Error("create_workspace has not completed");
  return run.workspaceId;
}

const STEP_RUNNERS: Record<ProvisioningStepName, StepRunner> = {
  async create_workspace(tx, run) {
    if (run.workspaceId) {
      const [existing] = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, run.workspaceId)).limit(1);
      if (existing) return { result: { workspace_id: existing.id, created: false } };
    }
    const name = run.request.workspace_name || run.accountName;
    const slug = `${slugify(name)}-${run.provisioningId.slice(0, 8)}`;
    const [created] = await tx
      .insert(workspaces)
      .values({ name, slug })
      .onConflictDoNothing({ target: workspaces.slug })
      .returning({ id: workspaces.id });
    if (!created) throw new Error(`Workspace slug ${slug} is already taken`);
    await tx
      .update(copsProvisionings)
      .set({ provisionedWorkspaceId: created.id, updatedAt: new Date() })
      .where(eq(copsProvisionings.id, run.provisioningId));
    return { result: { workspace_id: created.id, slug, created: true } };
  },

  async default_roles(tx) {
    // System roles are global (roles.workspace_id is null); nothing per workspace to create. The
    // step proves the role the admin invite grants exists, so the invite cannot dead-end.
    const wanted = [PROVISIONED_ADMIN_ROLE, "admin", "member"];
    const rows = await tx
      .select({ key: roles.key })
      .from(roles)
      .where(and(isNull(roles.workspaceId), inArray(roles.key, wanted)));
    const found = rows.map((r) => r.key);
    const missing = wanted.filter((k) => !found.includes(k));
    if (missing.length) throw new Error(`System roles missing: ${missing.join(", ")} (run backfill-rbac)`);
    return { result: { admin_role: PROVISIONED_ADMIN_ROLE, roles: wanted } };
  },

  async entitlements(tx, run) {
    const workspaceId = requireWorkspace(run);
    const svc = new EntitlementsService(tx);
    await svc.set(workspaceId, "plan", { name: run.request.plan, provisioning_id: run.provisioningId }, ENTITLEMENT_SOURCE);
    await svc.set(
      workspaceId,
      "trial",
      { starts_at: run.trialStartsAt.toISOString(), ends_at: run.trialEndsAt.toISOString() },
      ENTITLEMENT_SOURCE
    );
    return { result: { plan: run.request.plan, trial_ends_at: run.trialEndsAt.toISOString() } };
  },

  async credit_wallet(tx, run) {
    const workspaceId = requireWorkspace(run);
    if (run.request.credits === 0) {
      await tx.insert(creditBalances).values({ workspaceId, balance: 0 }).onConflictDoNothing();
      return { result: { wallet_id: workspaceId, granted: 0 } };
    }
    const reason = `Trial credits at provisioning (${run.request.plan})`;
    const posted = await postCreditTransaction(tx, {
      workspaceId,
      amount: run.request.credits,
      kind: "grant",
      action: "provision",
      reason,
      actor: { type: run.requestedBy ? "user" : "system", id: run.requestedBy },
      // One trial grant per provisioning, however many times the step runs.
      idempotencyKey: `cops-provisioning:${run.provisioningId}`,
      correlationId: run.requestId,
    });
    if (!posted.replayed) {
      const actor = { type: "user" as const, id: run.requestedBy };
      await appendCopsEvent(
        tx as never,
        createCopsEvent({
          eventType: "CreditsGranted",
          tenantId: run.operatorWorkspaceId,
          aggregateType: "account",
          aggregateId: run.accountId,
          actor,
          correlationId: run.requestId,
          payload: { wallet_id: workspaceId, amount: run.request.credits, reason, account_id: run.accountId },
        })
      );
      await writeCopsAudit(tx, {
        tenantId: run.operatorWorkspaceId,
        actor,
        entityType: "credit_wallet",
        entityId: workspaceId,
        action: "credits.granted",
        after: { amount: run.request.credits, balance: posted.balance, transaction_id: posted.transaction.id },
        reason,
        correlationId: run.requestId,
        sourceChannel: "api",
      });
    }
    return { result: { wallet_id: workspaceId, granted: run.request.credits, transaction_id: posted.transaction.id } };
  },

  async integration_placeholders(tx, run) {
    const workspaceId = requireWorkspace(run);
    const placeholders = Object.fromEntries(run.request.integrations.map((k) => [k, { status: "not_connected" }]));
    await new EntitlementsService(tx).set(workspaceId, "integrations", placeholders, ENTITLEMENT_SOURCE);
    return { result: { integrations: run.request.integrations } };
  },

  async admin_invite(tx, run, deps) {
    const workspaceId = requireWorkspace(run);
    if (run.inviteId) {
      const [existing] = await tx.select({ id: workspaceInvites.id }).from(workspaceInvites).where(eq(workspaceInvites.id, run.inviteId)).limit(1);
      if (existing) return { result: { invite_id: existing.id, created: false } };
    }
    const email = normalizeEmail(run.request.admin_email);
    const token = randomBytes(32).toString("hex");
    const [invite] = await tx
      .insert(workspaceInvites)
      .values({
        workspaceId,
        invitedByUserId: run.requestedBy,
        email,
        role: PROVISIONED_ADMIN_ROLE,
        token,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })
      .returning({ id: workspaceInvites.id });
    await tx
      .update(copsProvisionings)
      .set({ inviteId: invite!.id, updatedAt: new Date() })
      .where(eq(copsProvisionings.id, run.provisioningId));
    const result = { invite_id: invite!.id, email, created: true };
    return {
      result,
      // The email goes out only for a freshly created invite, after it is committed; a failed send is
      // recorded, never thrown (the accept link is on the provisioning for the rep to share).
      afterCommit: async (db) => {
        if (!deps.sendInvite) return { ...result, email_sent: false };
        try {
          const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
          const base = deps.inviteBaseUrl ?? "";
          const sent = await deps.sendInvite({ to: email, workspaceName: ws?.name ?? "Skout workspace", acceptUrl: `${base}/invite/${token}` });
          return { ...result, email_sent: sent.sent };
        } catch (error) {
          log.warn("provisioning invite email failed", { provisioningId: run.provisioningId, error: String(error) });
          return { ...result, email_sent: false, email_error: "send_failed" };
        }
      },
    };
  },

  async link_crm(tx, run) {
    const workspaceId = requireWorkspace(run);
    // The account becomes a trial customer (COPS-01 account dimension starts at "trial").
    await tx
      .insert(copsLifecycleStates)
      .values({ workspaceId: run.operatorWorkspaceId, dimension: "account", entityId: run.accountId, state: "trial" })
      .onConflictDoNothing();
    return { result: { account_id: run.accountId, workspace_id: workspaceId } };
  },
};

async function runSaga(db: Db, ctx: ProvisioningContext, provisioningId: string, deps: ProvisioningDeps): Promise<ProvisioningDto> {
  const claimed = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const [p] = await tx
      .select()
      .from(copsProvisionings)
      .where(and(eq(copsProvisionings.id, provisioningId), eq(copsProvisionings.workspaceId, ctx.workspaceId)))
      .for("update")
      .limit(1);
    if (!p) throw new ProvisioningError("NOT_FOUND", "Provisioning not found");
    if (p.status === "succeeded") return null;
    if (p.status === "running" && Date.now() - p.updatedAt.getTime() < STALE_RUN_MS) {
      throw new ProvisioningError("PROVISIONING_IN_PROGRESS", "This provisioning is already running", { provisioning_id: p.id });
    }
    const [account] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, p.accountId)).limit(1);
    const now = new Date();
    await tx
      .update(copsProvisionings)
      .set({ status: "running", attempts: sql`${copsProvisionings.attempts} + 1`, startedAt: p.startedAt ?? now, lastError: null, updatedAt: now })
      .where(eq(copsProvisionings.id, p.id));
    if (p.attempts > 0) {
      await writeCopsAudit(tx, {
        tenantId: ctx.workspaceId,
        actor: { type: "user", id: ctx.userId },
        entityType: "account",
        entityId: p.accountId,
        action: "provisioning.retried",
        before: { status: p.status, last_error: p.lastError },
        after: { provisioning_id: p.id, attempt: p.attempts + 1 },
        correlationId: ctx.requestId,
        sourceChannel: "api",
        occurredAt: now,
      });
    }
    return { row: p, accountName: account?.name ?? "Customer workspace" };
  });
  if (!claimed) return loadOne(db, ctx.workspaceId, provisioningId, deps);

  const { row } = claimed;
  const run: RunState = {
    operatorWorkspaceId: ctx.workspaceId,
    provisioningId,
    accountId: row.accountId,
    accountName: claimed.accountName,
    request: row.request as ProvisionRequest,
    requestedBy: row.requestedBy,
    requestId: ctx.requestId,
    trialStartsAt: row.trialStartsAt ?? new Date(),
    trialEndsAt: row.trialEndsAt ?? new Date(),
    workspaceId: row.provisionedWorkspaceId,
    inviteId: row.inviteId,
  };
  const runStarted = Date.now();
  const steps = await db
    .select()
    .from(copsProvisioningSteps)
    .where(eq(copsProvisioningSteps.provisioningId, provisioningId))
    .orderBy(asc(copsProvisioningSteps.position));

  for (const step of steps) {
    if (step.status === "succeeded") continue;
    const name = step.step as ProvisioningStepName;
    const attempt = step.attempts + 1;
    const started = Date.now();
    // Attempt count is recorded outside the step transaction so a failed attempt still counts.
    await db
      .update(copsProvisioningSteps)
      .set({ status: "running", attempts: attempt, error: null, startedAt: new Date(started) })
      .where(eq(copsProvisioningSteps.id, step.id));
    try {
      const outcome = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const out = await STEP_RUNNERS[name](tx, run, deps);
        deps.injectFailure?.(name, attempt);
        await tx
          .update(copsProvisioningSteps)
          .set({ status: "succeeded", result: out.result, error: null, finishedAt: new Date(), durationMs: Date.now() - started })
          .where(eq(copsProvisioningSteps.id, step.id));
        return out;
      });
      // Only now, after commit, does the run see what the step created.
      if (typeof outcome.result.workspace_id === "string" && name === "create_workspace") run.workspaceId = outcome.result.workspace_id;
      if (typeof outcome.result.invite_id === "string") run.inviteId = outcome.result.invite_id;
      if (outcome.afterCommit) {
        const result = await outcome.afterCommit(db);
        await db.update(copsProvisioningSteps).set({ result }).where(eq(copsProvisioningSteps.id, step.id));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedAt = new Date();
      await db
        .update(copsProvisioningSteps)
        .set({ status: "failed", error: message, finishedAt: failedAt, durationMs: Date.now() - started })
        .where(eq(copsProvisioningSteps.id, step.id));
      await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        await tx
          .update(copsProvisionings)
          .set({ status: "failed", lastError: `${name}: ${message}`, updatedAt: failedAt })
          .where(eq(copsProvisionings.id, provisioningId));
        await writeCopsAudit(tx, {
          tenantId: ctx.workspaceId,
          actor: { type: "system", id: "cops-provisioning" },
          entityType: "account",
          entityId: run.accountId,
          action: "provisioning.failed",
          after: { provisioning_id: provisioningId, step: name, attempt, error: message },
          correlationId: ctx.requestId,
          sourceChannel: "api",
          occurredAt: failedAt,
        });
      });
      log.warn("provisioning step failed", { provisioningId, step: name, attempt, error: message });
      return loadOne(db, ctx.workspaceId, provisioningId, deps);
    }
  }

  // All steps done: mark succeeded and emit WorkspaceProvisioned exactly once (row lock + status check).
  const durationMs = Date.now() - runStarted;
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const [p] = await tx
      .select({ status: copsProvisionings.status })
      .from(copsProvisionings)
      .where(eq(copsProvisionings.id, provisioningId))
      .for("update")
      .limit(1);
    if (p?.status === "succeeded") return;
    const at = new Date();
    const workspaceId = requireWorkspace(run);
    await tx
      .update(copsProvisionings)
      .set({ status: "succeeded", completedAt: at, durationMs, lastError: null, updatedAt: at })
      .where(eq(copsProvisionings.id, provisioningId));
    const actor = { type: "user" as const, id: run.requestedBy };
    await appendCopsEvent(
      tx as never,
      createCopsEvent({
        eventType: "WorkspaceProvisioned",
        tenantId: ctx.workspaceId,
        aggregateType: "account",
        aggregateId: run.accountId,
        actor,
        correlationId: ctx.requestId,
        payload: { account_id: run.accountId, workspace_id: workspaceId },
        occurredAt: at,
      })
    );
    await writeCopsAudit(tx, {
      tenantId: ctx.workspaceId,
      actor,
      entityType: "account",
      entityId: run.accountId,
      action: "provisioning.succeeded",
      after: {
        provisioning_id: provisioningId,
        workspace_id: workspaceId,
        invite_id: run.inviteId,
        duration_ms: durationMs,
        within_target: durationMs <= PROVISIONING_TARGET_MS,
      },
      correlationId: ctx.requestId,
      sourceChannel: "api",
      occurredAt: at,
    });
  });
  const withinTarget = durationMs <= PROVISIONING_TARGET_MS;
  const fields = { provisioningId, accountId: run.accountId, workspaceId: run.workspaceId, durationMs, withinTarget };
  if (withinTarget) log.info("provisioning succeeded", fields);
  else log.warn("provisioning exceeded the 2-minute target", fields);
  return loadOne(db, ctx.workspaceId, provisioningId, deps);
}
