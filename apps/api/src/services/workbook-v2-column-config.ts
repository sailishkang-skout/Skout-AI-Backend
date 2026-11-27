import { z } from "zod";
import { schema } from "@skout/db";
import { webhookUrlProblem } from "../utils/webhook-url.js";
import { INPUT_DATA_TYPES, inputDataType, type InputDataType } from "./workbook-cell-values.js";

/**
 * What each Workbooks V2 column type stores in `workbook_columns.config`, and what it may refer to (WB2-013, PRD 7.3).
 *
 * Everything here is pure: it checks shapes and references and runs nothing. No formula is evaluated, no prompt is
 * sent, no provider or action is called.
 *
 * Every schema is strict, so a setting that belongs to another type or operation is refused, never ignored. A column
 * is referred to by its id, `{ columnId }`, plus `field` when that column returns several values (company data,
 * LinkedIn profile, an AI column with named fields). Prompts embed the same reference as `{{<columnId>}}` or
 * `{{<columnId>.<field>}}`. Ids are stored in lower case; duplicating a workbook rewrites them.
 */
export const ENRICHMENT_OPERATIONS = ["find_email", "verify_email", "find_phone", "company_data", "linkedin_profile", "company_domain"] as const;
export const ACTION_OPERATIONS = ["add_to_sequence", "add_to_list", "push_to_crm", "send_to_webhook"] as const;
export const FORMULA_FUNCTIONS = [
  "extract_domain",
  "split_name",
  "join",
  "change_case",
  "trim_clean",
  "find_replace",
  "if_then_else",
  "number_format",
  "date_part",
  "first_non_empty",
  "regex_extract",
] as const;
export const AI_TEMPLATES = ["first_line", "icp_fit", "summarise_company", "classify_industry", "tech_stack"] as const;
export const CRM_PROVIDERS = ["hubspot", "salesforce", "pipedrive"] as const;
export const COMPANY_DATA_FIELDS = { industry: "text", headcount: "number", location: "text", revenueBand: "text", linkedinUrl: "linkedin_url", description: "text" } as const;
export const LINKEDIN_PROFILE_FIELDS = { title: "text", seniority: "text", location: "text", currentCompany: "text", startDate: "date" } as const;

export type ColumnType = (typeof schema.WORKBOOK_COLUMN_TYPES_V2)[number];
export type EnrichmentOperation = (typeof ENRICHMENT_OPERATIONS)[number];
export type ActionOperation = (typeof ACTION_OPERATIONS)[number];

/** The workspace's own provider keys that can serve an operation. Skout's managed providers are never named. */
export const OWN_KEY_PROVIDERS: Record<EnrichmentOperation, readonly string[]> = {
  find_email: ["hunter"],
  verify_email: ["hunter", "millionverifier", "zerobounce", "neverbounce"],
  find_phone: ["datagma", "kaspr", "lusha", "contactout"],
  company_data: ["pdl"],
  linkedin_profile: [],
  company_domain: [],
};

export const MAX_CONFIG_BYTES = 50_000;

export interface ConfigProblem {
  /** Where in `config`, e.g. `inputs.email`. */
  path: string;
  message: string;
}

export interface ColumnReference {
  path: string;
  columnId: string;
  field?: string;
  /** Kinds of value this place can read; undefined reads anything. */
  accepts?: readonly InputDataType[];
  /** A comparison made against the referenced value. */
  rule?: { op: string; value?: unknown };
}

/** Things outside the workbook that a config names; the service checks they belong to the workspace. */
export interface ExternalTargets {
  ownKeyProviders?: Array<{ path: string; provider: string }>;
  sequenceId?: string;
  listId?: string;
  crmProvider?: string;
}

export type ParsedColumnConfig =
  | { ok: true; operation: string | null; config: Record<string, unknown>; references: ColumnReference[]; targets: ExternalTargets }
  | { ok: false; problems: ConfigProblem[] };

