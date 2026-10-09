import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createDb } from "@skout/db";
import { writeContactChannel } from "./cops-contact-channels.service.js";

/** Runs only when COPS_TEST_DATABASE_URL is set (real Postgres). */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

maybe("writeContactChannel (verified vs inferred rule)", () => {
  const sql = postgres(url as string, { max: 1 });
  const { db } = createDb(url as string);
  const stamp = Date.now();

  async function contact(): Promise<{ ws: string; contactId: string }> {
    const [w] = await sql`insert into workspaces (name, slug) values ('channels', ${"channels-" + stamp + "-" + Math.random()}) returning id`;
    const [c] = await sql`insert into companies (workspace_id, name) values (${w.id}, 'channels co') returning id`;
    const [k] = await sql`insert into contacts (workspace_id, company_id, first_name, email) values (${w.id}, ${c.id}, 'Ch', ${"ch." + stamp + "@example.test"}) returning id`;
    return { ws: w.id as string, contactId: k.id as string };
  }

  it("inserts a new value, then keeps a verified value against an unverified write", async () => {
    const { ws, contactId } = await contact();
    const value = "verified@example.test";
    expect(await writeContactChannel(db, { workspaceId: ws, contactId, channel: "email", value, verified: true, confidence: 0.9, source: "user" })).toBe("inserted");
    expect(await writeContactChannel(db, { workspaceId: ws, contactId, channel: "email", value, verified: false, confidence: 0.99, source: "enrichment" })).toBe("kept_verified");
    const [row] = await sql`select verified, source from contact_channels where workspace_id = ${ws} and contact_id = ${contactId} and value = ${value}`;
    expect(row.verified).toBe(true);
    expect(row.source).toBe("user");
  });

  it("does not replace a stored value with a lower-confidence unverified observation", async () => {
    const { ws, contactId } = await contact();
    const value = "inferred@example.test";
    await writeContactChannel(db, { workspaceId: ws, contactId, channel: "email", value, verified: false, confidence: 0.8, source: "inferred" });
    expect(await writeContactChannel(db, { workspaceId: ws, contactId, channel: "email", value, verified: false, confidence: 0.4, source: "inferred" })).toBe("kept_higher_confidence");
  });

  it("lets a verified write update a verified row, and an unverified higher-confidence write update an unverified one", async () => {
    const { ws, contactId } = await contact();
    const value = "updatable@example.test";
    await writeContactChannel(db, { workspaceId: ws, contactId, channel: "email", value, verified: false, confidence: 0.5, source: "inferred" });
    expect(await writeContactChannel(db, { workspaceId: ws, contactId, channel: "email", value, verified: false, confidence: 0.7, source: "enrichment" })).toBe("updated");
    expect(await writeContactChannel(db, { workspaceId: ws, contactId, channel: "email", value, verified: true, confidence: 0.6, source: "user" })).toBe("updated");
  });

  it("closes the connection", async () => {
    await sql.end();
  });
});
