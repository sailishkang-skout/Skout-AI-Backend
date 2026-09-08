import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, schema } from "@skout/db";
import { eq } from "drizzle-orm";
import { loadEnv } from "../config/env.js";
import { emitSkoutEvent, listSkoutEvents } from "./skout-event.service.js";

const { workspaces } = schema;

/**
 * §7.3 SP-11 — proves the actual persist-then-query path a support engineer (or the Dexter
 * command center's event timeline) relies on: emitSkoutEvent() really does write a durable row,
 * and listSkoutEvents() really does return it in reverse-chronological order, filterable by
 * type, with the correlation ID intact for end-to-end tracing.
 */
describe("skout-event.service — durable event log (SP-11)", () => {
  const config = loadEnv();
  const { db, sql } = createDb(config.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/skout");
  let workspaceId: string;

  beforeAll(async () => {
    const [ws] = await db
      .insert(workspaces)
      .values({ name: `Skout Event Log Test WS ${Date.now()}`, slug: `skout-event-log-test-${Date.now()}` })
      .returning();
    workspaceId = ws!.id;
  });

  afterAll(async () => {
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await sql.end();
  });

  it("persists an emitted event and returns it from listSkoutEvents with its correlation ID intact", async () => {
    const event = await emitSkoutEvent(db, config, {
      type: "icp.approved",
      tenantId: workspaceId,
      aggregateId: "icp-test-1",
      data: { approvedBy: "tester" },
    });

    const rows = await listSkoutEvents(db, workspaceId);
    const row = rows.find((r) => r.id === event.id);

    expect(row).toBeTruthy();
    expect(row!.type).toBe("icp.approved");
    expect(row!.aggregateId).toBe("icp-test-1");
    expect(row!.correlationId).toBe(event.id);
    expect(row!.data).toEqual({ approvedBy: "tester" });
  });

  it("returns events in reverse-chronological order", async () => {
    const first = await emitSkoutEvent(db, config, {
      type: "tam.approved",
      tenantId: workspaceId,
      aggregateId: "order-test",
      data: {},
    });
    await new Promise((r) => setTimeout(r, 10));
    const second = await emitSkoutEvent(db, config, {
      type: "tam.approved",
      tenantId: workspaceId,
      aggregateId: "order-test",
      data: {},
    });

    const rows = await listSkoutEvents(db, workspaceId, { type: "tam.approved" });
    const firstIdx = rows.findIndex((r) => r.id === first.id);
    const secondIdx = rows.findIndex((r) => r.id === second.id);

    expect(secondIdx).toBeLessThan(firstIdx);
  });

  it("filters by event type", async () => {
    const signalEvent = await emitSkoutEvent(db, config, {
      type: "signal.detected",
      tenantId: workspaceId,
      aggregateId: "sig-filter-test",
      data: {},
    });

    const filtered = await listSkoutEvents(db, workspaceId, { type: "signal.detected" });
    expect(filtered.some((r) => r.id === signalEvent.id)).toBe(true);
    expect(filtered.every((r) => r.type === "signal.detected")).toBe(true);
  });

  it("threads a correlationId across multiple events in one run", async () => {
    const root = await emitSkoutEvent(db, config, {
      type: "regional_brief.approved",
      tenantId: workspaceId,
      aggregateId: "brief-1",
      data: {},
    });
    const child = await emitSkoutEvent(db, config, {
      type: "sequence.approved",
      tenantId: workspaceId,
      aggregateId: "seq-1",
      correlationId: root.id,
      data: {},
    });

    const rows = await listSkoutEvents(db, workspaceId);
    const rootRow = rows.find((r) => r.id === root.id);
    const childRow = rows.find((r) => r.id === child.id);

    expect(rootRow!.correlationId).toBe(root.id);
    expect(childRow!.correlationId).toBe(root.id);
  });

  it("scopes the feed to the requesting workspace only", async () => {
    const [otherWs] = await db
      .insert(workspaces)
      .values({ name: `Other WS ${Date.now()}`, slug: `other-ws-${Date.now()}` })
      .returning();
    try {
      const otherEvent = await emitSkoutEvent(db, config, {
        type: "meeting.completed",
        tenantId: otherWs!.id,
        aggregateId: "m-other",
        data: {},
      });

      const rows = await listSkoutEvents(db, workspaceId);
      expect(rows.some((r) => r.id === otherEvent.id)).toBe(false);
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, otherWs!.id));
    }
  });
});
