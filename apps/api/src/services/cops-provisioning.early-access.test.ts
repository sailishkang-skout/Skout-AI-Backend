import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDb, schema } from "@skout/db";
import { resolveOrProvisionUser } from "@skout/auth";
import { loadEnv } from "../config/env.js";
import { startProvisioning } from "./cops-provisioning.service.js";
import { planLimits } from "./cops-usage.service.js";

const base = loadEnv();
const hasDatabase = Boolean(base.DATABASE_URL);

/** Provisioning after early access: provisioned workspaces are active, carry plan.code, and win sign-in. */
describe.skipIf(!hasDatabase)("COPS-04 provisioning with early access", () => {
  const { db, sql } = createDb(base.DATABASE_URL!);
  const suffix = Math.random().toString(36).slice(2, 10);
  let operator: { workspaceId: string; userId: string };
  const deps = { inviteBaseUrl: "http://app.test/app", sendInvite: async () => ({ sent: false }) };

  async function opportunity() {
    const ws = operator.workspaceId;
    const [company] = await sql`insert into companies (workspace_id, name) values (${ws}, ${"EA Co " + randomUUID().slice(0, 6)}) returning id`;
    const [pipeline] = await sql`insert into pipelines (workspace_id, name) values (${ws}, 'P') returning id`;
    const [stage] = await sql`insert into pipeline_stages (pipeline_id, name, order_index) values (${pipeline!.id}, 'S', 1) returning id`;
    const [deal] = await sql`insert into deals (workspace_id, company_id, pipeline_id, stage_id, name) values (${ws}, ${company!.id}, ${pipeline!.id}, ${stage!.id}, 'D') returning id`;
    await sql`insert into commercial_gates (opportunity_id, workspace_id, fired_at, fired_policy) values (${deal!.id}, ${ws}, now(), 'trial_approval_only')`;
    return { accountId: company!.id as string, opportunityId: deal!.id as string };
  }

  async function provision(adminEmail: string, plan: string) {
    const { accountId, opportunityId } = await opportunity();
    const { provisioning } = await startProvisioning(
      db,
      { workspaceId: operator.workspaceId, userId: operator.userId, requestId: randomUUID() },
      accountId,
      randomUUID(),
      { opportunity_id: opportunityId, admin_email: adminEmail, plan, trial_days: 14, credits: 100, integrations: ["crm"] },
      deps
    );
    expect(provisioning.status).toBe("succeeded");
    return provisioning.provisioned_workspace_id!;
  }

  beforeAll(async () => {
    const email = `ea-prov-op-${suffix}@test.com`;
    const r = await resolveOrProvisionUser(db, { provider: "password", subject: email, email, emailVerified: true });
    operator = { workspaceId: r.workspaceId, userId: r.userId };
  });

  afterAll(async () => {
    await sql.end();
  });

  it("a provisioned workspace is active", async () => {
    const id = await provision(`ea-prov-a-${suffix}@cust.test`, "full");
    const [ws] = await db.select({ s: schema.workspaces.accessStatus }).from(schema.workspaces).where(eq(schema.workspaces.id, id));
    expect(ws!.s).toBe("active");
  });

  it("a multichannel provisioning gets multichannel limits before any subscription", async () => {
    const id = await provision(`ea-prov-m-${suffix}@cust.test`, "multichannel");
    expect((await planLimits(db, id)).plan).toBe("multichannel");
  });

  it("provisioned admin with an earlier self-signup lands in the provisioned workspace", async () => {
    const email = `ea-prov-self-${suffix}@cust.test`;
    const own = await resolveOrProvisionUser(db, { provider: "google", subject: `g-${suffix}`, email, emailVerified: true }, undefined, undefined, undefined, {
      selfSignup: { method: "google" },
    });
    expect(own.accessStatus).toBe("pending");
    const id = await provision(email, "full");
    const signIn = await resolveOrProvisionUser(db, { provider: "google", subject: `g-${suffix}`, email, emailVerified: true });
    expect(signIn.workspaceId).toBe(id);
    expect(signIn.accessStatus).toBe("active");
    expect(signIn.role).toBe("owner");
  });
});
