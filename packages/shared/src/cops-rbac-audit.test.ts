import { describe, expect, it } from "vitest";
import { buildCopsAuditRecord, CopsAuditValidationError, type CopsAuditInput } from "./cops-audit.js";
import { copsPermissionKey, engineeringCanRead } from "./cops-rbac.js";

const audit: CopsAuditInput = {
  tenantId: "ws_1",
  actor: { type: "user", id: "u_1" },
  entityType: "account",
  entityId: "acc_1",
  action: "account.updated",
  before: { owner: "a" },
  after: { owner: "b" },
  correlationId: "6f1c2a7e-8b1d-4c2e-9f3a-1a2b3c4d5e70",
  sourceChannel: "web",
};

describe("copsPermissionKey", () => {
  it("builds resource:verb keys", () => {
    expect(copsPermissionKey("commercial", "approve")).toBe("commercial:approve");
  });
});

describe("engineeringCanRead", () => {
  it("denies commercial and legal reads without an explicit grant", () => {
    expect(engineeringCanRead("commercial", [])).toBe(false);
    expect(engineeringCanRead("legal", ["tickets:read"])).toBe(false);
  });

  it("allows a resource only when read is explicitly granted", () => {
    expect(engineeringCanRead("commercial", ["commercial:read"])).toBe(true);
    expect(engineeringCanRead("tickets", ["tickets:read"])).toBe(true);
  });
});

describe("buildCopsAuditRecord", () => {
  it("returns a complete record with occurredAt set", () => {
    const now = new Date("2026-10-06T10:00:00.000Z");
    const record = buildCopsAuditRecord(audit, now);
    expect(record.occurredAt).toEqual(now);
    expect(record.entityId).toBe("acc_1");
  });

  it("requires a reason on manual overrides", () => {
    expect(() => buildCopsAuditRecord({ ...audit, override: true })).toThrow(CopsAuditValidationError);
    expect(() => buildCopsAuditRecord({ ...audit, override: true, reason: "   " })).toThrow(/reason/);
    expect(() => buildCopsAuditRecord({ ...audit, override: true, reason: "CFO approved" })).not.toThrow();
  });

  it("rejects missing tenant, entity, action or correlation id", () => {
    expect(() => buildCopsAuditRecord({ ...audit, tenantId: "" })).toThrow(/tenantId/);
    expect(() => buildCopsAuditRecord({ ...audit, entityId: "" })).toThrow(/entityId/);
    expect(() => buildCopsAuditRecord({ ...audit, action: "" })).toThrow(/action/);
    expect(() => buildCopsAuditRecord({ ...audit, correlationId: "" })).toThrow(/correlationId/);
  });

  it("rejects an unknown source channel", () => {
    expect(() =>
      buildCopsAuditRecord({ ...audit, sourceChannel: "fax" as never })
    ).toThrow(/sourceChannel/);
  });
});
