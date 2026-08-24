import { describe, expect, it, vi } from "vitest";
import { AuditService, type AuditAction } from "./audit.service.js";

function insertReturning(result: unknown[]) {
  return { values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(result) }) };
}

describe("AuditService.record", () => {
  it("accepts the promotion action", async () => {
    const row = {
      id: "audit-1",
      workspaceId: "ws-1",
      actorId: null,
      action: "promotion",
      entityType: "deal",
      entityId: "deal-1",
      beforeState: null,
      afterState: { id: "deal-1" },
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    const db = { insert: vi.fn().mockReturnValue(insertReturning([row])) };
    const svc = new AuditService(db as any);

    const action: AuditAction = "promotion";
    const result = await svc.record("ws-1", undefined, action, "deal", "deal-1", null, { id: "deal-1" });

    expect(result.action).toBe("promotion");
  });

  it("accepts the import action", async () => {
    const row = {
      id: "audit-2",
      workspaceId: "ws-1",
      actorId: "user-1",
      action: "import",
      entityType: "contact",
      entityId: "contact-1",
      beforeState: null,
      afterState: { id: "contact-1" },
      createdAt: new Date("2026-01-01T00:00:00Z"),
    };
    const db = { insert: vi.fn().mockReturnValue(insertReturning([row])) };
    const svc = new AuditService(db as any);

    const action: AuditAction = "import";
    const result = await svc.record("ws-1", "user-1", action, "contact", "contact-1", null, { id: "contact-1" });

    expect(result.action).toBe("import");
  });
});