const uuid = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
const fieldName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/, "a field name: letters, digits and underscores");
const refShape = { columnId: uuid, field: fieldName.optional() };
const ref = z.object(refShape).strict();
type Ref = z.infer<typeof ref>;

const isoDate = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;
const scalar = z.union([z.string().max(1_000), z.number().finite(), z.boolean()]);
const rule = <O extends z.ZodTypeAny, V extends z.ZodRawShape>(op: O, value: V) => z.object({ ...refShape, op, ...value }).strict();
const conditionRule = z.union([
  rule(z.enum(["is_empty", "has_value"]), {}),
  rule(z.enum(["equals", "not_equals"]), { value: scalar }),
  rule(z.enum(["contains", "not_contains"]), { value: z.string().min(1).max(1_000) }),
  rule(z.enum(["gt", "gte", "lt", "lte"]), { value: z.union([z.number().finite(), z.string().regex(isoDate, "an ISO date")]) }),
  rule(z.enum(["in", "not_in"]), { value: z.array(scalar).min(1).max(100) }),
]);
/** "Only run if" (PRD WF-7), built from a picker. */
const condition = z.object({ match: z.enum(["all", "any"]).default("all"), rules: z.array(conditionRule).min(1).max(10) }).strict();
type Condition = z.infer<typeof condition>;

const unique = (values: readonly unknown[]) => new Set(values).size === values.length;

// ── Input ─────────────────────────────────────────────────────────────────────

const inputConfig = z.object({ dataType: z.enum(INPUT_DATA_TYPES).default("text") }).strict();

// ── Waterfall enrichment ──────────────────────────────────────────────────────

const waterfallStep = z.discriminatedUnion("source", [
  z.object({ source: z.literal("skout"), enabled: z.boolean() }).strict(),
  z.object({ source: z.literal("own_key"), provider: z.string().min(1).max(50), enabled: z.boolean() }).strict(),
]);
const waterfall = z
  .object({ steps: z.array(waterfallStep).min(1).max(20) })
  .strict()
  .default({ steps: [{ source: "skout", enabled: true }] });
const enrichmentShared = { condition: condition.optional(), waterfall, maxCreditsPerRow: z.number().int().min(0).max(1_000).optional() };

const nameRoles = { fullName: ref.optional(), firstName: ref.optional(), lastName: ref.optional() };
const personInputs = z.object({ ...nameRoles, companyDomain: ref.optional(), linkedinUrl: ref.optional() }).strict();

const enrichmentConfigs = {
  find_email: z
    .object({
      inputs: personInputs,
      quality: z.object({ mustBeValid: z.boolean().default(true), acceptCatchAll: z.boolean().default(false) }).strict().default({}),
      ...enrichmentShared,
    })
    .strict(),
  verify_email: z.object({ inputs: z.object({ email: ref }).strict(), ...enrichmentShared }).strict(),
  find_phone: z
    .object({
      inputs: personInputs,
      quality: z
        .object({ phoneTypes: z.array(z.enum(["mobile", "direct"])).min(1).refine(unique, "must not repeat").default(["mobile", "direct"]) })
        .strict()
        .default({}),
      ...enrichmentShared,
    })
    .strict(),
  company_data: z
    .object({
      inputs: z.object({ companyDomain: ref.optional(), companyName: ref.optional() }).strict(),
      fields: z
        .array(z.enum(Object.keys(COMPANY_DATA_FIELDS) as [keyof typeof COMPANY_DATA_FIELDS]))
        .min(1)
        .refine(unique, "must not repeat"),
      ...enrichmentShared,
    })
    .strict(),
  linkedin_profile: z
    .object({
      inputs: z.object({ ...nameRoles, linkedinUrl: ref.optional(), companyName: ref.optional(), companyDomain: ref.optional() }).strict(),
      fields: z
        .array(z.enum(Object.keys(LINKEDIN_PROFILE_FIELDS) as [keyof typeof LINKEDIN_PROFILE_FIELDS]))
        .min(1)
        .refine(unique, "must not repeat")
        .default(Object.keys(LINKEDIN_PROFILE_FIELDS) as Array<keyof typeof LINKEDIN_PROFILE_FIELDS>),
      ...enrichmentShared,
    })
    .strict(),
  company_domain: z.object({ inputs: z.object({ companyName: ref }).strict(), ...enrichmentShared }).strict(),
} satisfies Record<EnrichmentOperation, z.ZodTypeAny>;

