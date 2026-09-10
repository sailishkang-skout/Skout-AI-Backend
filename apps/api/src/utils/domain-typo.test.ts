import { describe, expect, it } from "vitest";
import { suggestDomainCorrection } from "./domain-typo.js";

describe("suggestDomainCorrection", () => {
  it("suggests gmail.com for the missing-letter typo gmial.com", () => {
    expect(suggestDomainCorrection("gmial.com")).toBe("gmail.com");
  });

  it("suggests gmail.com for the dropped-letter typo gmai.com", () => {
    expect(suggestDomainCorrection("gmai.com")).toBe("gmail.com");
  });

  it("suggests outlook.com for the transposed-letter typo outlok.com", () => {
    expect(suggestDomainCorrection("outlok.com")).toBe("outlook.com");
  });

  it("returns null for an exact match against a known common domain", () => {
    expect(suggestDomainCorrection("gmail.com")).toBeNull();
  });

  it("returns null for a domain unrelated to any common domain", () => {
    expect(suggestDomainCorrection("acme.com")).toBeNull();
  });

  it("returns null when the edit distance is too large to be a confident typo", () => {
    expect(suggestDomainCorrection("totallydifferentdomain.io")).toBeNull();
  });
});
