import { describe, expect, it } from "vitest";
import {
  ACTION_OPERATIONS,
  AI_TEMPLATES,
  ENRICHMENT_OPERATIONS,
  FORMULA_FUNCTIONS,
  captureGroups,
  columnOutput,
  hasReferenceCycle,
  mentions,
  parseColumnConfig,
  referenceProblems,
  type ColumnShape,
  type ColumnType,
} from "./workbook-v2-column-config.js";
import { INPUT_DATA_TYPES } from "./workbook-cell-values.js";
import { webhookUrlProblem } from "../utils/webhook-url.js";

/** WB2-013: what each column type accepts as settings, and what it may refer to. */
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "aaaaaaaa-0000-4000-8000-000000000002";
const SEQ = "cccccccc-0000-4000-8000-000000000001";
const a = { columnId: A };
const b = { columnId: B };
const rule = { columnId: A, op: "has_value" };

const accepted = (type: ColumnType, operation: string | null, config: unknown) => {
  const parsed = parseColumnConfig(type, operation, config);
  expect(parsed.ok, `${type} ${operation} ${JSON.stringify(config)} ${JSON.stringify(!parsed.ok && parsed.problems)}`).toBe(true);
  return parsed as Extract<typeof parsed, { ok: true }>;
};
const refused = (type: ColumnType, operation: string | null | undefined, config: unknown) => {
  const parsed = parseColumnConfig(type, operation, config);
  expect(parsed.ok, `${type} ${operation} ${JSON.stringify(config)?.slice(0, 200)}`).toBe(false);
  return (parsed as Extract<typeof parsed, { ok: false }>).problems;
};

/** One valid config for every type and operation. */
const VALID: Array<[ColumnType, string | null, Record<string, unknown>]> = [
  ...INPUT_DATA_TYPES.map((dataType): [ColumnType, null, Record<string, unknown>] => ["input", null, { dataType }]),
  ["enrichment", "find_email", { inputs: { fullName: a, companyDomain: b } }],
  ["enrichment", "find_email", { inputs: { linkedinUrl: a } }],
  ["enrichment", "verify_email", { inputs: { email: a } }],
  ["enrichment", "find_phone", { inputs: { firstName: a, lastName: b, companyDomain: a } }],
  ["enrichment", "company_data", { inputs: { companyDomain: a }, fields: ["industry", "headcount"] }],
  ["enrichment", "linkedin_profile", { inputs: { fullName: a, companyName: b } }],
  ["enrichment", "company_domain", { inputs: { companyName: a } }],
  ["ai", null, { prompt: `Write an opener for {{${A}}} at {{${B}}}`, output: { type: "text" } }],
  ["ai", null, { prompt: "Rate the fit", output: { type: "number" }, webResearch: true }],
  ["ai", null, { prompt: "ICP?", output: { type: "yes_no" }, template: "icp_fit" }],
  ["ai", null, { prompt: "Industry?", output: { type: "category", options: ["SaaS", "Retail"] } }],
  ["ai", null, { prompt: "Describe", output: { type: "fields", fields: [{ name: "fit", type: "yes_no" }, { name: "reason", type: "text" }] } }],
  ["formula", null, { fn: "extract_domain", source: a }],
  ["formula", null, { fn: "split_name", source: a, part: "last" }],
  ["formula", null, { fn: "join", parts: [a, { text: " at " }, b], separator: "" }],
  ["formula", null, { fn: "change_case", source: a, case: "title" }],
  ["formula", null, { fn: "trim_clean", source: a }],
  ["formula", null, { fn: "find_replace", source: a, find: "Inc.", replace: "" }],
  ["formula", null, { fn: "if_then_else", condition: { rules: [rule] }, then: b, else: { value: "none" } }],
  ["formula", null, { fn: "number_format", source: a, decimals: 0, prefix: "$" }],
  ["formula", null, { fn: "date_part", source: a, part: "quarter" }],
  ["formula", null, { fn: "first_non_empty", sources: [a, b] }],
  ["formula", null, { fn: "regex_extract", source: a, pattern: "@([\\w.]+)$", group: 1 }],
  ["action", "add_to_sequence", { sequenceId: SEQ, emailColumn: a }],
  ["action", "add_to_list", { listId: SEQ, condition: { match: "any", rules: [rule] } }],
  ["action", "push_to_crm", { provider: "hubspot", object: "contact", mapping: [{ crmField: "email", columnId: A }] }],
  ["action", "send_to_webhook", { url: "https://hooks.example.com/x", columns: [a, b] }],
];

