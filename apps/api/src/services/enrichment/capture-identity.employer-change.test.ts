import { describe, expect, it } from "vitest";
import { isCurrentEmployerChange } from "./capture-identity.js";

describe("isCurrentEmployerChange", () => {
  const acme = [{ name: "Acme Inc.", title: "Head of Sales" }];
  it("flags a move to another company", () => {
    expect(isCurrentEmployerChange(acme, [{ name: "Globex", title: "VP Sales" }])).toBe(true);
  });
  it("flags a new title at the same company when both captures read a title", () => {
    expect(isCurrentEmployerChange(acme, [{ name: "Acme", title: "VP Sales" }])).toBe(true);
  });
  it("ignores a capture where Experience had not loaded, or the title was not read", () => {
    expect(isCurrentEmployerChange([], acme)).toBe(false);
    expect(isCurrentEmployerChange(undefined, acme)).toBe(false);
    expect(isCurrentEmployerChange(acme, [])).toBe(false);
    expect(isCurrentEmployerChange([{ name: "Acme" }], acme)).toBe(false);
    expect(isCurrentEmployerChange(acme, [{ name: "ACME Inc" }])).toBe(false);
  });
});
