import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createDb } from "./client.js";
import { COPS_SYSTEM_ROLE_GRANTS } from "./cops-role-grants.js";
import { rolePermissions, roles } from "./schema/tenancy.js";

describe("COPS system role grants", () => {
  it("seeds the complete set of CustomerOps roles", () => {
    expect(COPS_SYSTEM_ROLE_GRANTS.map((role) => role.key)).toEqual([
      "sales",
      "sales_manager",
      "cs",
      "finance",
      "legal_revops",
      "engineering",
      "product",
    ]);
  });

  it("does not grant Engineering access to commercial or legal content", () => {
    const engineering = COPS_SYSTEM_ROLE_GRANTS.find((role) => role.key === "engineering");
    expect(engineering).toBeDefined();
    expect(engineering?.permissionKeys).not.toContain("commercial:read");
    expect(engineering?.permissionKeys).not.toContain("legal:read");
  });

  it("grants legal reads only to Legal / RevOps among the CustomerOps roles", () => {
    const legalReaders = COPS_SYSTEM_ROLE_GRANTS
      .filter((role) => role.permissionKeys.some((key) => key === "legal:read"))
      .map((role) => role.key);
    expect(legalReaders).toEqual(["legal_revops"]);
  });
});

const testDatabaseUrl = process.env.COPS_TEST_DATABASE_URL;
if (testDatabaseUrl) {
  describe("COPS role grants in Postgres", () => {
    const { db, sql } = createDb(testDatabaseUrl);

    afterAll(async () => {
      await sql.end();
    });

    it("has seeded CustomerOps roles and denies Engineering commercial/legal reads", async () => {
      const grants = await db
        .select({ role: roles.key, permission: rolePermissions.permissionKey })
        .from(roles)
        .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
        .where(inArray(roles.key, COPS_SYSTEM_ROLE_GRANTS.map((role) => role.key)));

      const roleKeys = new Set(grants.map((grant) => grant.role));
      const engineeringGrants = grants.filter((grant) => grant.role === "engineering");
      const legalRevopsGrants = grants.filter((grant) => grant.role === "legal_revops");

      expect(roleKeys).toEqual(new Set(COPS_SYSTEM_ROLE_GRANTS.map((role) => role.key)));
      for (const role of COPS_SYSTEM_ROLE_GRANTS) {
        const actualPermissions = grants
          .filter((grant) => grant.role === role.key)
          .map((grant) => grant.permission)
          .filter((permission): permission is string => permission !== null)
          .sort();
        expect(actualPermissions, `permission matrix for ${role.key}`).toEqual([...role.permissionKeys].sort());
      }
      expect(engineeringGrants.map((grant) => grant.permission)).not.toContain("commercial:read");
      expect(engineeringGrants.map((grant) => grant.permission)).not.toContain("legal:read");
      expect(legalRevopsGrants.map((grant) => grant.permission)).toContain("legal:read");
    });
  });
}