describe("parseColumnConfig: what is accepted", () => {
  it("has a valid example for every operation and formula function", () => {
    for (const operation of [...ENRICHMENT_OPERATIONS, ...ACTION_OPERATIONS]) expect(VALID.some(([, o]) => o === operation), operation).toBe(true);
    for (const fn of FORMULA_FUNCTIONS) expect(VALID.some(([t, , c]) => t === "formula" && c.fn === fn), fn).toBe(true);
    for (const template of AI_TEMPLATES) accepted("ai", null, { prompt: "x", output: { type: "text" }, template });
  });

  it.each(VALID)("%s %s %j", (type, operation, config) => {
    const parsed = accepted(type, operation, config);
    expect(parsed.operation).toBe(type === "enrichment" || type === "action" ? operation : null);
    // What is stored parses again to itself.
    expect(accepted(type, operation, parsed.config).config).toEqual(parsed.config);
  });

  it("fills in the defaults it stores", () => {
    expect(accepted("input", null, {}).config).toEqual({ dataType: "text" });
    expect(accepted("input", null, undefined).config).toEqual({ dataType: "text" });
    expect(accepted("enrichment", "find_email", { inputs: { linkedinUrl: a } }).config).toEqual({
      inputs: { linkedinUrl: a },
      quality: { mustBeValid: true, acceptCatchAll: false },
      waterfall: { steps: [{ source: "skout", enabled: true }] },
    });
    expect(accepted("enrichment", "find_phone", { inputs: { linkedinUrl: a }, quality: {} }).config.quality).toEqual({ phoneTypes: ["mobile", "direct"] });
    expect(accepted("enrichment", "linkedin_profile", { inputs: { linkedinUrl: a } }).config.fields).toEqual(["title", "seniority", "location", "currentCompany", "startDate"]);
    expect(accepted("ai", null, { prompt: "x", output: { type: "text" } }).config.webResearch).toBe(false);
  });

  it("stores references in lower case, in settings and in prompts", () => {
    const upper = A.toUpperCase();
    expect(accepted("formula", null, { fn: "trim_clean", source: { columnId: upper } }).config.source).toEqual(a);
    const ai = accepted("ai", null, { prompt: `Hi {{ ${upper}.title }}`, output: { type: "text" } });
    expect(ai.config.prompt).toBe(`Hi {{${A}.title}}`);
    expect(ai.references).toEqual([{ path: "prompt", columnId: A, field: "title" }]);
  });

  it("reports every reference with the place it is made", () => {
    const parsed = accepted("enrichment", "find_email", { inputs: { fullName: a, companyDomain: b }, condition: { rules: [{ columnId: B, op: "is_empty" }] } });
    expect(parsed.references.map((r) => [r.path, r.columnId])).toEqual([["inputs.fullName", A], ["inputs.companyDomain", B], ["condition.rules.0", B]]);
    const formula = accepted("formula", null, { fn: "if_then_else", condition: { rules: [rule] }, then: b, else: a });
    expect(formula.references.map((r) => r.path)).toEqual(["condition.rules.0", "then", "else"]);
    const action = accepted("action", "push_to_crm", { provider: "salesforce", object: "company", mapping: [{ crmField: "Name", columnId: A }, { crmField: "Site__c", columnId: B }] });
    expect(action.references.map((r) => r.path)).toEqual(["mapping.0", "mapping.1"]);
  });
});