const TEXT: readonly InputDataType[] = ["text"];
/** What each enrichment input can read. Text is always allowed: imported columns often arrive as text. */
const ROLE_ACCEPTS: Record<string, readonly InputDataType[]> = {
  fullName: TEXT,
  firstName: TEXT,
  lastName: TEXT,
  companyName: TEXT,
  companyDomain: ["domain", "url", "text"],
  linkedinUrl: ["linkedin_url", "url", "text"],
  email: ["email", "text"],
};

type Inputs = Partial<Record<keyof typeof ROLE_ACCEPTS, Ref>>;

/** The combinations of inputs an operation can work from (PRD 7.3.2, "Reads"). */
function inputProblems(operation: EnrichmentOperation, inputs: Inputs): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const problem = (message: string, path = "inputs") => out.push({ path, message });
  const parts = [inputs.firstName, inputs.lastName].filter(Boolean).length;
  if (inputs.fullName && parts) problem("Map either a full name or a first and last name, not both");
  else if (parts === 1) problem("Map first name and last name together");
  const hasName = Boolean(inputs.fullName) || parts === 2;

  if (operation === "find_email" || operation === "find_phone") {
    if ((hasName || parts) && !inputs.companyDomain) problem("Needs: company domain, to go with the name", "inputs.companyDomain");
    if (inputs.companyDomain && !hasName && !parts) problem("Needs: a name, to go with the company domain");
    if (!inputs.linkedinUrl && !(hasName && inputs.companyDomain)) problem("Needs: a LinkedIn URL, or a name and a company domain");
  }
  if (operation === "linkedin_profile") {
    const company = Boolean(inputs.companyName || inputs.companyDomain);
    if (!inputs.linkedinUrl && !(hasName && company)) problem("Needs: a LinkedIn URL, or a name and a company");
  }
  if (operation === "company_data" && !inputs.companyDomain && !inputs.companyName) problem("Needs: a company domain or a company name");
  return out;
}

// ── AI ────────────────────────────────────────────────────────────────────────

const aiField = z
  .object({ name: fieldName, type: z.enum(["text", "number", "yes_no"]), description: z.string().max(500).optional() })
  .strict();
const aiOutput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }).strict(),
  z.object({ type: z.literal("number") }).strict(),
  z.object({ type: z.literal("yes_no") }).strict(),
  z
    .object({
      type: z.literal("category"),
      options: z
        .array(z.string().trim().min(1).max(100))
        .min(2)
        .max(50)
        .refine((o) => unique(o.map((v) => v.toLowerCase())), "options must differ"),
    })
    .strict(),
  z
    .object({
      type: z.literal("fields"),
      fields: z
        .array(aiField)
        .min(1)
        .max(20)
        .refine((f) => unique(f.map((v) => v.name.toLowerCase())), "field names must differ"),
    })
    .strict(),
]);
const aiConfig = z
  .object({
    prompt: z.string().trim().min(1).max(8_000),
    output: aiOutput,
    webResearch: z.boolean().default(false),
    template: z.enum(AI_TEMPLATES).optional(),
    condition: condition.optional(),
  })
  .strict();

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** The columns a prompt refers to. Only references inserted by the column picker are allowed inside `{{ }}`. */
function promptReferences(prompt: string): { prompt: string; references: ColumnReference[]; problems: ConfigProblem[] } {
  const references: ColumnReference[] = [];
  const problems: ConfigProblem[] = [];
  const normalized = prompt.replace(PLACEHOLDER, (whole, inner: string) => {
    const [id, field, ...rest] = inner.trim().split(".");
    const parsed = ref.safeParse({ columnId: id, ...(field === undefined ? {} : { field }) });
    if (!parsed.success || rest.length) {
      problems.push({ path: "prompt", message: `${whole.slice(0, 80)} is not a column reference; insert columns with the column picker` });
      return whole;
    }
    references.push({ path: "prompt", ...parsed.data });
    return `{{${parsed.data.columnId}${parsed.data.field ? `.${parsed.data.field}` : ""}}}`;
  });
  const leftOver = prompt.replace(PLACEHOLDER, "");
  if (leftOver.includes("{{") || leftOver.includes("}}")) problems.push({ path: "prompt", message: "A column reference is incomplete: {{ and }} must come in pairs" });
  return { prompt: normalized, references, problems };
}

