import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createDb } from "@skout/db";
import { AccountLinkError, linkAccounts } from "./cops-account-relationships.service.js";

// postgres is a dependency of packages/db; resolve it from there.
const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/** Runs only when COPS_TEST_DATABASE_URL is set (real Postgres). */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("linkAccounts (Postgres)", () => {
  const sql = postgres(url as string, { max: 1 });
  const { db } = createDb(url as string);

  async function workspace(label: string): Promise<string> {
    const [row] = await sql`insert into workspaces (name, slug) values (${label}, ${`link-${label}-${Date.now()}-${Math.random()}`}) returning id`;
    return row.id as string;
  }
  async function company(workspaceId: string, name: string): Promise<string> {
    const [row] = await sql`insert into companies (workspace_id, name) values (${workspaceId}, ${name}) returning id`;
    return row.id as string;
  }

  it("links two accounts in the same workspace, and a repeat returns the same row", async () => {
    const ws = await workspace("same");
    const parent = await company(ws, "Parent");
    const child = await company(ws, "Child");
    const first = await linkAccounts(db, { workspaceId: ws, parentAccountId: parent, childAccountId: child, relationship: "subsidiary" });
    const second = await linkAccounts(db, { workspaceId: ws, parentAccountId: parent, childAccountId: child, relationship: "subsidiary" });
    expect(second).toBe(first);
  });

  it("rejects linking an account from another workspace", async () => {
    const a = await workspace("A");
    const b = await workspace("B");
    const mine = await company(a, "Mine");
    const theirs = await company(b, "Theirs");
    await expect(
      linkAccounts(db, { workspaceId: a, parentAccountId: mine, childAccountId: theirs, relationship: "partner" })
    ).rejects.toMatchObject({ code: "ACCOUNT_NOT_IN_WORKSPACE" });
  });

  it("rejects linking an account to itself", async () => {
    const ws = await workspace("self");
    const only = await company(ws, "Only");
    await expect(
      linkAccounts(db, { workspaceId: ws, parentAccountId: only, childAccountId: only, relationship: "same" })
    ).rejects.toBeInstanceOf(AccountLinkError);
  });

  it("closes the connections", async () => {
    await sql.end();
  });
});
