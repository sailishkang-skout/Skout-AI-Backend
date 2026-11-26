import { describe, expect, it } from "vitest";
import type { CsvHeader } from "./workbook-import-csv.js";
import type { InputDataType } from "./workbook-cell-values.js";
import { checkMapping, classifyRow, dedupeValue, suggestMapping, suggestedType, type ExistingColumn, type ImportPlan } from "./workbook-import-plan.js";

/** WB2-020: mapping, deduplication and what happens to each row. */
const column = (id: string, name: string, dataType: InputDataType = "text", type = "input"): ExistingColumn => ({ id, name, type, dataType });
const header = (index: number, name: string, fits: InputDataType[] = ["text"], filled = 3): CsvHeader => ({ index, name, fits, filled });

describe("suggested mapping", () => {
  const columns = [column("c-email", "Email", "email"), column("c-first", "First name"), column("c-domain", "Company Domain", "domain"), column("c-run", "Work email", "text", "enrichment")];

  it("matches names whatever their case, spacing and punctuation", () => {
    const got = suggestMapping([header(0, "FIRST_NAME"), header(1, "e-mail", ["text", "email"])], columns, 200, 200);
    expect(got).toEqual([
      { header: 0, target: { columnId: "c-first" } },
      { header: 1, target: { columnId: "c-email" } },
    ]);
  });

  it("matches names that mean the same thing when the values fit the column", () => {
    const got = suggestMapping([header(0, "Website", ["text", "domain"]), header(1, "Email Address", ["text", "email"])], columns, 200, 200);
    expect(got.map((s) => s.target)).toEqual([{ columnId: "c-domain" }, { columnId: "c-email" }]);
  });

  it("does not pair by meaning when the values would be refused, or when more than one column could claim it", () => {
    expect(suggestMapping([header(0, "Website", ["text", "url"])], columns, 200, 200)[0]!.target).toEqual({ newColumn: { name: "Website", dataType: "url" } });
    const two = suggestMapping([header(0, "Work Email", ["text", "email"]), header(1, "Mail", ["text", "email"])], columns, 200, 200);
    expect(two[1]!.target).toEqual({ newColumn: { name: "Mail", dataType: "email" } });
    // "Work Email" is also an enrichment column's name, which cannot be imported into and cannot be reused.
    expect(two[0]!.target).toBeNull();
  });

  it("never points two file columns at one workbook column", () => {
    const got = suggestMapping([header(0, "Email", ["text", "email"]), header(1, "email", ["text", "email"])], columns, 200, 200);
    expect(got.map((s) => s.target)).toEqual([{ columnId: "c-email" }, null]);
  });

  it("offers nothing for unnamed or empty columns, or beyond the column limit", () => {
    const got = suggestMapping([header(0, ""), header(1, "Empty", ["text"], 0), header(2, "Fits"), header(3, "Too many")], [column("a", "A")], 2, 200);
    expect(got.map((s) => s.target)).toEqual([null, null, { newColumn: { name: "Fits", dataType: "text" } }, null]);
  });

  it("shortens a long header to a column name", () => {
    expect(suggestMapping([header(0, "x".repeat(300))], [], 200, 200)[0]!.target).toEqual({ newColumn: { name: "x".repeat(200), dataType: "text" } });
  });

  it.each<[string, InputDataType[], InputDataType]>([
    ["Contact", ["text", "email"], "email"],
    ["Profile", ["text", "url", "linkedin_url"], "linkedin_url"],
    ["Homepage", ["text", "url"], "url"],
    ["Website", ["text", "domain"], "domain"],
    ["Surname", ["text", "domain"], "text"],
    ["Mobile", ["text", "phone"], "phone"],
    ["Account number", ["text", "phone", "number"], "number"],
    ["Joined", ["text", "date"], "date"],
    ["Active", ["text", "checkbox"], "checkbox"],
    ["Notes", ["text"], "text"],
  ])("starts a new column %s as the safest specific type", (name, fits, expected) => {
    expect(suggestedType({ name, fits })).toBe(expected);
  });
});

