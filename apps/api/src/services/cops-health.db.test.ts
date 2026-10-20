import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createDb } from "@skout/db";
import { getAccountHealth, getAccountHealthHistory, recordAccountHealth, saveHealthModel, sweepWorkspaceHealth } from "./cops-health.service.js";

const postgres = createRequire(new URL("../../../../packages/db/package.json", import.meta.url))("postgres") as (url: string, options?: object) => any;

/** COPS-11 health model against real Postgres. Runs only when COPS_TEST_DATABASE_URL is set. */
const url = process.env.COPS_TEST_DATABASE_URL;
const maybe = url ? describe : describe.skip;

maybe("COPS-11 account health (Postgres)", () => {
  const sql = postgres(url as string, { max: 1 });
  const { db } = createDb(url as string);

  async function account() {
    const tag = randomUUID().slice(0, 8);
    const [ws] = await sql`insert into workspaces (name, slug) values (${`cs-${tag}`}, ${`cs-health-${tag}`}) returning id`;
    const [acc] = await sql`insert into companies (workspace_id, name, status) values (${ws.id}, ${`Acc ${tag}`}, 'customer') returning id`;
    return { workspaceId: ws.id as string, accountId: acc.id as string };
  }

  it("records an explainable score on the account and in history, and the trend is queryable", async () => {
    const a = await account();
    const r = await recordAccountHealth(db, a.workspaceId, a.accountId, { requestId: randomUUID() });
    const [acc] = await sql`select health_score, health_state, renewal_risk, health_computed_at from companies where id = ${a.accountId}`;
    expect(acc).toMatchObject({ health_score: r.score, health_state: r.state, renewal_risk: r.renewalRisk });
    const latest = await getAccountHealth(db, a.workspaceId, a.accountId);
    expect(latest!.score).toBe(r.score);
    expect((latest!.factors as { reason: string }[]).length).toBeGreaterThan(5);

    await sql`insert into engineering_tickets (workspace_id, account_id, title, severity, status) values (${a.workspaceId}, ${a.accountId}, 'Broken export', 'critical', 'new')`;
    await recordAccountHealth(db, a.workspaceId, a.accountId, { requestId: randomUUID() });
    const history = await getAccountHealthHistory(db, a.workspaceId, a.accountId);
    expect(history).toHaveLength(2);
    expect(history[0]!.score).toBeLessThan(history[1]!.score);
  });

  it("moves the health lifecycle through watch, and raises each signal once per cycle", async () => {
    const a = await account();
    for (let i = 0; i < 3; i++) {
      await sql`insert into engineering_tickets (workspace_id, account_id, title, severity, status) values (${a.workspaceId}, ${a.accountId}, ${`T${i}`}, 'high', 'new')`;
    }
    const first = await recordAccountHealth(db, a.workspaceId, a.accountId, { requestId: randomUUID() });
    expect(first.newSignals).toContain("ticket_heavy");
    const second = await recordAccountHealth(db, a.workspaceId, a.accountId, { requestId: randomUUID() });
    expect(second.newSignals).toEqual([]);
    const events = await sql`select envelope->'payload' as p from cops_outbox where tenant_id = ${a.workspaceId} and event_type = 'HealthSignalDetected'`;
    expect(events.filter((e: { p: { signal: string } }) => e.p.signal === "ticket_heavy")).toHaveLength(1);
    expect(events[0].p.evidence.length).toBeGreaterThan(0);

    const transitions = await sql`select envelope->'payload'->>'from' as "from", envelope->'payload'->>'to' as "to" from cops_outbox where tenant_id = ${a.workspaceId} and event_type = 'LifecycleTransitioned' order by created_at`;
    if (first.state === "at_risk") expect(transitions.map((t: { to: string }) => t.to)).toEqual(["watch", "at_risk"]);
    else expect(transitions.map((t: { to: string }) => t.to)).toEqual(first.state === "watch" ? ["watch"] : []);
  });

  it("a workspace can change the model; scores record the version they used", async () => {
    const a = await account();
    const model = await saveHealthModel(db, a.workspaceId, { weights: { adoption: 0, relationship: 0, support: 100, commercial: 0, payment: 0 } }, null);
    expect(model.version).toBe(1);
    const r = await recordAccountHealth(db, a.workspaceId, a.accountId, { requestId: randomUUID() });
    expect(r.modelVersion).toBe(1);
    expect(r.score).toBe(r.dimensions.support.score);
    await expect(saveHealthModel(db, a.workspaceId, { thresholds: { healthy: 30, atRisk: 50 } }, null)).rejects.toMatchObject({ statusCode: 422 });
  });

  it("the sweep scores customer accounts and turns the retention expansion rule into a signal, once a month", async () => {
    const a = await account();
    const expansion = [{ companyId: a.accountId, signalType: "hiring_surge", detectedAt: "2026-10-18T00:00:00Z" }];
    const first = await sweepWorkspaceHealth(db, a.workspaceId, expansion);
    expect(first.scored).toBe(1);
    expect(first.raised).toEqual([{ accountId: a.accountId, signals: ["expansion_signal"] }]);
    expect((await sweepWorkspaceHealth(db, a.workspaceId, expansion)).raised).toEqual([]);
    const [e] = await sql`select envelope->'payload' as p from cops_outbox where tenant_id = ${a.workspaceId} and event_type = 'HealthSignalDetected'`;
    expect(e.p).toMatchObject({ signal: "expansion_signal", evidence: [{ factor: "expansion", reason: "New hiring surge signal on 2026-10-18" }] });
  });
});
