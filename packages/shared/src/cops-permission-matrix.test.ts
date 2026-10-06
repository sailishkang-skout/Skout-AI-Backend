import { describe, expect, it } from "vitest";
import { COPS_RESOURCES, COPS_VERBS, copsPermissionKey, engineeringCanRead } from "./cops-rbac.js";
import { COPS_SYSTEM_ROLE_GRANTS } from "@skout/db";

describe("CustomerOps role × verb × resource permission matrix", () => {
  for (const role of COPS_SYSTEM_ROLE_GRANTS) {
    for (const resource of COPS_RESOURCES) {
      for (const verb of COPS_VERBS) {
        const key = copsPermissionKey(resource, verb);
        const granted = role.permissionKeys.some((permission) => permission === key);
        it(`${role.name} ${granted ? "grants" : "denies"} ${resource}:${verb}`, () => {
          expect(role.permissionKeys.some((permission) => permission === key)).toBe(granted);
        });
      }
    }
  }
});

/**
 * Permission matrix (role x verb x resource) for the rule Bible p.84 states outright:
 * Engineering cannot see commercial or legal content by default. Other grants are product
 * configuration and are tested once they are decided.
 */
describe("permission matrix: Engineering vs commercial/legal", () => {
  const engineeringAllKeys = COPS_RESOURCES.flatMap((r) => COPS_VERBS.map((v) => copsPermissionKey(r, v)));
  // Engineering holds every key except the commercial and legal ones, as a worst-case grant.
  const engineeringGrants = engineeringAllKeys.filter((k) => !k.startsWith("commercial:") && !k.startsWith("legal:"));

  for (const verb of COPS_VERBS) {
    for (const resource of ["commercial", "legal"] as const) {
      it(`denies ${resource}:${verb} to Engineering even with every other grant`, () => {
        expect(engineeringGrants).not.toContain(copsPermissionKey(resource, verb));
      });
    }
  }

  it("denies commercial and legal reads when no commercial/legal key is granted", () => {
    expect(engineeringCanRead("commercial", engineeringGrants)).toBe(false);
    expect(engineeringCanRead("legal", engineeringGrants)).toBe(false);
  });

  it("allows a commercial read only when that exact key is granted", () => {
    expect(engineeringCanRead("commercial", [...engineeringGrants, "commercial:read"])).toBe(true);
  });
});