// ── Formula / transform ───────────────────────────────────────────────────────

const operand = z.union([ref, z.object({ value: scalar.nullable() }).strict()]);
const joinPart = z.union([ref, z.object({ text: z.string().max(200) }).strict()]);
const formula = <F extends string, S extends z.ZodRawShape>(fn: F, shape: S) => z.object({ fn: z.literal(fn), ...shape }).strict();
const formulaConfig = z.discriminatedUnion("fn", [
  formula("extract_domain", { source: ref }),
  formula("split_name", { source: ref, part: z.enum(["first", "last"]) }),
  formula("join", { parts: z.array(joinPart).min(1).max(20), separator: z.string().max(20).default(" ") }),
  formula("change_case", { source: ref, case: z.enum(["upper", "lower", "title", "sentence"]) }),
  formula("trim_clean", { source: ref }),
  formula("find_replace", { source: ref, find: z.string().min(1).max(500), replace: z.string().max(500), matchCase: z.boolean().default(false) }),
  formula("if_then_else", { condition, then: operand, else: operand }),
  formula("number_format", {
    source: ref,
    decimals: z.number().int().min(0).max(10).default(2),
    thousandsSeparator: z.boolean().default(true),
    prefix: z.string().max(10).default(""),
    suffix: z.string().max(10).default(""),
  }),
  formula("date_part", { source: ref, part: z.enum(["year", "quarter", "month", "day", "weekday"]) }),
  formula("first_non_empty", { sources: z.array(ref).min(2).max(20) }),
  formula("regex_extract", { source: ref, pattern: z.string().min(1).max(200), ignoreCase: z.boolean().default(false), group: z.number().int().min(0).max(20).default(0) }),
]);

/** Capture groups in a pattern that already compiles, counted from its text so the pattern is never run. */
export function captureGroups(pattern: string): number {
  let groups = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") i++;
    else if (inClass) inClass = c !== "]";
    else if (c === "[") inClass = true;
    else if (c === "(" && (pattern[i + 1] !== "?" || (pattern[i + 2] === "<" && pattern[i + 3] !== "=" && pattern[i + 3] !== "!"))) groups++;
  }
  return groups;
}