describe("checking a mapping", () => {
  const headers = ["Name", "Email", "Backup email", "Site"];
  const columns = [column("11111111-aaaa", "Name"), column("22222222-bbbb", "Email", "email"), column("33333333-cccc", "Score", "number", "formula")];
  const check = (mapping: Parameters<typeof checkMapping>[2], dedupe: Parameters<typeof checkMapping>[3] = { key: "none" }, max = 200) => checkMapping(headers, columns, mapping, dedupe, max);
  const codes = (result: ReturnType<typeof checkMapping>) => result.problems.map((p) => `${p.path} ${p.code}`);

  it("accepts existing columns and new ones", () => {
    const result = check(
      [
        { header: 0, columnId: "11111111-AAAA" },
        { header: 1, columnId: "22222222-bbbb" },
        { header: 3, newColumn: { name: "Site", dataType: "url" } },
      ],
      { key: "email" }
    );
    expect(result).toEqual({ problems: [], keyHeader: 1 });
  });

  it.each([
    ["nothing mapped", [], ["columns NOTHING_MAPPED"]],
    ["a header the file does not have", [{ header: 9, columnId: "11111111-aaaa" }], ["columns.0 UNKNOWN_HEADER"]],
    [
      "one header twice",
      [
        { header: 0, columnId: "11111111-aaaa" },
        { header: 0, columnId: "22222222-bbbb" },
      ],
      ["columns.1 HEADER_MAPPED_TWICE"],
    ],
    [
      "two headers into one column",
      [
        { header: 1, columnId: "22222222-bbbb" },
        { header: 2, columnId: "22222222-BBBB" },
      ],
      ["columns.1 COLUMN_MAPPED_TWICE"],
    ],
    ["a column the workbook does not have", [{ header: 0, columnId: "99999999-eeee" }], ["columns.0 UNKNOWN_COLUMN"]],
    ["a column that is not an input", [{ header: 0, columnId: "33333333-cccc" }], ["columns.0 NOT_AN_INPUT_COLUMN"]],
    ["a new column with an existing name", [{ header: 0, newColumn: { name: " email ", dataType: "text" as const } }], ["columns.0 COLUMN_NAME_IN_USE"]],
    [
      "two new columns with one name",
      [
        { header: 0, newColumn: { name: "Site", dataType: "text" as const } },
        { header: 3, newColumn: { name: "SITE", dataType: "url" as const } },
      ],
      ["columns.1 COLUMN_NAME_IN_USE"],
    ],
  ])("refuses %s", (_name, mapping, expected) => {
    expect(codes(check(mapping))).toEqual(expected);
  });

  it("refuses more columns than a workbook can have", () => {
    expect(codes(check([{ header: 3, newColumn: { name: "Site", dataType: "url" } }], { key: "none" }, 3))).toEqual(["columns COLUMN_LIMIT_EXCEEDED"]);
  });

  it("reports every problem at once", () => {
    expect(codes(check([{ header: 9, columnId: "11111111-aaaa" }, { header: 0, columnId: "33333333-cccc" }]))).toHaveLength(2);
  });

  describe("the deduplication column", () => {
    const twoEmails = [
      { header: 1, columnId: "22222222-bbbb" },
      { header: 2, newColumn: { name: "Backup", dataType: "email" as const } },
    ];

    it("must be chosen when two could be it", () => {
      expect(codes(check(twoEmails, { key: "email" }))).toEqual(["dedupe DEDUPE_COLUMN_AMBIGUOUS"]);
      expect(check(twoEmails, { key: "email", header: 2 })).toEqual({ problems: [], keyHeader: 2 });
    });

    it("must exist", () => {
      expect(codes(check([{ header: 0, columnId: "11111111-aaaa" }], { key: "email" }))).toEqual(["dedupe DEDUPE_COLUMN_REQUIRED"]);
      expect(codes(check(twoEmails, { key: "email", header: 0 }))).toEqual(["dedupe DEDUPE_COLUMN_INVALID"]);
    });

    it("can be a plain text column when named, and not a column of another kind", () => {
      const mapping = [{ header: 0, columnId: "11111111-aaaa" }, ...twoEmails];
      expect(check(mapping, { key: "linkedin_url", header: 0 })).toEqual({ problems: [], keyHeader: 0 });
      expect(codes(check(mapping, { key: "domain", header: 1 }))).toEqual(["dedupe DEDUPE_COLUMN_INVALID"]);
    });
  });
});

