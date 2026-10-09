import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createDb } from "@skout/db";
import { ActivitiesService } from "./activities.service.js";

/**
 * COPS-02: recording an activity writes an ActivityRecorded event in the same transaction, with
 * the account resolved from the activity's entity. Runs only when COPS_TEST_DATABASE_URL is set.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

maybe("ActivitiesService.record emits ActivityRecorded (Postgres)", () => {
  const sql = postgres(url as string, { max: 1 });
  const { db } = createDb(url as string);
  const svc = new ActivitiesService(db);

  it("writes one outbox event per activity, resolving the account from a contact", async () => {
    const [ws] = await sql`insert into workspaces (name, slug) values ('activity events', ${"act-" + Date.now() + "-" + Math.random()}) returning id`;
    const [co] = await sql`insert into companies (workspace_id, name) values (${ws.id}, 'Activity Co') returning id`;
    const [ct] = await sql`insert into contacts (workspace_id, company_id, first_name, email) values (${ws.id}, ${co.id}, 'Act', ${"act." + Date.now() + "@example.test"}) returning id`;

    const call = await svc.record(ws.id, undefined, "contact", ct.id, "call", "Intro call");
    const note = await svc.record(ws.id, undefined, "company", co.id, "note", undefined, "pricing concerns", "internal");

    const rows = await sql`select envelope from cops_outbox where tenant_id = ${ws.id} and event_type = 'ActivityRecorded' order by created_at`;
    expect(rows.length).toBe(2);
    expect(rows[0].envelope.payload).toMatchObject({ activity_id: call.id, account_id: co.id, activity_type: "call", visibility: "public" });
    expect(rows[1].envelope.payload).toMatchObject({ activity_id: note.id, account_id: co.id, activity_type: "note", visibility: "internal" });

    const [stored] = await sql`select visibility from activities where id = ${note.id}`;
    expect(stored.visibility).toBe("internal");
  });

  it("closes the connection", async () => {
    await sql.end();
  });
});
