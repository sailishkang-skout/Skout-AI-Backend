import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@skout/db";
import { loadEnv } from "../config/env.js";
import { buildApp } from "../app.js";

async function buildTestApp() {
  const config = loadEnv();
  return buildApp({
    ...config,
    CLERK_SECRET_KEY: undefined,
    LOG_LEVEL: "fatal",
    OPENSEARCH_URL: undefined,
  });
}

function asOwner(email: string) {
  return { "x-stub-user-email": email };
}

async function resolveWorkspaceId(app: Awaited<ReturnType<typeof buildTestApp>>, email: string) {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/workspaces/current",
    headers: asOwner(email),
  });
  return (res.json() as { data: { id: string } }).data.id;
}

function syncPayload(clerkUserId: string, email: string) {
  return {
    clerkOrgId: "org_test_scim",
    members: [{ clerkUserId, email, role: "member" as const }],
  };
}

/** Unique per test run so re-running this suite against the shared/persistent Postgres doesn't
 * collide with rows a previous run left behind (users.email and users.clerkUserId are unique). */
function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("POST /sso/scim/sync-members", () => {
  it("dry-run does not create a workspace_members row", async () => {
    const app = await buildTestApp();
    if (!app.db) {
      await app.close();
      return;
    }
    const suffix = uniqueSuffix();
    const ownerEmail = `scim-dryrun-owner-${suffix}@test.com`;
    await resolveWorkspaceId(app, ownerEmail);
    const memberEmail = `scim-dryrun-member-${suffix}@test.com`;

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sso/scim/sync-members",
      headers: asOwner(ownerEmail),
      payload: { ...syncPayload(`clerk_dryrun_${suffix}`, memberEmail), dryRun: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { dryRun: boolean } };
    expect(body.data.dryRun).toBe(true);

    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.email, memberEmail));
    expect(user).toBeUndefined();

    await app.close();
  });

  it("real sync creates the user and a workspace_members row with the mapped role", async () => {
    const app = await buildTestApp();
    if (!app.db) {
      await app.close();
      return;
    }
    const suffix = uniqueSuffix();
    const ownerEmail = `scim-real-owner-${suffix}@test.com`;
    const workspaceId = await resolveWorkspaceId(app, ownerEmail);
    const memberEmail = `scim-real-member-${suffix}@test.com`;

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sso/scim/sync-members",
      headers: asOwner(ownerEmail),
      payload: syncPayload(`clerk_real_${suffix}`, memberEmail),
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { data: { applied: { created: number; updated: number } } };
    expect(body.data.applied).toEqual({ created: 1, updated: 0 });

    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.email, memberEmail));
    expect(user).toBeDefined();
    expect(user!.clerkUserId).toBe(`clerk_real_${suffix}`);

    const [membership] = await app.db
      .select()
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, user!.id)));
    expect(membership).toBeDefined();
    expect(membership!.role).toBe("member");

    await app.close();
  });

  it("re-running real sync with a changed role updates the existing membership instead of duplicating it", async () => {
    const app = await buildTestApp();
    if (!app.db) {
      await app.close();
      return;
    }
    const suffix = uniqueSuffix();
    const ownerEmail = `scim-rerun-owner-${suffix}@test.com`;
    const workspaceId = await resolveWorkspaceId(app, ownerEmail);
    const memberEmail = `scim-rerun-member-${suffix}@test.com`;
    const clerkUserId = `clerk_rerun_${suffix}`;

    await app.inject({
      method: "POST",
      url: "/api/v1/sso/scim/sync-members",
      headers: asOwner(ownerEmail),
      payload: syncPayload(clerkUserId, memberEmail),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sso/scim/sync-members",
      headers: asOwner(ownerEmail),
      payload: {
        clerkOrgId: "org_test_scim",
        members: [{ clerkUserId, email: memberEmail, role: "admin" as const }],
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { data: { applied: { created: number; updated: number } } };
    expect(body.data.applied).toEqual({ created: 0, updated: 1 });

    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.email, memberEmail));
    const memberships = await app.db
      .select()
      .from(schema.workspaceMembers)
      .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), eq(schema.workspaceMembers.userId, user!.id)));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.role).toBe("admin");

    await app.close();
  });
});
