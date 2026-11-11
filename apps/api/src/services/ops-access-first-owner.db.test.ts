import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { claimFirstOpsAccess } from "./ops-access.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

/**
 * COPS-15 first holder on a new environment: only a verified @skoutai.io Owner, and only while
 * nobody has ever held Ops access. Other test files share this database, so the "nobody yet" case
 * runs only when the database really has no holder; the refusals are checked either way.
 */
maybe("COPS-15 first Owner gets Ops access (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  let ws: string;
  const make = async (email: string, role: string, verified: boolean) => {
    const [u] = await sql`insert into users (email) values (${email}) returning id`;
    await sql`insert into workspace_members (workspace_id, user_id, role) values (${ws}, ${u.id}, ${role})`;
    await sql`insert into auth_identities (user_id, provider, provider_subject, email_at_link, email_verified_at)
      values (${u.id}, 'password', ${randomUUID()}, ${email}, ${verified ? new Date() : null})`;
    return u.id as string;
  };
  const tag = () => randomUUID().slice(0, 8);
  const holds = async (userId: string) =>
    (await sql`select count(*)::int as n from workspace_member_roles m join roles r on r.id = m.role_id where m.user_id = ${userId} and r.key = 'ops_access'`)[0].n as number;
  const fresh = async () =>
    (await sql`select count(*)::int as n from workspace_member_roles m join roles r on r.id = m.role_id where r.key = 'ops_access'`)[0].n === 0 &&
    (await sql`select count(*)::int as n from audit_logs where action = 'ops_access.granted'`)[0].n === 0;

  beforeAll(async () => {
    const [w] = await sql`insert into workspaces (name, slug) values ('First owner (test)', ${"first-owner-" + randomUUID()}) returning id`;
    ws = w.id;
  });
  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  it("never gives it to a customer email, a non-Owner, or an unverified email", async () => {
    const customer = await make(`owner-${tag()}@customer.example`, "owner", true);
    const admin = await make(`admin-${tag()}@skoutai.io`, "admin", true);
    const unverified = await make(`new-${tag()}@skoutai.io`, "owner", false);
    for (const id of [customer, admin, unverified]) {
      expect(await claimFirstOpsAccess(db, ws, id)).toBe(false);
      expect(await holds(id)).toBe(0);
    }
  });

  it("gives the first verified Skout Owner Ops access once; after that nobody claims it", async () => {
    const first = await make(`owner-${tag()}@skoutai.io`, "owner", true);
    const second = await make(`owner2-${tag()}@SkoutAI.io`, "owner", true);
    if (await fresh()) {
      expect(await claimFirstOpsAccess(db, ws, first)).toBe(true);
      expect(await holds(first)).toBe(1);
      const audit = await sql`select count(*)::int as n from audit_logs where workspace_id = ${ws} and action = 'ops_access.granted' and after_state->>'via' = 'first_owner'`;
      expect(audit[0].n).toBe(1);
    }
    // Someone holds it now (this test, or another file): no one else becomes "first".
    expect(await claimFirstOpsAccess(db, ws, second)).toBe(false);
    expect(await holds(second)).toBe(0);
  });
});
