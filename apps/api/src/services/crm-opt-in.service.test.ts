import { describe, expect, it, vi } from "vitest";
import {
  getCrmSyncOptIn,
  isAccountInScope,
  isCrmSyncOptedIn,
  updateCrmSyncOptIn,
} from "./crm-opt-in.service.js";

describe("CRM Opt-In Service (ADR 0014)", () => {
  describe("isCrmSyncOptedIn", () => {
    it("returns false by default for null or empty settings", () => {
      expect(isCrmSyncOptedIn(null)).toBe(false);
      expect(isCrmSyncOptedIn({})).toBe(false);
      expect(isCrmSyncOptedIn({ syncEnabled: false })).toBe(false);
    });

    it("returns true when syncEnabled is true", () => {
      expect(isCrmSyncOptedIn({ syncEnabled: true })).toBe(true);
    });
  });

  describe("isAccountInScope", () => {
    it("returns false if sync is not enabled", () => {
      expect(isAccountInScope({ syncEnabled: false }, "acc-1")).toBe(false);
    });

    it("returns true for wildcard account scope", () => {
      expect(isAccountInScope({ syncEnabled: true, accountScope: ["*"] }, "acc-1")).toBe(true);
    });

    it("returns true only for matching scoped accounts", () => {
      const settings = { syncEnabled: true, accountScope: ["acc-1", "acc-2"] };
      expect(isAccountInScope(settings, "acc-1")).toBe(true);
      expect(isAccountInScope(settings, "acc-3")).toBe(false);
    });
  });

  describe("updateCrmSyncOptIn & getCrmSyncOptIn", () => {
    it("updates opt-in settings and creates an audit log", async () => {
      let updatedData: any;
      let insertedAudit: any;

      const dbMock: any = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "conn-1",
                  status: "connected",
                  settings: { existingProp: "foo" },
                },
              ]),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockImplementation((val) => {
            updatedData = val;
            return {
              where: vi.fn().mockResolvedValue([]),
            };
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((val) => {
            insertedAudit = val;
            return Promise.resolve();
          }),
        }),
      };

      const result = await updateCrmSyncOptIn(
        dbMock,
        "ws-123",
        "hubspot",
        {
          syncEnabled: true,
          accountScope: ["acc-100"],
          objectScope: { contacts: true, deals: false },
        },
        "user-1"
      );

      expect(result.syncEnabled).toBe(true);
      expect(result.accountScope).toEqual(["acc-100"]);
      expect(result.objectScope?.deals).toBe(false);

      expect(updatedData.settings.syncEnabled).toBe(true);
      expect(updatedData.settings.existingProp).toBe("foo");

      expect(insertedAudit.action).toBe("crm_connection.opt_in_updated");
      expect(insertedAudit.actorId).toBe("user-1");
    });
  });
});