describe("deduplication values", () => {
  it("treats email addresses that differ in case and spacing as one", () => {
    expect(dedupeValue("email", "  Ann@Acme.COM ")).toBe("ann@acme.com");
    expect(dedupeValue("email", "ann@acme")).toBeNull();
    expect(dedupeValue("email", "not an email")).toBeNull();
  });

  it("treats every way of writing a website as its domain", () => {
    for (const spelling of ["acme.com", "ACME.com", "www.acme.com", "https://www.Acme.com/about?x=1", "http://acme.com:8080/"]) {
      expect(dedupeValue("domain", spelling), spelling).toBe("acme.com");
    }
    expect(dedupeValue("domain", "app.acme.com")).toBe("app.acme.com");
    expect(dedupeValue("domain", "Acme Inc")).toBeNull();
  });

  it("treats every way of writing a LinkedIn address as one profile", () => {
    for (const spelling of [
      "https://www.linkedin.com/in/ann-smith",
      "http://linkedin.com/in/Ann-Smith/",
      "linkedin.com/in/ann-smith?utm_source=x#y",
      "https://uk.linkedin.com/in/ann%2Dsmith/en",
    ]) {
      expect(dedupeValue("linkedin_url", spelling), spelling).toBe("in/ann-smith");
    }
    expect(dedupeValue("linkedin_url", "https://www.linkedin.com/company/Acme/about/")).toBe("company/acme");
    expect(dedupeValue("linkedin_url", "https://www.linkedin.com/in/ann-smith-2")).not.toBe("in/ann-smith");
    expect(dedupeValue("linkedin_url", "https://example.com/in/ann-smith")).toBeNull();
    expect(dedupeValue("linkedin_url", "https://linkedin.com.evil.test/in/ann")).toBeNull();
  });

  it("has no value for an empty field", () => {
    for (const key of ["email", "domain", "linkedin_url"] as const) expect(dedupeValue(key, "   ")).toBeNull();
  });
});

describe("what happens to a row", () => {
  const plan: ImportPlan = {
    headers: ["Name", "Email", "Age", "Ignored"],
    delimiter: ",",
    columns: [
      { header: 0, columnId: "n", name: "Name", dataType: "text" },
      { header: 1, columnId: "e", name: "Email", dataType: "email" },
      { header: 2, columnId: "a", name: "Age", dataType: "number" },
    ],
    dedupe: { key: "email", header: 1, columnId: "e" },
    requestId: null,
  };

  it("is ready with its typed values and key; empty cells are left out", () => {
    expect(classifyRow(plan, ["Ann", " Ann@x.com ", "", "whatever"])).toEqual({
      kind: "ready",
      cells: [
        { columnId: "n", value: "Ann" },
        { columnId: "e", value: "Ann@x.com" },
      ],
      key: "ann@x.com",
    });
    expect(classifyRow(plan, ["Bo", "bo@x.com", "41", ""])).toMatchObject({ cells: expect.arrayContaining([{ columnId: "a", value: 41 }]) });
  });

  it("is imported when its key is empty, and cannot be a duplicate", () => {
    expect(classifyRow(plan, ["Ann", "  ", "3", ""])).toMatchObject({ kind: "ready", key: null });
  });

  it("is refused whole, naming every column, when any value does not fit", () => {
    expect(classifyRow(plan, ["Ann", "n/a", "old", ""])).toEqual({ kind: "invalid", reason: "Invalid field value. Email: not a valid email address; Age: not a valid number" });
    expect(classifyRow(plan, ["x".repeat(10_001), "ann@x.com", "", ""])).toMatchObject({ kind: "invalid", reason: expect.stringContaining("Name: text is longer than") });
  });

  it("is refused when its key is in a text column and unusable", () => {
    const textKey: ImportPlan = { ...plan, dedupe: { key: "domain", header: 0, columnId: "n" } };
    expect(classifyRow(textKey, ["Acme Inc", "", "", ""])).toEqual({ kind: "invalid", reason: "Invalid field value. Name: not a valid domain, so it cannot be checked for duplicates" });
  });

  it("is skipped when every mapped column is empty", () => {
    expect(classifyRow(plan, ["", " ", "", "only ignored"])).toEqual({ kind: "skipped", reason: "Missing value: every mapped column is empty in this row" });
  });

  it("is malformed when it has the wrong number of values", () => {
    expect(classifyRow(plan, ["Ann", "ann@x.com"])).toEqual({ kind: "malformed", reason: "Malformed CSV row: expected 4 values, found 2" });
  });
});
