import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { bootstrapOpsAccess } from "./ops-access.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

/** COPS-15 first rollout: current staff get Ops access once, never again after that. */
maybe("COPS-15 Ops access first rollout (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  let ws: string;
  const users: string[] = [];
  const holders = async () => (await sql`select count(*)::int as n from workspace_member_roles m join roles r on r.id = m.role_id where m.workspace_id = ${ws} and r.key = 'ops_access'`)[0].n as number;

  beforeAll(async () => {
    const [w] = await sql`insert into workspaces (name, slug) values ('Skout internal (test)', ${"internal-" + randomUUID()}) returning id`;
    ws = w.id;
    for (const role of ["owner", "member"]) {
      const [u] = await sql`insert into users (email) values (${`staff-${randomUUID().slice(0, 8)}@skout.test`}) returning id`;
      users.push(u.id);
      await sql`insert into workspace_members (workspace_id, user_id, role) values (${ws}, ${u.id}, ${role})`;
    }
  });
  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  it("grants every member once, audited, and never again (a later removal stays removed)", async () => {
    expect(await bootstrapOpsAccess(db, { INTERNAL_WORKSPACE_ID: ws })).toBe(2);
    expect(await holders()).toBe(2);
    const audit = await sql`select count(*)::int as n from audit_logs where workspace_id = ${ws} and action = 'ops_access.granted' and after_state->>'via' = 'first_rollout'`;
    expect(audit[0].n).toBe(2);
    // A second start changes nothing.
    expect(await bootstrapOpsAccess(db, { INTERNAL_WORKSPACE_ID: ws })).toBe(0);
    // An Admin removes everyone's Ops access: a restart must not hand it back.
    await sql`delete from workspace_member_roles where workspace_id = ${ws} and role_id in (select id from roles where key = 'ops_access')`;
    expect(await bootstrapOpsAccess(db, { INTERNAL_WORKSPACE_ID: ws })).toBe(0);
    expect(await holders()).toBe(0);
  });

  it("does nothing without an internal workspace", async () => {
    expect(await bootstrapOpsAccess(db, { INTERNAL_WORKSPACE_ID: undefined })).toBe(0);
  });
});
