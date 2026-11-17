import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, resolveDatabaseUrl, schema, type Db } from "@skout/db";
import { resolveOrProvisionUser } from "./auth.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.resolve(__dirname, "../../../.env"));
} catch {
  // optional: CI provides DATABASE_URL directly
}

const hasDatabase = Boolean(process.env.DATABASE_URL || process.env.DATABASE_HOST);

describe.skipIf(!hasDatabase)("resolveOrProvisionUser — early access", () => {
  let db: Db;
  let sql: ReturnType<typeof createDb>["sql"];
  const suffix = Math.random().toString(36).slice(2, 10);
  let n = 0;
  const email = () => `ea-auth-${suffix}-${++n}@test.com`;
  const password = (e: string) => ({ provider: "password", subject: e, email: e, emailVerified: true, name: "Ada Test" });

  async function workspace(id: string) {
    const [ws] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id));
    return ws!;
  }
  async function balance(workspaceId: string) {
    const [row] = await db.select().from(schema.creditBalances).where(eq(schema.creditBalances.workspaceId, workspaceId));
    return row?.balance ?? null;
  }
  async function activeWorkspace(name: string) {
    const [ws] = await db.insert(schema.workspaces).values({ name, slug: `ea-${name}-${suffix}-${++n}` }).returning();
    return ws!;
  }

  beforeAll(() => {
    const created = createDb(resolveDatabaseUrl());
    db = created.db;
    sql = created.sql;
  });

  afterAll(async () => {
    await sql.end();
  });

  it("selfSignup creates a pending workspace and an access request, no credits", async () => {
    const e = email();
    const result = await resolveOrProvisionUser(db, password(e), undefined, undefined, undefined, { selfSignup: { method: "password" } });
    expect(result.accessStatus).toBe("pending");
    expect((await workspace(result.workspaceId)).accessStatus).toBe("pending");
    expect(await balance(result.workspaceId)).toBeNull();
    const [req] = await db.select().from(schema.accessRequests).where(eq(schema.accessRequests.workspaceId, result.workspaceId));
    expect(req).toMatchObject({ status: "pending", email: e, fullName: "Ada Test", signupMethod: "password", userId: result.userId });
  });

  it("without selfSignup the personal workspace is active and gets 500 credits", async () => {
    const result = await resolveOrProvisionUser(db, password(email()));
    expect(result.accessStatus).toBe("active");
    expect((await workspace(result.workspaceId)).accessStatus).toBe("active");
    expect(await balance(result.workspaceId)).toBe(500);
  });

  it("second sign-in of a pending user grants no credits", async () => {
    const e = email();
    const first = await resolveOrProvisionUser(db, password(e), undefined, undefined, undefined, { selfSignup: { method: "google" } });
    const again = await resolveOrProvisionUser(db, password(e));
    expect(again.workspaceId).toBe(first.workspaceId);
    expect(again.accessStatus).toBe("pending");
    expect(await balance(first.workspaceId)).toBeNull();
  });

  it("invited email never gets a pending workspace even with selfSignup", async () => {
    const e = email();
    const ws = await activeWorkspace("inviter");
    await db.insert(schema.workspaceInvites).values({
      workspaceId: ws.id,
      email: e,
      role: "member",
      token: `tok-${suffix}-${++n}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const result = await resolveOrProvisionUser(db, password(e), undefined, undefined, undefined, { selfSignup: { method: "password" } });
    expect(result.workspaceId).toBe(ws.id);
    expect(result.accessStatus).toBe("active");
    const reqs = await db.select().from(schema.accessRequests).where(eq(schema.accessRequests.email, e));
    expect(reqs).toHaveLength(0);
  });

  it("prefers an active workspace", async () => {
    const e = email();
    const first = await resolveOrProvisionUser(db, password(e), undefined, undefined, undefined, { selfSignup: { method: "password" } });
    const ws = await activeWorkspace("team");
    await db.insert(schema.workspaceMembers).values({ workspaceId: ws.id, userId: first.userId, role: "member" });
    const again = await resolveOrProvisionUser(db, password(e));
    expect(again.workspaceId).toBe(ws.id);
    expect(again.accessStatus).toBe("active");
  });

  it("a pending user who is invited elsewhere lands in the invited active workspace", async () => {
    const e = email();
    await resolveOrProvisionUser(db, password(e), undefined, undefined, undefined, { selfSignup: { method: "password" } });
    const ws = await activeWorkspace("provisioned");
    await db.insert(schema.workspaceInvites).values({
      workspaceId: ws.id,
      email: e,
      role: "owner",
      token: `tok-${suffix}-${++n}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const again = await resolveOrProvisionUser(db, password(e));
    expect(again.workspaceId).toBe(ws.id);
    expect(again.role).toBe("owner");
  });

  it("existing user signing in with selfSignup keeps their active workspace", async () => {
    const e = email();
    const first = await resolveOrProvisionUser(db, password(e));
    const again = await resolveOrProvisionUser(db, password(e), undefined, undefined, undefined, { selfSignup: { method: "google" } });
    expect(again.workspaceId).toBe(first.workspaceId);
    expect(again.accessStatus).toBe("active");
    const members = await db
      .select()
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.userId, first.userId)));
    expect(members).toHaveLength(1);
  });
});
