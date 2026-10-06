import { describe, expect, it } from "vitest";
import { COPS_SYSTEM_ROLE_GRANTS } from "./cops-role-grants.js";

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
