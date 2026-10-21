import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { feedStatus, runAnalyticsFeed } from "./cops-analytics-feed.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/**
 * COPS-13 warehouse feed against real Postgres: published outbox events go to the sink once, with
 * canonical names and no free text; a refused batch is sent again; no key means no feed.
 */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-13 analytics feed (Postgres)", () => {
  const sql = postgres(url as string, { max: 1, onnotice: () => {} });
  const { db, sql: dbSql } = createDb(url as string);
  const sink = `test-${randomUUID()}`;
  let ws: string;
  const mine: string[] = [];

  beforeAll(async () => {
    const [w] = await sql`insert into workspaces (name, slug) values ('Feed', ${"feed-" + randomUUID()}) returning id`;
    ws = w.id;
    // Start the test sink at now, so only events published from here on are its concern.
    await sql`insert into cops_analytics_feed_checkpoints (sink, last_created_at, last_event_id) values (${sink}, now(), '00000000-0000-0000-0000-000000000000')`;
    for (const [type, payload] of [
      ["TicketSlaBreached", { ticket_id: randomUUID(), account_id: randomUUID(), clock: "response", priority: "p1", target_minutes: 15 }],
      ["ApprovalDecided", { approval_id: randomUUID(), proposal_id: randomUUID(), opportunity_id: randomUUID(), proposal_version: 1, status: "rejected", reason: "The CFO said the discount is insane" }],
      ["FirstLogin", { account_id: randomUUID(), user_id: randomUUID() }],
    ] as const) {
      const id = randomUUID();
      mine.push(id);
      const envelope = { event_id: id, event_type: type, schema_version: 1, tenant_id: ws, aggregate_type: "x", aggregate_id: randomUUID(), occurred_at: new Date().toISOString(), actor: { type: "system", id: null }, correlation_id: randomUUID(), causation_id: null, payload };
      await sql`insert into cops_outbox (id, tenant_id, event_type, aggregate_type, aggregate_id, envelope, published_at) values (${id}, ${ws}, ${type}, 'x', ${envelope.aggregate_id}, ${sql.json(envelope)}, now() + interval '1 second')`;
    }
    // An unpublished event is not sent.
    await sql`insert into cops_outbox (id, tenant_id, event_type, aggregate_type, aggregate_id, envelope) values (${randomUUID()}, ${ws}, 'FirstLogin', 'x', 'y', '{}'::jsonb)`;
  });
  afterAll(async () => {
    await sql.end();
    await dbSql.end();
  });

  it("is off without a PostHog key and does not move", async () => {
    expect(await runAnalyticsFeed(db, { host: "https://ph.test", sink })).toEqual({ enabled: false, sent: 0 });
    expect((await feedStatus(db, { sink }, ws)).enabled).toBe(false);
  });

  it("a refused batch keeps the checkpoint; the next run sends it once, with safe properties", async () => {
    const sent: { event: string; uuid: string; properties: Record<string, unknown> }[] = [];
    const before = await feedStatus(db, { apiKey: "phc_test", sink }, ws);
    expect(before.lag_events).toBe(3);

    const refused = await runAnalyticsFeed(db, { apiKey: "phc_test", host: "https://ph.test/", sink, fetchImpl: (async () => new Response("", { status: 503 })) as typeof fetch });
    expect(refused).toMatchObject({ enabled: true, sent: 0, error: "PostHog answered 503" });
    expect((await feedStatus(db, { apiKey: "phc_test", sink }, ws)).lag_events).toBe(3);

    const ok = (async (input: string, init: { body: string }) => {
      expect(input).toBe("https://ph.test/batch/");
      const body = JSON.parse(init.body);
      expect(body.api_key).toBe("phc_test");
      sent.push(...body.batch);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    for (let i = 0; i < 20; i++) {
      const r = await runAnalyticsFeed(db, { apiKey: "phc_test", host: "https://ph.test/", sink, fetchImpl: ok, batchSize: 500 });
      if (r.sent === 0) break;
    }
    const ours = sent.filter((e) => mine.includes(e.uuid));
    expect(ours.map((e) => e.uuid).sort()).toEqual([...mine].sort());
    expect(new Set(sent.map((e) => e.uuid)).size).toBe(sent.length);
    const breach = ours.find((e) => e.event === "cops.server.ticket_sla_breached")!;
    expect(breach.properties).toMatchObject({ priority: "p1", clock: "response", target_minutes: 15, schema_version: 1, domain_event: "TicketSlaBreached", workspace_id: ws });
    const decided = ours.find((e) => e.event === "cops.server.approval_decided")!;
    expect(decided.properties.status).toBe("rejected");
    expect(JSON.stringify(decided)).not.toContain("CFO");

    const after = await feedStatus(db, { apiKey: "phc_test", sink }, ws);
    expect(after.lag_events).toBe(0);
    expect(after.last_error).toBeNull();
    // Running again sends nothing new of ours.
    const n = sent.length;
    await runAnalyticsFeed(db, { apiKey: "phc_test", host: "https://ph.test/", sink, fetchImpl: ok });
    expect(sent.slice(n).filter((e) => mine.includes(e.uuid))).toHaveLength(0);
  });
});
