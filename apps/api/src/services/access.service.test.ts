import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { loadWorkspaceAccess, resolveOrProvisionUser } from "@skout/auth";
import { PLAN_PRESETS } from "@skout/shared";
import { loadEnv } from "../config/env.js";
import {
  AccessError,
  approveAccessRequest,
  generateInviteCode,
  hashInviteCode,
  redeemAccessCode,
  rejectAccessRequest,
  resendAccessCode,
  submitAccessRequest,
} from "./access.service.js";

const config = loadEnv();
const hasDatabase = Boolean(config.DATABASE_URL);

describe("invite codes", () => {
  it("are 8 unambiguous characters shown as XXXX-XXXX", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateInviteCode().code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
  });

  it("hash the same however they are typed", () => {
    expect(hashInviteCode("abcd-efgh")).toBe(hashInviteCode("ABCDEFGH"));
    expect(hashInviteCode(" ABCD EFGH ")).toBe(hashInviteCode("ABCD-EFGH"));
    expect(hashInviteCode("ABCD-EFGH")).not.toBe(hashInviteCode("ABCD-EFGJ"));
  });

  it("store the hash of the code they show", () => {
    const { code, hash } = generateInviteCode();
    expect(hash).toBe(hashInviteCode(code));
  });
});

describe.skipIf(!hasDatabase)("access service (early access)", () => {
  const { db, sql } = createDb(config.DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  let n = 0;
  let operator: { workspaceId: string; userId: string };
  const ctx = () => ({ operatorWorkspaceId: operator.workspaceId, actorId: operator.userId, requestId: `req-${suffix}-${++n}` });

  async function selfSignup() {
    const email = `ea-svc-${suffix}-${++n}@test.com`;
    const r = await resolveOrProvisionUser(db, { provider: "password", subject: email, email, emailVerified: true, name: "Pat" }, undefined, undefined, undefined, {
      selfSignup: { method: "password" },
    });
    const [req] = await db.select().from(schema.accessRequests).where(eq(schema.accessRequests.workspaceId, r.workspaceId));
    return { ...r, requestId: req!.id };
  }
  async function workspaceStatus(id: string) {
    const [ws] = await db.select({ s: schema.workspaces.accessStatus }).from(schema.workspaces).where(eq(schema.workspaces.id, id));
    return ws!.s;
  }
  async function balance(id: string) {
    const [b] = await db.select().from(schema.creditBalances).where(eq(schema.creditBalances.workspaceId, id));
    return b?.balance ?? null;
  }
  function mailer(ok = true) {
    const sent: string[] = [];
    return { sent, deps: { sendEmail: vi.fn(async (_to: string, code: string) => (sent.push(code), ok)) } };
  }
  const approveInput = (over: Partial<Parameters<typeof approveAccessRequest>[3]> = {}) => ({
    plan: "multichannel" as const,
    credits: 500,
    features: { ...PLAN_PRESETS.full.features },
    ...over,
  });

  beforeAll(async () => {
    const email = `ea-op-${suffix}@test.com`;
    const r = await resolveOrProvisionUser(db, { provider: "password", subject: email, email, emailVerified: true });
    operator = { workspaceId: r.workspaceId, userId: r.userId };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await sql.end();
  });

  it("submit stores the answers on the caller's own request", async () => {
    const u = await selfSignup();
    await submitAccessRequest(db, { workspaceId: u.workspaceId, userId: u.userId, company: "Acme", roleTitle: "Founder", useCase: "Outbound" });
    const [req] = await db.select().from(schema.accessRequests).where(eq(schema.accessRequests.id, u.requestId));
    expect(req).toMatchObject({ company: "Acme", roleTitle: "Founder", useCase: "Outbound" });
  });

  it("approve sets plan, features, credits and invited status", async () => {
    const u = await selfSignup();
    const m = mailer();
    const dto = await approveAccessRequest(db, ctx(), u.requestId, approveInput({ features: { ...PLAN_PRESETS.full.features, ai: false } }), m.deps);
    expect(dto.status).toBe("approved");
    expect(await workspaceStatus(u.workspaceId)).toBe("invited");
    expect(await balance(u.workspaceId)).toBe(500);
    const access = await loadWorkspaceAccess(db, u.workspaceId);
    expect(access.features.ai).toBe(false);
    expect(access.features.crm).toBe(true);
    const [plan] = await db.select().from(schema.entitlements).where(eq(schema.entitlements.workspaceId, u.workspaceId));
    expect(plan).toBeTruthy();
    expect(m.sent).toHaveLength(1);
    const [req] = await db.select().from(schema.accessRequests).where(eq(schema.accessRequests.id, u.requestId));
    expect(req!.inviteEmailSentAt).not.toBeNull();
    expect(req!.planCode).toBe("multichannel");
    expect(req!.creditsGranted).toBe(500);
  });

  it("approve is idempotent on credits", async () => {
    const u = await selfSignup();
    await approveAccessRequest(db, ctx(), u.requestId, approveInput(), mailer().deps);
    await expect(approveAccessRequest(db, ctx(), u.requestId, approveInput(), mailer().deps)).rejects.toBeInstanceOf(AccessError);
    expect(await balance(u.workspaceId)).toBe(500);
    const txns = await db.select().from(schema.creditTransactions).where(eq(schema.creditTransactions.workspaceId, u.workspaceId));
    expect(txns).toHaveLength(1);
  });

  it("approve with credits 0 grants nothing", async () => {
    const u = await selfSignup();
    await approveAccessRequest(db, ctx(), u.requestId, approveInput({ credits: 0 }), mailer().deps);
    const txns = await db.select().from(schema.creditTransactions).where(eq(schema.creditTransactions.workspaceId, u.workspaceId));
    expect(txns).toHaveLength(0);
  });

  it("a zero-credit approval stays at zero after redeem and sign-in", async () => {
    const u = await selfSignup();
    const m = mailer();
    await approveAccessRequest(db, ctx(), u.requestId, approveInput({ credits: 0 }), m.deps);
    expect(await redeemAccessCode(db, { workspaceId: u.workspaceId, userId: u.userId, code: m.sent[0]! })).toEqual({ ok: true });
    const again = await resolveOrProvisionUser(db, { provider: "password", subject: u.userEmail, email: u.userEmail, emailVerified: true });
    expect(again.workspaceId).toBe(u.workspaceId);
    expect(await balance(u.workspaceId)).toBe(0);
  });

  it("email failure leaves approval committed and invite_email_sent_at null", async () => {
    const u = await selfSignup();
    await approveAccessRequest(db, ctx(), u.requestId, approveInput(), mailer(false).deps);
    expect(await workspaceStatus(u.workspaceId)).toBe("invited");
    const [req] = await db.select().from(schema.accessRequests).where(eq(schema.accessRequests.id, u.requestId));
    expect(req!.inviteEmailSentAt).toBeNull();
  });

  it("redeem with the right code activates", async () => {
    const u = await selfSignup();
    const m = mailer();
    await approveAccessRequest(db, ctx(), u.requestId, approveInput(), m.deps);
    expect(await redeemAccessCode(db, { workspaceId: u.workspaceId, userId: u.userId, code: m.sent[0]!.toLowerCase() })).toEqual({ ok: true });
    expect(await workspaceStatus(u.workspaceId)).toBe("active");
    expect((await loadWorkspaceAccess(db, u.workspaceId)).status).toBe("active");
  });

  it("redeem twice → used", async () => {
    const u = await selfSignup();
    const m = mailer();
    await approveAccessRequest(db, ctx(), u.requestId, approveInput(), m.deps);
    await redeemAccessCode(db, { workspaceId: u.workspaceId, userId: u.userId, code: m.sent[0]! });
    expect(await redeemAccessCode(db, { workspaceId: u.workspaceId, userId: u.userId, code: m.sent[0]! })).toEqual({ ok: false, reason: "used" });
  });

  it("expired code → expired", async () => {
    const u = await selfSignup();
    const m = mailer();
    await approveAccessRequest(db, ctx(), u.requestId, approveInput(), m.deps);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 14 * 86_400_000 + 60_000);
    expect(await redeemAccessCode(db, { workspaceId: u.workspaceId, userId: u.userId, code: m.sent[0]! })).toEqual({ ok: false, reason: "expired" });
    expect(await workspaceStatus(u.workspaceId)).toBe("invited");
  });

  it("wrong code → invalid", async () => {
    const u = await selfSignup();
    await approveAccessRequest(db, ctx(), u.requestId, approveInput(), mailer().deps);
    expect(await redeemAccessCode(db, { workspaceId: u.workspaceId, userId: u.userId, code: "AAAA-AAAA" })).toEqual({ ok: false, reason: "invalid" });
  });

  it("old code is invalid after resend", async () => {
    const u = await selfSignup();
    const m = mailer();
    await approveAccessRequest(db, ctx(), u.requestId, approveInput(), m.deps);
    await resendAccessCode(db, ctx(), u.requestId, m.deps);
    expect(m.sent).toHaveLength(2);
    expect(await redeemAccessCode(db, { workspaceId: u.workspaceId, userId: u.userId, code: m.sent[0]! })).toEqual({ ok: false, reason: "invalid" });
    expect(await redeemAccessCode(db, { workspaceId: u.workspaceId, userId: u.userId, code: m.sent[1]! })).toEqual({ ok: true });
  });

  it("resend is refused unless a code is out", async () => {
    const u = await selfSignup();
    await expect(resendAccessCode(db, ctx(), u.requestId, mailer().deps)).rejects.toBeInstanceOf(AccessError);
  });

  it("code only redeems for its own workspace", async () => {
    const a = await selfSignup();
    const b = await selfSignup();
    const m = mailer();
    await approveAccessRequest(db, ctx(), a.requestId, approveInput(), m.deps);
    await approveAccessRequest(db, ctx(), b.requestId, approveInput(), mailer().deps);
    expect(await redeemAccessCode(db, { workspaceId: b.workspaceId, userId: b.userId, code: m.sent[0]! })).toEqual({ ok: false, reason: "invalid" });
    expect(await workspaceStatus(b.workspaceId)).toBe("invited");
  });

  it("reject then approve works", async () => {
    const u = await selfSignup();
    await rejectAccessRequest(db, ctx(), u.requestId, { note: "not a fit yet" });
    expect(await workspaceStatus(u.workspaceId)).toBe("rejected");
    await approveAccessRequest(db, ctx(), u.requestId, approveInput(), mailer().deps);
    expect(await workspaceStatus(u.workspaceId)).toBe("invited");
  });

  it("an active workspace's request cannot be rejected", async () => {
    const u = await selfSignup();
    const m = mailer();
    await approveAccessRequest(db, ctx(), u.requestId, approveInput(), m.deps);
    await redeemAccessCode(db, { workspaceId: u.workspaceId, userId: u.userId, code: m.sent[0]! });
    await expect(rejectAccessRequest(db, ctx(), u.requestId, {})).rejects.toBeInstanceOf(AccessError);
  });

  it("loadWorkspaceAccess on a workspace with no feature rows returns every general feature on (opt-in ones off) and status active", async () => {
    const access = await loadWorkspaceAccess(db, operator.workspaceId);
    expect(access.status).toBe("active");
    const { workbooks_v2, ...general } = access.features;
    expect(Object.values(general).every(Boolean)).toBe(true);
    expect(workbooks_v2).toBe(false);
  });

  it("the bootstrap admin's workspace is active", async () => {
    const { bootstrapAdmin } = await import("./bootstrap-admin.service.js");
    const email = `ea-boot-${suffix}@test.com`;
    expect(await bootstrapAdmin(db, { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_PASSWORD: "Correct-Horse-9-Battery" })).toBe("created");
    const r = await resolveOrProvisionUser(db, { provider: "password", subject: email, email, emailVerified: true });
    expect(r.accessStatus).toBe("active");
  });

  it("loadWorkspaceAccess treats a non-uuid pseudo workspace as active", async () => {
    expect((await loadWorkspaceAccess(db, "external-email-intel")).status).toBe("active");
  });
});

describe("buildEarlyAccessEmail", () => {
  it("carries the code, the unlock link and the expiry date", async () => {
    const { buildEarlyAccessEmail } = await import("./mail.service.js");
    const mail = buildEarlyAccessEmail({
      to: "pat@example.com",
      code: "ABCD-EFGH",
      url: "https://app.skoutai.io/app/early-access?code=ABCD-EFGH",
      expiresAt: new Date("2026-12-01T10:00:00Z"),
    });
    expect(mail.subject).toBe("Your Skout AI early access is ready");
    expect(mail.text).toContain("ABCD-EFGH");
    expect(mail.text).toContain("https://app.skoutai.io/app/early-access?code=ABCD-EFGH");
    expect(mail.text).toContain("Tue, 01 Dec 2026");
    expect(mail.text.split("\n").length).toBeGreaterThan(3);
    expect(mail.html).toContain("ABCD-EFGH");
  });
});
