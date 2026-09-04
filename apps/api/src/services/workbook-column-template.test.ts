import { describe, expect, it } from "vitest";
import { extractTemplateKeys, renderTemplate } from "./workbook-column-template.js";

describe("extractTemplateKeys", () => {
  it("finds every distinct key in first-appearance order", () => {
    expect(extractTemplateKeys("{{company}} — {{title}} at {{company}}")).toEqual(["company", "title"]);
  });

  it("returns an empty array when there are no template references", () => {
    expect(extractTemplateKeys("just plain text")).toEqual([]);
  });

  it("ignores malformed braces", () => {
    expect(extractTemplateKeys("{company} {{ company }} {{}}")).toEqual([]);
  });
});

describe("renderTemplate", () => {
  it("substitutes every key present in context", () => {
    const { rendered, missingKeys } = renderTemplate("{{company}} — {{title}}", {
      company: "Acme",
      title: "Engineer",
    });
    expect(rendered).toBe("Acme — Engineer");
    expect(missingKeys).toEqual([]);
  });

  it("substitutes a missing key as empty string and reports it", () => {
    const { rendered, missingKeys } = renderTemplate("{{company}} — {{missing}}", { company: "Acme" });
    expect(rendered).toBe("Acme — ");
    expect(missingKeys).toEqual(["missing"]);
  });

  it("treats a null context value the same as missing", () => {
    const { rendered, missingKeys } = renderTemplate("{{company}}", { company: null });
    expect(rendered).toBe("");
    expect(missingKeys).toEqual(["company"]);
  });

  it("reports the same missing key twice if referenced twice", () => {
    const { missingKeys } = renderTemplate("{{x}} {{x}}", {});
    expect(missingKeys).toEqual(["x", "x"]);
  });

  it("returns the template unchanged when it has no references", () => {
    const { rendered, missingKeys } = renderTemplate("plain text", {});
    expect(rendered).toBe("plain text");
    expect(missingKeys).toEqual([]);
  });
});