describe("parseColumnConfig: strictness between types", () => {
  it("refuses an operation where there is none, a missing one and an unknown one", () => {
    for (const type of ["input", "ai", "formula"] as const) expect(refused(type, "find_email", {})[0]!.path).toBe("operation");
    for (const type of ["enrichment", "action"] as const) {
      for (const operation of [undefined, null, "", "nope"]) expect(refused(type, operation, {})[0]!.path).toBe("operation");
    }
    refused("enrichment", "send_to_webhook", { url: "https://a.example.com", columns: [a] });
    refused("action", "find_email", { inputs: { linkedinUrl: a } });
  });

  it("never accepts one type's or operation's settings as another's", () => {
    // The stored form (defaults filled in) is compared. Only input examples differ from each other by value alone.
    const shapes = VALID.filter(([type, , config]) => !(type === "input" && config.dataType !== "text")).map(
      ([type, operation, config]) => [type, operation, accepted(type, operation, config).config] as const
    );
    for (const [type, operation, config] of shapes) {
      for (const [otherType, otherOperation] of shapes) {
        if (type === otherType && operation === otherOperation) continue;
        refused(otherType, otherOperation, config);
      }
    }
  });

  const INVALID: Record<string, Array<[string | null, unknown]>> = {
    input: [
      [null, { dataType: "money" }],
      [null, { dataType: "text", format: "x" }],
      [null, { dataType: 5 }],
      [null, []],
      [null, "text"],
      [null, { inputs: { email: a } }],
    ],
    enrichment: [
      ["find_email", {}],
      ["find_email", { inputs: {} }],
      ["find_email", { inputs: { fullName: a } }],
      ["find_email", { inputs: { companyDomain: a } }],
      ["find_email", { inputs: { firstName: a, companyDomain: b } }],
      ["find_email", { inputs: { fullName: a, lastName: b, companyDomain: b } }],
      ["find_email", { inputs: { linkedinUrl: a, firstName: b } }],
      ["find_email", { inputs: { linkedinUrl: a, email: b } }],
      ["find_email", { inputs: { linkedinUrl: A } }],
      ["find_email", { inputs: { linkedinUrl: { columnId: "name" } } }],
      ["find_email", { inputs: { linkedinUrl: { columnId: A, extra: 1 } } }],
      ["find_email", { inputs: { linkedinUrl: a }, quality: { mustBeValid: false, acceptCatchAll: true } }],
      ["find_email", { inputs: { linkedinUrl: a }, quality: { phoneTypes: ["mobile"] } }],
      ["find_email", { inputs: { linkedinUrl: a }, provider: "secret" }],
      ["find_email", { inputs: { linkedinUrl: a }, maxCreditsPerRow: -1 }],
      ["find_email", { inputs: { linkedinUrl: a }, maxCreditsPerRow: 1.5 }],
      ["find_email", { inputs: { linkedinUrl: a }, maxCreditsPerRow: 1001 }],
      ["verify_email", { inputs: {} }],
      ["verify_email", { inputs: { email: a }, quality: {} }],
      ["find_phone", { inputs: { linkedinUrl: a }, quality: { phoneTypes: [] } }],
      ["find_phone", { inputs: { linkedinUrl: a }, quality: { phoneTypes: ["fax"] } }],
      ["find_phone", { inputs: { linkedinUrl: a }, quality: { phoneTypes: ["mobile", "mobile"] } }],
      ["company_data", { inputs: { companyDomain: a } }],
      ["company_data", { inputs: { companyDomain: a }, fields: [] }],
      ["company_data", { inputs: { companyDomain: a }, fields: ["secrets"] }],
      ["company_data", { inputs: { companyDomain: a }, fields: ["industry", "industry"] }],
      ["company_data", { inputs: {}, fields: ["industry"] }],
      ["linkedin_profile", { inputs: { fullName: a } }],
      ["linkedin_profile", { inputs: { linkedinUrl: a }, fields: ["salary"] }],
      ["company_domain", { inputs: { companyDomain: a } }],
      // Waterfall settings.
      ["find_email", { inputs: { linkedinUrl: a }, waterfall: { steps: [] } }],
      ["find_email", { inputs: { linkedinUrl: a }, waterfall: { steps: [{ source: "skout", enabled: false }] } }],
      ["find_email", { inputs: { linkedinUrl: a }, waterfall: { steps: [{ source: "own_key", provider: "hunter", enabled: true }] } }],
      ["find_email", { inputs: { linkedinUrl: a }, waterfall: { steps: [{ source: "skout", enabled: true }, { source: "skout", enabled: true }] } }],
      ["find_email", { inputs: { linkedinUrl: a }, waterfall: { steps: [{ source: "skout", enabled: true, provider: "managed_one" }] } }],
      ["find_email", { inputs: { linkedinUrl: a }, waterfall: { steps: [{ source: "managed_one", enabled: true }] } }],
      ["find_email", { inputs: { linkedinUrl: a }, waterfall: { steps: [{ source: "skout", enabled: true }, { source: "own_key", provider: "lusha", enabled: true }] } }],
      ["find_email", { inputs: { linkedinUrl: a }, waterfall: { steps: [{ source: "skout", enabled: true }, { source: "own_key", provider: "hunter", enabled: true }, { source: "own_key", provider: "hunter", enabled: false }] } }],
      ["find_email", { inputs: { linkedinUrl: a }, waterfall: { steps: [{ source: "skout", enabled: true }, { source: "own_key", provider: "hunter", enabled: true, apiKey: "k" }] } }],
      // Conditions.
      ["verify_email", { inputs: { email: a }, condition: { rules: [] } }],
      ["verify_email", { inputs: { email: a }, condition: { rules: [{ columnId: A, op: "matches", value: "x" }] } }],
      ["verify_email", { inputs: { email: a }, condition: { rules: [{ columnId: A, op: "is_empty", value: "x" }] } }],
      ["verify_email", { inputs: { email: a }, condition: { rules: [{ columnId: A, op: "equals" }] } }],
      ["verify_email", { inputs: { email: a }, condition: { rules: [{ columnId: A, op: "gt", value: "soon" }] } }],
      ["verify_email", { inputs: { email: a }, condition: { rules: [{ columnId: A, op: "in", value: [] }] } }],
      ["verify_email", { inputs: { email: a }, condition: { rules: [{ columnId: A, op: "contains", value: "" }] } }],
      ["verify_email", { inputs: { email: a }, condition: { match: "some", rules: [rule] } }],
      ["verify_email", { inputs: { email: a }, condition: { rules: Array.from({ length: 11 }, () => rule) } }],
    ],
    ai: [
      [null, {}],
      [null, { prompt: "x" }],
      [null, { output: { type: "text" } }],
      [null, { prompt: "   ", output: { type: "text" } }],
      [null, { prompt: "x".repeat(8_001), output: { type: "text" } }],
      [null, { prompt: "x", output: { type: "json" } }],
      [null, { prompt: "x", output: { type: "text", options: ["a", "b"] } }],
      [null, { prompt: "x", output: { type: "category", options: ["one"] } }],
      [null, { prompt: "x", output: { type: "category", options: ["a", "A"] } }],
      [null, { prompt: "x", output: { type: "category" } }],
      [null, { prompt: "x", output: { type: "fields", fields: [] } }],
      [null, { prompt: "x", output: { type: "fields", fields: [{ name: "a b", type: "text" }] } }],
      [null, { prompt: "x", output: { type: "fields", fields: [{ name: "a", type: "date" }] } }],
      [null, { prompt: "x", output: { type: "fields", fields: [{ name: "a", type: "text" }, { name: "A", type: "text" }] } }],
      [null, { prompt: "x", output: { type: "text" }, webResearch: "yes" }],
      [null, { prompt: "x", output: { type: "text" }, template: "my_own" }],
      [null, { prompt: "x", output: { type: "text" }, model: "anything" }],
      [null, { prompt: "x", output: { type: "text" }, maxCreditsPerRow: 1 }],
      [null, { prompt: "Hi {{first_name}}", output: { type: "text" } }],
      [null, { prompt: `Hi {{${A}.a.b}}`, output: { type: "text" } }],
      [null, { prompt: `Hi {{${A}`, output: { type: "text" } }],
      [null, { prompt: "Hi }}", output: { type: "text" } }],
      [null, { prompt: "Hi {{}}", output: { type: "text" } }],
    ],
    formula: [
      [null, {}],
      [null, { fn: "eval", source: a }],
      [null, { fn: "javascript", code: "process.exit(1)" }],
      [null, { fn: "trim_clean" }],
      [null, { fn: "trim_clean", source: a, expression: "1+1" }],
      [null, { fn: "extract_domain", source: "{{x}}" }],
      [null, { fn: "split_name", source: a, part: "middle" }],
      [null, { fn: "join", parts: [] }],
      [null, { fn: "join", parts: [{ text: "only text" }] }],
      [null, { fn: "join", parts: [a], separator: "x".repeat(21) }],
      [null, { fn: "change_case", source: a, case: "camel" }],
      [null, { fn: "find_replace", source: a, find: "", replace: "x" }],
      [null, { fn: "find_replace", source: a, find: "x" }],
      [null, { fn: "if_then_else", condition: { rules: [rule] }, then: a }],
      [null, { fn: "if_then_else", condition: { rules: [rule] }, then: "a", else: "b" }],
      [null, { fn: "if_then_else", then: a, else: b }],
      [null, { fn: "number_format", source: a, decimals: 11 }],
      [null, { fn: "date_part", source: a, part: "century" }],
      [null, { fn: "first_non_empty", sources: [a] }],
      [null, { fn: "first_non_empty", sources: [a, a] }],
      [null, { fn: "regex_extract", source: a, pattern: "(" }],
      [null, { fn: "regex_extract", source: a, pattern: "a(b)", group: 2 }],
      [null, { fn: "regex_extract", source: a, pattern: "x".repeat(201) }],
      [null, { fn: "regex_extract", source: a, pattern: "a", flags: "g" }],
    ],
    action: [
      ["add_to_sequence", { sequenceId: SEQ }],
      ["add_to_sequence", { emailColumn: a }],
      ["add_to_sequence", { sequenceId: "my-sequence", emailColumn: a }],
      ["add_to_list", {}],
      ["add_to_list", { listId: SEQ, workspaceId: SEQ }],
      ["push_to_crm", { provider: "zoho", object: "contact", mapping: [{ crmField: "email", columnId: A }] }],
      ["push_to_crm", { provider: "hubspot", object: "deal", mapping: [{ crmField: "email", columnId: A }] }],
      ["push_to_crm", { provider: "hubspot", object: "contact", mapping: [] }],
      ["push_to_crm", { provider: "hubspot", object: "contact", mapping: [{ crmField: "bad field", columnId: A }] }],
      ["push_to_crm", { provider: "hubspot", object: "contact", mapping: [{ crmField: "email", columnId: A }, { crmField: "Email", columnId: B }] }],
      ["send_to_webhook", { url: "https://hooks.example.com/x", columns: [] }],
      ["send_to_webhook", { url: "https://hooks.example.com/x", columns: [a, a] }],
      ["send_to_webhook", { url: "https://hooks.example.com/x", columns: [a], headers: { authorization: "x" } }],
      ...["http://hooks.example.com/x", "https://localhost/x", "https://localhost./x", "https://127.0.0.1/x", "https://2130706433/x", "https://10.1.2.3/x", "https://169.254.169.254/latest", "https://[::1]/x", "https://[::ffff:127.0.0.1]/x", "https://metadata.google.internal./x", "https://user:pw@example.com/x", "not a url", `https://example.com/${"x".repeat(2_000)}`].map(
        (url): [string, unknown] => ["send_to_webhook", { url, columns: [a] }]
      ),
    ],
  };

  for (const [type, cases] of Object.entries(INVALID)) {
    it(`refuses invalid ${type} settings`, () => {
      for (const [operation, config] of cases) {
        const problems = refused(type as ColumnType, operation, config);
        expect(problems[0]!.message.length).toBeGreaterThan(0);
      }
    });
  }

  it("refuses NUL characters and oversized settings", () => {
    refused("ai", null, { prompt: "a\u0000", output: { type: "text" } });
    refused("formula", null, { fn: "join", parts: [a, { text: "\u0000" }] });
    refused("ai", null, { prompt: "x", output: { type: "text" }, padding: "x".repeat(60_000) });
  });

  it("says where the problem is", () => {
    expect(refused("enrichment", "find_email", { inputs: { fullName: a } })[0]).toEqual({ path: "inputs.companyDomain", message: "Needs: company domain, to go with the name" });
    expect(refused("enrichment", "company_data", { inputs: { companyDomain: a }, fields: ["nope"] })[0]!.path).toBe("fields.0");
  });

  it("only treats text as code nowhere: formula text is stored as written", () => {
    const hostile = "'); process.exit(1); ({{";
    expect(accepted("formula", null, { fn: "find_replace", source: a, find: hostile, replace: "${require('fs')}" }).config.find).toBe(hostile);
  });
});

