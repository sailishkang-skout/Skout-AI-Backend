import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { copsAuditConditions, COPS_AUDIT_MAX_LIMIT, decodeCopsAuditCursor } from "./cops-audit.routes.js";

describe("copsAuditConditions", () => {
  it("always scopes to the tenant first", () => {
    const conds = copsAuditConditions("ws_1", { limit: 25 } as never);
    expect(conds).toHaveLength(1);
  });

  it("adds one condition per supplied filter", () => {
    const conds = copsAuditConditions("ws_1", {
      limit: 25,
      actor_id: "u_1",
      entity_type: "account",
      entity_id: "d06a12e4-628b-437f-8f96-1f23c7823658",
      cursor: Buffer.from(JSON.stringify({
        created_at: "2026-10-06T10:00:00.000Z",
        id: "d06a12e4-628b-437f-8f96-1f23c7823658",
      })).toString("base64url"),
    } as never);
    expect(conds).toHaveLength(5);
  });

  it("supports one human-friendly search across actor, action, entity, and reason", () => {
    const conds = copsAuditConditions("ws_1", { limit: 25, search: "Alex" } as never);
    expect(conds).toHaveLength(2);
  });

  it("round-trips a cursor and rejects malformed cursors", () => {
    const id = "d06a12e4-628b-437f-8f96-1f23c7823658";
    const cursor = Buffer.from(JSON.stringify({ created_at: "2026-10-06T10:00:00.000Z", id })).toString("base64url");
    expect(decodeCopsAuditCursor(cursor)).toEqual({ createdAt: new Date("2026-10-06T10:00:00.000Z"), id });
    expect(decodeCopsAuditCursor("invalid")).toBeNull();
  });

  it("exposes a max page size of 100", () => {
    expect(COPS_AUDIT_MAX_LIMIT).toBe(100);
  });
});
