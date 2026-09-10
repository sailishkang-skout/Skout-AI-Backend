import { describe, expect, it } from "vitest";
import { CRM_BRIDGE_PACKAGE_NAME } from "./index.js";

describe("crm-bridge package", () => {
  it("exposes its package identity", () => {
    expect(CRM_BRIDGE_PACKAGE_NAME).toBe("@skout/crm-bridge");
  });
});