function formulaReferences(config: z.infer<typeof formulaConfig>): { references: ColumnReference[]; problems: ConfigProblem[] } {
  const references: ColumnReference[] = [];
  const problems: ConfigProblem[] = [];
  const add = (path: string, r: Ref, accepts?: readonly InputDataType[]) => references.push({ path, columnId: r.columnId, field: r.field, accepts });
  const textual: readonly InputDataType[] = ["text", "email", "url", "linkedin_url", "domain", "phone"];
  switch (config.fn) {
    case "extract_domain":
      add("source", config.source, ["email", "url", "linkedin_url", "domain", "text"]);
      break;
    case "split_name":
      add("source", config.source, TEXT);
      break;
    case "join":
      config.parts.forEach((part, i) => "columnId" in part && add(`parts.${i}`, part));
      if (!config.parts.some((part) => "columnId" in part)) problems.push({ path: "parts", message: "Join at least one column" });
      break;
    case "change_case":
    case "trim_clean":
    case "find_replace":
      add("source", config.source, textual);
      break;
    case "regex_extract": {
      add("source", config.source, textual);
      try {
        new RegExp(config.pattern, config.ignoreCase ? "i" : "");
        const groups = captureGroups(config.pattern);
        if (config.group > groups) problems.push({ path: "group", message: `The pattern has ${groups} capture group${groups === 1 ? "" : "s"}` });
      } catch {
        problems.push({ path: "pattern", message: "Not a valid regular expression" });
      }
      break;
    }
    case "if_then_else":
      references.push(...conditionReferences(config.condition, "condition"));
      for (const branch of ["then", "else"] as const) {
        const value = config[branch];
        if ("columnId" in value) add(branch, value);
      }
      break;
    case "number_format":
      add("source", config.source, ["number", "text"]);
      break;
    case "date_part":
      add("source", config.source, ["date", "text"]);
      break;
    case "first_non_empty":
      config.sources.forEach((source, i) => add(`sources.${i}`, source));
      if (!unique(config.sources.map((s) => `${s.columnId}.${s.field ?? ""}`))) problems.push({ path: "sources", message: "must not repeat" });
      break;
  }
  return { references, problems };
}

// ── Action / export ───────────────────────────────────────────────────────────

const actionShared = { condition: condition.optional() };
const actionConfigs = {
  add_to_sequence: z.object({ sequenceId: uuid, emailColumn: ref, ...actionShared }).strict(),
  add_to_list: z.object({ listId: uuid, ...actionShared }).strict(),
  push_to_crm: z
    .object({
      provider: z.enum(CRM_PROVIDERS),
      object: z.enum(["contact", "company"]),
      mapping: z
        .array(z.object({ crmField: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,99}$/, "a CRM field name"), ...refShape }).strict())
        .min(1)
        .max(100)
        .refine((m) => unique(m.map((v) => v.crmField.toLowerCase())), "each CRM field can be filled once"),
      ...actionShared,
    })
    .strict(),
  send_to_webhook: z
    .object({
      url: z
        .string()
        .max(2_000)
        .superRefine((value, ctx) => {
          const problem = webhookUrlProblem(value);
          if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
        }),
      columns: z
        .array(ref)
        .min(1)
        .max(200)
        .refine((c) => unique(c.map((v) => `${v.columnId}.${v.field ?? ""}`)), "must not repeat"),
      ...actionShared,
    })
    .strict(),
} satisfies Record<ActionOperation, z.ZodTypeAny>;

// ── Parsing ───────────────────────────────────────────────────────────────────

function conditionReferences(value: Condition | undefined, path: string): ColumnReference[] {
  return (value?.rules ?? []).map((r, i) => ({
    path: `${path}.rules.${i}`,
    columnId: r.columnId,
    field: r.field,
    rule: { op: r.op, value: "value" in r ? r.value : undefined },
  }));
}

const containsNul = (value: unknown): boolean =>
  typeof value === "string"
    ? value.includes("\u0000")
    : !!value && typeof value === "object" && Object.entries(value).some(([k, v]) => k.includes("\u0000") || containsNul(v));

/** A union reports one unhelpful issue; show the issues of the branch that came closest. */
function toProblems(error: z.ZodError): ConfigProblem[] {
  const flatten = (issues: z.ZodIssue[]): z.ZodIssue[] =>
    issues.flatMap((issue) => {
      if (issue.code !== "invalid_union") return [issue];
      const closest = [...issue.unionErrors].sort((a, b) => a.issues.length - b.issues.length)[0];
      return closest ? flatten(closest.issues) : [issue];
    });
  return flatten(error.issues).map((i) => ({ path: i.path.join("."), message: i.message }));
}

