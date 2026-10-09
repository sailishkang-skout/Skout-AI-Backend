import { describe, expect, it } from "vitest";
import { COPS_RESOURCES, COPS_VERBS, copsPermissionKey, engineeringCanRead } from "./cops-rbac.js";
import { COPS_SYSTEM_ROLE_GRANTS } from "@skout/db";

/**
 * Permission matrix (role x verb x resource) for hard rules only. Full role grants are product
 * configuration and are tested once decided. Fixture grants below are test data, not product policy.
 */
const ROLE_FIXTURES: Record<string, string[]> = {
  Engineering: COPS_RESOURCES.flatMap((r) =>
    COPS_VERBS.map((v) => copsPermissionKey(r, v))
  ).filter((k) => !k.startsWith("commercial:") && !k.startsWith("legal:")),
  Finance: [copsPermissionKey("commercial", "refund"), copsPermissionKey("commercial", "read")],
  Sales: [copsPermissionKey("crm", "read"), copsPermissionKey("crm", "write")],
};

describe("permission matrix", () => {
  for (const verb of COPS_VERBS) {
    for (const resource of ["commercial", "legal"] as const) {
      it(`Engineering is denied ${resource}:${verb}`, () => {
        expect(ROLE_FIXTURES.Engineering).not.toContain(copsPermissionKey(resource, verb));
      });
    }
  }

  it("Engineering cannot read commercial or legal via the read helper", () => {
    expect(engineeringCanRead("commercial", ROLE_FIXTURES.Engineering)).toBe(false);
    expect(engineeringCanRead("legal", ROLE_FIXTURES.Engineering)).toBe(false);
  });

  it("a role only gets the keys it was granted", () => {
    expect(ROLE_FIXTURES.Sales).toContain("crm:write");
    expect(ROLE_FIXTURES.Sales).not.toContain("commercial:refund");
    expect(ROLE_FIXTURES.Finance).toContain("commercial:refund");
  });
});

/**
 * Same rule checked against the real seeded grants (packages/db cops-role-grants), not fixtures.
 */
describe("permission matrix against the seeded system roles", () => {
  const engineering = COPS_SYSTEM_ROLE_GRANTS.find((r) => r.key === "engineering");

  it("the Engineering role exists in the seeded grants", () => {
    expect(engineering).toBeDefined();
  });

  for (const resource of ["commercial", "legal"] as const) {
    for (const verb of COPS_VERBS) {
      it(`Engineering seed does not grant ${resource}:${verb}`, () => {
        expect(engineering!.permissionKeys).not.toContain(copsPermissionKey(resource, verb));
      });
    }
    it(`Engineering cannot read ${resource} via the read helper against the seed`, () => {
      expect(engineeringCanRead(resource, engineering!.permissionKeys)).toBe(false);
    });
  }
});