describe("captureGroups", () => {
  it("counts groups from the pattern's text", () => {
    const cases: Array<[string, number]> = [["abc", 0], ["a(b)", 1], ["(a)(b(c))", 3], ["(?:a)(?=b)(?!c)(?<=d)(?<!e)", 0], ["(?<name>a)", 1], ["\\(a\\)", 0], ["[(](x)[)\\]]", 1]];
    for (const [pattern, groups] of cases) {
      expect(captureGroups(pattern), pattern).toBe(groups);
      expect(new RegExp(`${pattern}|`).exec("")!.length - 1, pattern).toBe(groups); // agrees with the engine
    }
  });
});

describe("references between columns", () => {
  const column = (id: string, type: string, operation: string | null, config: Record<string, unknown>): ColumnShape => ({ id, name: `c${id.slice(-1)}`, type, operation, config });
  const id = (n: number) => `dddddddd-0000-4000-8000-00000000000${n}`;
  const columns = [
    column(id(1), "input", null, { dataType: "number" }),
    column(id(2), "input", null, { dataType: "email" }),
    column(id(3), "enrichment", "company_data", { fields: ["industry", "headcount"] }),
    column(id(4), "action", "add_to_list", {}),
    column(id(5), "ai", null, { output: { type: "fields", fields: [{ name: "fit", type: "yes_no" }] } }),
    column(id(6), "formula", null, { fn: "first_non_empty", sources: [{ columnId: id(1) }, { columnId: id(3), field: "headcount" }] }),
  ];
  const byId = new Map(columns.map((c) => [c.id, c]));
  const problems = (reference: Parameters<typeof referenceProblems>[1][number]) => referenceProblems(id(9), [reference], byId).map((p) => p.message);

  it("knows what each column holds", () => {
    expect(columns.map((c) => columnOutput(c, byId))).toEqual([
      { kind: "number" },
      { kind: "email" },
      { fields: { industry: "text", headcount: "number" } },
      null,
      { fields: { fit: "checkbox" } },
      { kind: "number" },
    ]);
  });

  it("refuses missing columns, itself, action results, wrong fields and wrong kinds", () => {
    expect(problems({ path: "p", columnId: id(8) })).toEqual(["This workbook has no such column"]);
    expect(referenceProblems(id(1), [{ path: "p", columnId: id(1) }], byId)[0]!.message).toBe("A column cannot refer to itself");
    expect(problems({ path: "p", columnId: id(4) })[0]).toMatch(/action column/);
    expect(problems({ path: "p", columnId: id(3) })[0]).toMatch(/Choose a field/);
    expect(problems({ path: "p", columnId: id(3), field: "revenueBand" })[0]).toMatch(/Choose a field/);
    expect(problems({ path: "p", columnId: id(3), field: "toString" })[0]).toMatch(/Choose a field/);
    expect(problems({ path: "p", columnId: id(1), field: "x" })[0]).toMatch(/has no fields/);
    expect(problems({ path: "p", columnId: id(1), accepts: ["email", "text"] })[0]).toMatch(/holds number values/);
    expect(problems({ path: "p", columnId: id(2), accepts: ["email", "text"] })).toEqual([]);
    expect(problems({ path: "p", columnId: id(3), field: "headcount" })).toEqual([]);
  });

  it("checks comparisons against the kind of value", () => {
    const check = (target: number, op: string, value?: unknown, field?: string) => problems({ path: "p", columnId: id(target), field, rule: { op, value } }).length;
    expect([check(1, "gt", 5), check(1, "equals", 5), check(1, "in", [1, 2]), check(1, "is_empty")]).toEqual([0, 0, 0, 0]);
    expect([check(1, "gt", "2026-01-01"), check(1, "equals", "5"), check(1, "contains", "5"), check(1, "in", [1, "2"])]).toEqual([1, 1, 1, 1]);
    expect([check(2, "contains", "@acme"), check(2, "gt", 5)]).toEqual([0, 1]);
    expect([check(5, "equals", true, "fit"), check(5, "equals", "yes", "fit"), check(5, "gt", 1, "fit")]).toEqual([0, 1, 1]);
  });

  it("finds mentions in any shape and detects circles", () => {
    expect(mentions(columns[5]!, id(1))).toBe(true);
    expect(mentions(columns[5]!, id(2))).toBe(false);
    expect(mentions(column(id(7), "ai", null, { prompt: `{{${id(2).toUpperCase()}}}` }), id(2))).toBe(true);
    expect(hasReferenceCycle(id(6), byId)).toBe(false);
    const looped = new Map(byId).set(id(3), column(id(3), "formula", null, { fn: "trim_clean", source: { columnId: id(7) } }));
    looped.set(id(7), column(id(7), "formula", null, { fn: "trim_clean", source: { columnId: id(6) } }));
    expect(hasReferenceCycle(id(6), looped)).toBe(true);
    expect(columnOutput(looped.get(id(6))!, looped)).toBeTruthy(); // a circle never hangs
  });
});

describe("webhookUrlProblem", () => {
  it("treats a trailing dot as the same host", () => {
    for (const url of ["https://localhost./x", "https://db.internal./x", "https://printer.local./x"]) expect(webhookUrlProblem(url), url).not.toBeNull();
    expect(webhookUrlProblem("https://hooks.example.com./x")).toBeNull();
  });
});