const fail = (path: string, message: string): ParsedColumnConfig => ({ ok: false, problems: [{ path, message }] });

/** Checks `config` against the column's type and operation, and returns it with defaults filled in. */
export function parseColumnConfig(type: ColumnType, operation: string | null | undefined, config: unknown): ParsedColumnConfig {
  if (containsNul(config)) return fail("", "Text must not contain a NUL character");
  if (JSON.stringify(config ?? {}).length > MAX_CONFIG_BYTES) return fail("", "The column settings are too large");

  const needsOperation = type === "enrichment" || type === "action";
  if (!needsOperation && operation) return fail("operation", `${type} columns have no operation`);
  const allowed: readonly string[] = type === "enrichment" ? ENRICHMENT_OPERATIONS : ACTION_OPERATIONS;
  if (needsOperation && !(operation && allowed.includes(operation))) return fail("operation", `Choose one of: ${allowed.join(", ")}`);

  const done = (parsed: Record<string, unknown>, references: ColumnReference[], targets: ExternalTargets, problems: ConfigProblem[] = []): ParsedColumnConfig =>
    problems.length ? { ok: false, problems } : { ok: true, operation: needsOperation ? operation! : null, config: parsed, references, targets };
  const raw = config ?? {};

  if (type === "input") {
    const r = inputConfig.safeParse(raw);
    return r.success ? done(r.data, [], {}) : { ok: false, problems: toProblems(r.error) };
  }

  if (type === "enrichment") {
    const op = operation as EnrichmentOperation;
    const r = (enrichmentConfigs[op] as z.ZodTypeAny).safeParse(raw);
    if (!r.success) return { ok: false, problems: toProblems(r.error) };
    const data = r.data as { inputs: Inputs; condition?: Condition; waterfall: z.infer<typeof waterfall>; quality?: { mustBeValid?: boolean; acceptCatchAll?: boolean } };
    const problems = inputProblems(op, data.inputs);
    if (data.quality?.acceptCatchAll && data.quality.mustBeValid === false) {
      problems.push({ path: "quality.acceptCatchAll", message: "Accepting catch-all addresses only applies when the email must be valid" });
    }
    const steps = data.waterfall.steps;
    if (steps.filter((s) => s.source === "skout").length !== 1) problems.push({ path: "waterfall.steps", message: "The waterfall has exactly one Skout data step; turn it off rather than removing it" });
    if (!steps.some((s) => s.enabled)) problems.push({ path: "waterfall.steps", message: "Turn on at least one source" });
    const ownKeys = steps.flatMap((s, i) => (s.source === "own_key" ? [{ path: `waterfall.steps.${i}.provider`, provider: s.provider }] : []));
    if (!unique(ownKeys.map((k) => k.provider))) problems.push({ path: "waterfall.steps", message: "Each provider can appear once" });
    for (const k of ownKeys) {
      if (!OWN_KEY_PROVIDERS[op].includes(k.provider)) problems.push({ path: k.path, message: "This provider cannot be used for this operation" });
    }
    const references = [
      ...Object.entries(data.inputs).flatMap(([role, r2]) => (r2 ? [{ path: `inputs.${role}`, columnId: r2.columnId, field: r2.field, accepts: ROLE_ACCEPTS[role] }] : [])),
      ...conditionReferences(data.condition, "condition"),
    ];
    return done(r.data as Record<string, unknown>, references, { ownKeyProviders: ownKeys }, problems);
  }

  if (type === "ai") {
    const r = aiConfig.safeParse(raw);
    if (!r.success) return { ok: false, problems: toProblems(r.error) };
    const prompt = promptReferences(r.data.prompt);
    return done({ ...r.data, prompt: prompt.prompt }, [...prompt.references, ...conditionReferences(r.data.condition, "condition")], {}, prompt.problems);
  }

  if (type === "formula") {
    const r = formulaConfig.safeParse(raw);
    if (!r.success) return { ok: false, problems: toProblems(r.error) };
    const { references, problems } = formulaReferences(r.data);
    return done(r.data, references, {}, problems);
  }

  if (type === "action") {
    const op = operation as ActionOperation;
    const r = (actionConfigs[op] as z.ZodTypeAny).safeParse(raw);
    if (!r.success) return { ok: false, problems: toProblems(r.error) };
    const data = r.data as {
      condition?: Condition;
      sequenceId?: string;
      listId?: string;
      provider?: string;
      emailColumn?: Ref;
      mapping?: Array<Ref & { crmField: string }>;
      columns?: Ref[];
    };
    const references: ColumnReference[] = [
      ...(data.emailColumn ? [{ path: "emailColumn", ...data.emailColumn, accepts: ROLE_ACCEPTS.email }] : []),
      ...(data.mapping ?? []).map((m, i) => ({ path: `mapping.${i}`, columnId: m.columnId, field: m.field })),
      ...(data.columns ?? []).map((c, i) => ({ path: `columns.${i}`, ...c })),
      ...conditionReferences(data.condition, "condition"),
    ];
    return done(r.data as Record<string, unknown>, references, { sequenceId: data.sequenceId, listId: data.listId, crmProvider: data.provider });
  }

  return fail("type", `Choose one of: ${schema.WORKBOOK_COLUMN_TYPES_V2.join(", ")}`);
}

