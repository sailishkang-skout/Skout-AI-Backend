import { describe, expect, it } from "vitest";
import { INPUT_DATA_TYPES, MAX_CELL_TEXT_LENGTH, inputDataType, looksLike, normalizeInputValue, type InputDataType } from "./workbook-cell-values.js";

/** WB2-012: what an input cell accepts, flags and refuses. */
describe("inputDataType", () => {
  it("reads config.dataType and treats anything else as text", () => {
    for (const type of INPUT_DATA_TYPES) expect(inputDataType({ dataType: type })).toBe(type);
    for (const config of [{}, null, undefined, { dataType: "nope" }, { dataType: 4 }, "email"]) expect(inputDataType(config)).toBe("text");
  });
});

describe("normalizeInputValue", () => {
  it("treats null, undefined and blank text as an empty cell for every type", () => {
    for (const type of INPUT_DATA_TYPES) {
      for (const raw of [null, undefined, "", "   ", "\n\t"]) expect(normalizeInputValue(raw, type)).toEqual({ kind: "empty" });
    }
  });

  it("refuses what a cell cannot hold", () => {
    for (const raw of [{}, { a: 1 }, [], ["x"], Number.NaN, Number.POSITIVE_INFINITY, "a\u0000b", "x".repeat(MAX_CELL_TEXT_LENGTH + 1)]) {
      expect(normalizeInputValue(raw, "text").kind, String(raw).slice(0, 20)).toBe("rejected");
    }
    expect(normalizeInputValue("x".repeat(MAX_CELL_TEXT_LENGTH), "text").kind).toBe("value");
  });

  const accepted: Array<[InputDataType, unknown, unknown]> = [
    ["text", "  kept as typed ", "  kept as typed "],
    ["text", 42, "42"],
    ["text", false, "false"],
    ["text", "123", "123"],
    ["number", 0, 0],
    ["number", " -12.5 ", -12.5],
    ["number", "1e5", 100000],
    ["checkbox", true, true],
    ["checkbox", " YES ", true],
    ["checkbox", 0, false],
    ["checkbox", "no", false],
    ["email", " a.b+c@sub.example.co ", "a.b+c@sub.example.co"],
    ["url", "https://example.com/a?b=1", "https://example.com/a?b=1"],
    ["linkedin_url", "linkedin.com/in/someone", "linkedin.com/in/someone"],
    ["linkedin_url", "https://www.linkedin.com/company/acme", "https://www.linkedin.com/company/acme"],
    ["domain", "Example.CO.uk", "example.co.uk"],
    ["phone", "+1 (415) 555-0100", "+1 (415) 555-0100"],
    ["date", "2026-02-28", "2026-02-28"],
    ["date", "2028-02-29T23:59:00Z", "2028-02-29T23:59:00Z"],
  ];
  it.each(accepted)("%s accepts %j", (type, raw, value) => {
    expect(normalizeInputValue(raw, type)).toEqual({ kind: "value", value, errorCode: null });
  });

  const flagged: Array<[InputDataType, string | number | boolean]> = [
    ["number", "twelve"],
    ["number", "1,000"],
    ["number", "1e999"],
    ["number", true],
    ["checkbox", "maybe"],
    ["checkbox", 2],
    ["email", "not-an-email"],
    ["email", "a@b"],
    ["email", 5],
    ["url", "example.com"],
    ["url", "javascript:alert(1)"],
    ["url", "ftp://example.com"],
    ["linkedin_url", "https://notlinkedin.com/in/x"],
    ["linkedin_url", "https://linkedin.com.evil.test/in/x"],
    ["linkedin_url", "https://linkedin.com/"],
    ["domain", "https://example.com"],
    ["domain", "localhost"],
    ["phone", "12345"],
    ["phone", "call me"],
    ["date", "2026-02-29"],
    ["date", "28/02/2026"],
    ["date", "2026-13-01"],
  ];
  it.each(flagged)("%s keeps %j and flags it", (type, raw) => {
    expect(normalizeInputValue(raw, type)).toEqual({ kind: "value", value: raw, errorCode: `invalid_${type}` });
  });
});

/** WB2-022: what a pasted column that went to the wrong place probably holds. */
describe("looksLike", () => {
  const cases: Array<[string[], InputDataType | null]> = [
    [["a@example.com", "b@example.org"], "email"],
    [["linkedin.com/in/ada", "https://www.linkedin.com/in/grace"], "linkedin_url"],
    [["example.com", "sub.example.org"], "domain"],
    [["https://example.com/a"], "url"],
    [["+44 20 7946 0958"], "phone"],
    [["42", "-1.5"], "number"],
    [["2026-01-31"], "date"],
    [["a@example.com", "b@example.org", "Ada"], "email"],
    [["a@example.com", "Ada"], null],
    [["Ada", "Grace"], null],
    [["", "  ", "a@example.com"], "email"],
    [["", " "], null],
    [[], null],
  ];
  it.each(cases)("%j -> %s", (values, type) => {
    expect(looksLike(values)).toBe(type);
  });
});
