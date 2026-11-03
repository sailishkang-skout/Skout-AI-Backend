import { describe, expect, it } from "vitest";
import { roleAllowed } from "./policy-gateway.service.js";

describe("COPS-14 per-role agent permissions", () => {
  const sales = "11111111-1111-4111-8111-111111111111";
  const cs = "22222222-2222-4222-8222-222222222222";
  it("lets everyone run an action that has no role list", () => {
    expect(roleAllowed(null, [], "member")).toBe(true);
    expect(roleAllowed([], [], "member")).toBe(true);
  });
  it("needs one of the listed roles otherwise", () => {
    expect(roleAllowed([sales], [sales], "member")).toBe(true);
    expect(roleAllowed([sales], [cs], "member")).toBe(false);
    expect(roleAllowed([sales], [], "admin")).toBe(false);
  });
  it("always lets the owner run it, so a workspace cannot lock itself out", () => {
    expect(roleAllowed([sales], [], "owner")).toBe(true);
  });
});