// ── References between columns ────────────────────────────────────────────────

export interface ColumnShape {
  id: string;
  name: string;
  type: string;
  operation: string | null;
  config: Record<string, unknown>;
}

type Output = { kind: InputDataType } | { fields: Record<string, InputDataType> } | null;

const AI_KIND = { text: "text", number: "number", yes_no: "checkbox", category: "text" } as const;

/** What a column's cells hold, for checking whether another column can read them. Action results cannot be read. */
export function columnOutput(column: ColumnShape, byId: ReadonlyMap<string, ColumnShape>, seen = new Set<string>()): Output {
  const config = column.config as Record<string, any>;
  if (column.type === "input") return { kind: inputDataType(config) };
  if (column.type === "action") return null;
  if (column.type === "enrichment") {
    if (column.operation === "find_email") return { kind: "email" };
    if (column.operation === "find_phone") return { kind: "phone" };
    if (column.operation === "company_domain") return { kind: "domain" };
    const all: Record<string, InputDataType> | null =
      column.operation === "company_data" ? COMPANY_DATA_FIELDS : column.operation === "linkedin_profile" ? LINKEDIN_PROFILE_FIELDS : null;
    if (!all) return { kind: "text" };
    const chosen: string[] = Array.isArray(config.fields) ? config.fields : Object.keys(all);
    return { fields: Object.fromEntries(chosen.filter((f) => Object.hasOwn(all, f)).map((f) => [f, all[f]!])) };
  }
  if (column.type === "ai") {
    const output = config.output as { type?: string; fields?: Array<{ name: string; type: keyof typeof AI_KIND }> } | undefined;
    if (output?.type === "fields") return { fields: Object.fromEntries((output.fields ?? []).map((f) => [f.name, AI_KIND[f.type] ?? "text"])) };
    return { kind: AI_KIND[output?.type as keyof typeof AI_KIND] ?? "text" };
  }
  // A formula's kind follows from its function, and for pass-through functions from what it reads.
  if (config.fn === "extract_domain") return { kind: "domain" };
  if (config.fn === "date_part") return { kind: "number" };
  const passThrough: unknown[] = config.fn === "first_non_empty" ? (config.sources ?? []) : config.fn === "if_then_else" ? [config.then, config.else] : [];
  if (!passThrough.length || seen.has(column.id)) return { kind: "text" };
  seen.add(column.id);
  const kinds = passThrough.map((entry) => {
    const operandValue = entry as { columnId?: string; field?: string; value?: unknown };
    if (operandValue?.columnId === undefined) return typeof operandValue?.value === "number" ? "number" : typeof operandValue?.value === "boolean" ? "checkbox" : "text";
    const target = byId.get(operandValue.columnId);
    const output = target && columnOutput(target, byId, seen);
    if (!output) return "text";
    return "kind" in output ? output.kind : (output.fields[operandValue.field ?? ""] ?? "text");
  });
  seen.delete(column.id);
  return { kind: kinds.every((k) => k === kinds[0]) ? (kinds[0] as InputDataType) : "text" };
}

