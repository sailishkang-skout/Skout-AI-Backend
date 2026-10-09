import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { canContact } from "./cops-can-contact.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/** COPS-05 canContact() against a real Postgres: every blocking source, and a clean address passes. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-05 canContact gate (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  const config = { EMAIL_INTEL_SERVICE_URL: undefined, EMAIL_INTEL_TIMEOUT_MS: 1000 } as never;
  let ws = "";
  let other = "";
  let contactId = "";
  const stamp = randomUUID().slice(0, 8);
  const addr = (l: string) => `${l}-${stamp}@customer.test`;

  beforeAll(async () => {
    [{ id: ws }] = await sql`insert into workspaces (name, slug) values ('cc', ${"cc-" + stamp}) returning id`;
    [{ id: other }] = await sql`insert into workspaces (name, slug) values ('cc2', ${"cc2-" + stamp}) returning id`;
    const [co] = await sql`insert into companies (workspace_id, name) values (${ws}, 'Customer') returning id`;
    [{ id: contactId }] = await sql`insert into contacts (workspace_id, company_id, first_name, email) values (${ws}, ${co.id}, 'Ada', ${addr("ok")}) returning id`;
    await sql`insert into suppressions (workspace_id, email) values (${ws}, ${addr("unsub")})`;
    await sql`insert into contact_channels (workspace_id, contact_id, channel, value, suppressed) values (${ws}, ${contactId}, 'email', ${addr("dnc")}, true)`;
    await sql`insert into contact_channels (workspace_id, contact_id, channel, value, bounce_status) values (${ws}, ${contactId}, 'email', ${addr("bounced")}, 'hard')`;
    await sql`insert into contact_channels (workspace_id, contact_id, channel, value, bounce_status) values (${ws}, ${contactId}, 'email', ${addr("soft")}, 'soft')`;
  });

  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  const check = (email: string, extra: Partial<Parameters<typeof canContact>[2]> = {}, workspaceId = ws) =>
    canContact(db, config, { workspaceId, email, purpose: "transactional", ...extra });

  it("allows a clean address and a soft bounce", async () => {
    expect(await check(addr("ok"))).toEqual({ allowed: true });
    expect(await check(addr("soft"))).toEqual({ allowed: true });
  });

  it("blocks invalid, suppressed, do-not-contact and hard-bounced addresses (case-insensitive)", async () => {
    expect(await check("not-an-email")).toEqual({ allowed: false, reason: "invalid_email" });
    expect(await check(addr("unsub").toUpperCase())).toEqual({ allowed: false, reason: "suppressed" });
    expect(await check(addr("dnc"))).toEqual({ allowed: false, reason: "channel_suppressed" });
    expect(await check(addr("bounced"), { contactId })).toEqual({ allowed: false, reason: "hard_bounce" });
  });

  it("scopes every check to the workspace", async () => {
    expect(await check(addr("unsub"), {}, other)).toEqual({ allowed: true });
    expect(await check(addr("bounced"), {}, other)).toEqual({ allowed: true });
  });

  it("asks for prospect consent only for sales outreach", async () => {
    const prospectId = `p-${stamp}`;
    expect(await check(addr("ok"), { purpose: "transactional", prospectId })).toEqual({ allowed: true });
    expect(await check(addr("ok"), { purpose: "outreach", prospectId })).toEqual({ allowed: false, reason: "no_consent" });
    await sql`insert into consents (workspace_id, subject_type, subject_id, type, basis) values (${ws}, 'prospect', ${prospectId}, 'email', 'legitimate_interest')`;
    expect(await check(addr("ok"), { purpose: "outreach", prospectId })).toEqual({ allowed: true });
  });
});
