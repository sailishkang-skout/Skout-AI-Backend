import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { getMemberPermissions } from "@skout/auth";
import { createRole, deleteRole, getMemberRoles, listRoles, setMemberRoles, updateRole, type RoleCtx } from "./cops-roles.service.js";
import { createTeamService } from "./team.service.js";
import { canSeeAccount, getDataScope, setDataScope } from "./cops-data-scope.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/**
 * COPS-14 part C against real Postgres (needs the backfill-rbac seed, as CI runs it): custom roles
 * over the permission catalog, no privilege escalation, member grants that keep the base role, and
 * a team role change that no longer wipes CustomerOps and custom grants.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-14 custom roles (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  let ws: string;
  let otherWs: string;
  let owner: string;
  let member: string;
  let ctx: RoleCtx;
  const roleId = async (key: string) => (await sql`select id from roles where key = ${key} and workspace_id is null`)[0].id as string;

  beforeAll(async () => {
    const [w] = await sql`insert into workspaces (name, slug) values ('Roles', ${"roles-" + randomUUID()}) returning id`;
    const [w2] = await sql`insert into workspaces (name, slug) values ('Roles other', ${"roles2-" + randomUUID()}) returning id`;
    ws = w.id;
    otherWs = w2.id;
    const [o] = await sql`insert into users (email) values (${`own-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
    const [m] = await sql`insert into users (email) values (${`mem-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
    owner = o.id;
    member = m.id;
    await sql`insert into workspace_members (workspace_id, user_id, role) values (${ws}, ${owner}, 'owner'), (${ws}, ${member}, 'member')`;
    await sql`insert into workspace_member_roles (workspace_id, user_id, role_id) values (${ws}, ${owner}, ${await roleId("owner")}), (${ws}, ${member}, ${await roleId("member")})`;
    ctx = { workspaceId: ws, userId: owner, requestId: randomUUID(), permissions: await getMemberPermissions(db, ws, owner) };
  });
  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  it("lists base and CustomerOps roles; creates a custom role; rejects a duplicate name, an unknown key and an escalation", async () => {
    const before = await listRoles(db, ws);
    expect(before.find((r) => r.key === "owner")).toMatchObject({ kind: "base", editable: false });
    expect(before.find((r) => r.key === "finance")).toMatchObject({ kind: "system", editable: false });

    const role = await createRole(db, ctx, { name: "Renewals desk", permission_keys: ["crm:read", "commercial:read", "commercial:send"] });
    expect(role).toMatchObject({ kind: "custom", editable: true, permission_keys: ["commercial:read", "commercial:send", "crm:read"], member_count: 0 });
    expect((await listRoles(db, otherWs)).some((r) => r.id === role.id)).toBe(false);

    await expect(createRole(db, ctx, { name: "renewals DESK" })).rejects.toMatchObject({ code: "BUSINESS_STATE_CONFLICT" });
    await expect(createRole(db, ctx, { name: "Bad", permission_keys: ["crm:fly"] })).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { unknown: ["crm:fly"] } });
    const limited = { ...ctx, permissions: ["crm:read", "admin:admin"] };
    await expect(createRole(db, limited, { name: "Sneaky", permission_keys: ["billing:refund"] })).rejects.toMatchObject({ code: "FORBIDDEN", details: { missing: ["billing:refund"] } });

    const clone = await createRole(db, ctx, { name: "Finance copy", clone_from_role_id: await roleId("finance") });
    expect(clone.permission_keys).toEqual((before.find((r) => r.key === "finance")!.permission_keys));
    const [audit] = await sql`select count(*)::int as n from audit_logs where workspace_id = ${ws} and action = 'role.created'`;
    expect(audit.n).toBe(2);
  });

  it("edits only custom roles, with a reason and before/after in the audit", async () => {
    const [role] = (await listRoles(db, ws)).filter((r) => r.name === "Renewals desk");
    const updated = await updateRole(db, ctx, role!.id, { permission_keys: ["crm:read"], reason: "Desk no longer sends quotes" });
    expect(updated.permission_keys).toEqual(["crm:read"]);
    const [row] = await sql`select before_state, after_state, reason from audit_logs where workspace_id = ${ws} and action = 'role.updated' and entity_id = ${role!.id}`;
    expect(row.reason).toBe("Desk no longer sends quotes");
    expect(row.before_state.permission_keys).toEqual(["commercial:read", "commercial:send", "crm:read"]);
    expect(row.after_state.permission_keys).toEqual(["crm:read"]);
    await expect(updateRole(db, ctx, await roleId("finance"), { name: "Money", reason: "rename" })).rejects.toMatchObject({ code: "BUSINESS_STATE_CONFLICT" });
  });

  it("grants CustomerOps and custom roles while keeping the base role; refuses base roles, foreign roles and escalation", async () => {
    const [desk] = (await listRoles(db, ws)).filter((r) => r.name === "Renewals desk");
    const finance = await roleId("finance");
    const result = await setMemberRoles(db, ctx, member, [finance, desk!.id], "Covers renewals and invoices");
    expect(result.roles.map((r) => r.key).sort()).toEqual(["finance", "member", desk!.key].sort());
    const perms = await getMemberPermissions(db, ws, member);
    expect(perms).toEqual(expect.arrayContaining(["billing:refund", "crm:read", "sequences:send"]));

    await expect(setMemberRoles(db, ctx, member, [await roleId("admin")], "promote")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const [foreign] = await sql`insert into roles (workspace_id, key, name) values (${otherWs}, ${"custom_" + randomUUID().slice(0, 8)}, 'Other desk') returning id`;
    await expect(setMemberRoles(db, ctx, member, [foreign.id], "x")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(setMemberRoles(db, { ...ctx, permissions: ["admin:admin", "crm:read"] }, member, [finance], "x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getMemberRoles(db, ws, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Removing every extra role keeps the base role.
    const cleared = await setMemberRoles(db, ctx, member, [desk!.id], "Finance handed back");
    expect(cleared.roles.map((r) => r.key).sort()).toEqual(["member", desk!.key].sort());
  });

  it("a team role change replaces only the base role, so CustomerOps and custom grants survive", async () => {
    const [desk] = (await listRoles(db, ws)).filter((r) => r.name === "Renewals desk");
    await setMemberRoles(db, ctx, member, [await roleId("finance"), desk!.id], "Back on finance");
    await createTeamService(db).updateMemberRole(ws, member, "admin", owner, "owner");
    const after = await getMemberRoles(db, ws, member);
    expect(after.roles.map((r) => r.key).sort()).toEqual(["admin", "finance", desk!.key].sort());
  });

  it("a custom role still held cannot be deleted; once released it can, with an audit row", async () => {
    const [desk] = (await listRoles(db, ws)).filter((r) => r.name === "Renewals desk");
    await expect(deleteRole(db, ctx, desk!.id, "Desk closed")).rejects.toMatchObject({ code: "BUSINESS_STATE_CONFLICT", details: { member_count: 1 } });
    await setMemberRoles(db, ctx, member, [], "Desk closed");
    expect(await deleteRole(db, ctx, desk!.id, "Desk closed")).toEqual({ id: desk!.id, deleted: true });
    const [audit] = await sql`select count(*)::int as n from audit_logs where workspace_id = ${ws} and action in ('role.deleted', 'member.roles_updated')`;
    expect(audit.n).toBeGreaterThanOrEqual(5);
  });

  it("limits a member to their own accounts (owner or CSM), audited; an owner cannot be limited", async () => {
    const [mine] = await sql`insert into companies (workspace_id, name, csm_id) values (${ws}, 'CSM of', ${member}) returning id`;
    const [theirs] = await sql`insert into companies (workspace_id, name) values (${ws}, 'Not mine') returning id`;
    expect(await canSeeAccount(db, ws, member, theirs.id)).toBe(true);
    await expect(setDataScope(db, ctx, owner, "own_accounts", "Test")).rejects.toMatchObject({ code: "BUSINESS_STATE_CONFLICT" });
    expect(await setDataScope(db, ctx, member, "own_accounts", "Regional rep")).toEqual({ user_id: member, scope: "own_accounts" });
    expect(await getDataScope(db, ws, member)).toBe("own_accounts");
    expect(await canSeeAccount(db, ws, member, mine.id)).toBe(true);
    expect(await canSeeAccount(db, ws, member, theirs.id)).toBe(false);
    expect(await getDataScope(db, otherWs, member)).toBe("all");
    await setDataScope(db, ctx, member, "all", "Back to all accounts");
    expect(await canSeeAccount(db, ws, member, theirs.id)).toBe(true);
    const rows = await sql`select before_state, after_state from audit_logs where workspace_id = ${ws} and action = 'member.data_scope_updated' order by created_at`;
    expect(rows.map((r: { after_state: { scope: string } }) => r.after_state.scope)).toEqual(["own_accounts", "all"]);
  });
});