const NUMERIC_RULES = new Set(["gt", "gte", "lt", "lte"]);

/** Whether a comparison makes sense for the kind of value it reads. */
function ruleProblem(kind: InputDataType, { op, value }: { op: string; value?: unknown }): string | null {
  if (op === "is_empty" || op === "has_value") return null;
  if (op === "contains" || op === "not_contains") return ["number", "checkbox", "date"].includes(kind) ? `"${op}" needs a text column` : null;
  if (NUMERIC_RULES.has(op)) {
    if (kind === "number") return typeof value === "number" ? null : "Compare a number column with a number";
    if (kind === "date") return typeof value === "string" ? null : "Compare a date column with a date";
    return kind === "text" ? null : `"${op}" needs a number or date column`;
  }
  const values = Array.isArray(value) ? value : [value];
  if (kind === "number" && !values.every((v) => typeof v === "number")) return "Compare a number column with a number";
  if (kind === "checkbox" && !values.every((v) => typeof v === "boolean")) return "Compare a checkbox column with true or false";
  if (kind === "date" && !values.every((v) => typeof v === "string" && isoDate.test(v))) return "Compare a date column with a date";
  return null;
}

/** Checks every reference of column `selfId` against the workbook's columns. */
export function referenceProblems(selfId: string, references: ColumnReference[], byId: ReadonlyMap<string, ColumnShape>): ConfigProblem[] {
  return references.flatMap((reference): ConfigProblem[] => {
    const problem = (message: string) => [{ path: reference.path, message }];
    if (reference.columnId === selfId) return problem("A column cannot refer to itself");
    const target = byId.get(reference.columnId);
    if (!target) return problem("This workbook has no such column");
    const output = columnOutput(target, byId);
    if (!output) return problem(`"${target.name}" is an action column; its results cannot be read`);
    let kind: InputDataType;
    if ("fields" in output) {
      const names = Object.keys(output.fields);
      if (!reference.field || !Object.hasOwn(output.fields, reference.field)) return problem(`Choose a field of "${target.name}": ${names.join(", ")}`);
      kind = output.fields[reference.field]!;
    } else {
      if (reference.field) return problem(`"${target.name}" has no fields`);
      kind = output.kind;
    }
    if (reference.accepts && !reference.accepts.includes(kind)) return problem(`"${target.name}" holds ${kind} values; this needs ${reference.accepts.join(" or ")}`);
    const rule = reference.rule && ruleProblem(kind, reference.rule);
    return rule ? problem(rule) : [];
  });
}

/**
 * Whether `column`'s settings mention `columnId` anywhere. Deliberately textual: it also catches references stored by
 * older or future settings this module does not understand, so a column in use is never deleted from under them.
 */
export const mentions = (column: ColumnShape, columnId: string) => column.id !== columnId && JSON.stringify(column.config).toLowerCase().includes(columnId.toLowerCase());

/** True if following references from `startId` leads back to it. */
export function hasReferenceCycle(startId: string, byId: ReadonlyMap<string, ColumnShape>): boolean {
  const seen = new Set<string>();
  const queue = [startId];
  while (queue.length) {
    const column = byId.get(queue.pop()!);
    if (!column) continue;
    for (const other of byId.values()) {
      if (!mentions(column, other.id)) continue;
      if (other.id === startId) return true;
      if (!seen.has(other.id)) {
        seen.add(other.id);
        queue.push(other.id);
      }
    }
  }
  return false;
}
