import { z } from "zod";
import { DEFAULT_SLA_POLICY, slaPolicySchema } from "./cops-sla.js";
import { esignTemplateSchema } from "./cops-esign.js";
import { COMMERCIAL_POLICY_DEFAULTS, approvalPolicySchema, currencyPolicySchema, dunningPolicySchema, priceBookSchema, renewalPolicySchema } from "./cops-commercial-policy.js";

/**
 * COPS-07 admin configuration (Bible p.16): the config kinds kept in the versioned config store,
 * their schemas and the built-in defaults shown when a workspace has saved nothing. Config that
 * already has its own store (activation templates, sequences, gate policies, notification routes)
 * is not here. COPS-08 adds the commercial policy kinds; each has one key, `default`.
 */
export const COPS_CONFIG_KINDS = [
  "credit_package",
  "trial_template",
  "email_template",
  "retention_policy",
  "feature_flags",
  "approval_policy",
  "dunning_policy",
  "price_book",
  "currency_policy",
  "esign_template",
  "renewal_policy",
  // COPS-12: SLA targets, business-hours calendar and pause rules.
  "sla_policy",
  // The next actions people pick from when they create a task or a deal (Bible p.24, p.43).
  "next_action_catalog",
] as const;
export type CopsConfigKind = (typeof COPS_CONFIG_KINDS)[number];

/** Appendix F retention categories. */
export const RETENTION_CATEGORIES = ["core_records", "communications", "attachments", "audit_logs", "diagnostics", "ai_traces", "tombstones"] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

export const COPS_MODULES = ["crm", "commercial", "provisioning", "onboarding", "tickets", "admin"] as const;
export type CopsModule = (typeof COPS_MODULES)[number];

const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * What a next action does in the app. Every task template and deal step is tied to one, so the
 * task it creates opens the right screen (proposal builder, payment link, ...). The name is free.
 */
export const NEXT_ACTION_LINKS = [
  "call",
  "email",
  "meeting",
  "review",
  "send_proposal",
  "send_contract",
  "send_payment_link",
  "provision_trial",
  "send_onboarding_email",
  "create_ticket",
] as const;
export type NextActionLink = (typeof NEXT_ACTION_LINKS)[number];
/** The task type each action creates. */
export const NEXT_ACTION_TASK_TYPE: Record<NextActionLink, "call" | "email" | "meeting" | "review"> = {
  call: "call",
  email: "email",
  meeting: "meeting",
  review: "review",
  send_proposal: "email",
  send_contract: "email",
  send_payment_link: "email",
  provision_trial: "review",
  send_onboarding_email: "email",
  create_ticket: "review",
};
const taskTemplateSchema = z.object({ group: text(60), title: text(200), action: z.enum(NEXT_ACTION_LINKS) }).strict();
const dealStepSchema = z.object({ label: text(200), action: z.enum(NEXT_ACTION_LINKS) }).strict();
const nextActionCatalogSchema = z
  .object({
    task_templates: z.array(taskTemplateSchema).min(1).max(100),
    deal_next_steps: z.array(dealStepSchema).min(1).max(50),
  })
  .strict()
  .refine((v) => new Set(v.deal_next_steps.map((d) => d.label.toLowerCase())).size === v.deal_next_steps.length, {
    message: "Each deal step needs its own name",
    path: ["deal_next_steps"],
  });

/** Built-in next actions until an admin edits them. */
export const DEFAULT_NEXT_ACTION_CATALOG = {
  task_templates: [
    { group: "Onboarding", title: "Call to confirm access and first login", action: "call" },
    { group: "Onboarding", title: "Check usage and help with the first value event", action: "review" },
    { group: "Onboarding", title: "Offer a guided onboarding session", action: "meeting" },
    { group: "Onboarding", title: "Re-send the onboarding email", action: "send_onboarding_email" },
    { group: "Onboarding", title: "Raise the integration blocker with engineering", action: "create_ticket" },
    { group: "Commercial", title: "Follow up on the proposal", action: "send_proposal" },
    { group: "Commercial", title: "Chase the contract signature", action: "send_contract" },
    { group: "Commercial", title: "Follow up on the payment link", action: "send_payment_link" },
    { group: "Commercial", title: "Trial review: convert, extend or close", action: "meeting" },
    { group: "Success", title: "Success review with the customer", action: "meeting" },
    { group: "Success", title: "Prepare the renewal", action: "review" },
    { group: "Success", title: "Follow up on an open ticket", action: "call" },
  ],
  deal_next_steps: [
    { label: "Book discovery call", action: "call" },
    { label: "Schedule a demo", action: "meeting" },
    { label: "Confirm budget and decision maker", action: "call" },
    { label: "Send proposal", action: "send_proposal" },
    { label: "Send MSA / order form", action: "send_contract" },
    { label: "Send payment link", action: "send_payment_link" },
    { label: "Start a trial", action: "provision_trial" },
  ],
} satisfies { task_templates: { group: string; title: string; action: NextActionLink }[]; deal_next_steps: { label: string; action: NextActionLink }[] };

export const COPS_CONFIG_SCHEMAS = {
  credit_package: z
    .object({
      name: text(120),
      credits: z.number().int().positive().max(10_000_000),
      price_minor: z.number().int().min(0),
      currency: z.string().regex(/^[A-Z]{3}$/, "Three-letter currency code"),
      active: z.boolean(),
    })
    .strict(),
  trial_template: z
    .object({
      name: text(120),
      plan: text(64),
      trial_days: z.number().int().min(1).max(90),
      credits: z.number().int().min(0).max(1_000_000),
      integrations: z.array(z.enum(["crm", "email", "calendar"])).max(3),
    })
    .strict(),
  email_template: z
    .object({
      /** {{workspace}} is replaced with the customer workspace name. */
      subject: text(200),
      intro: text(2000),
      closing: z.string().trim().max(2000).optional(),
    })
    .strict(),
  retention_policy: z
    .object({
      /** Days to keep each category; null keeps it indefinitely. Audit logs can never be below one year. */
      categories: z.record(z.enum(RETENTION_CATEGORIES), z.object({ days: z.number().int().min(30).max(3650).nullable() }).strict()),
    })
    .strict()
    .refine((v) => v.categories.audit_logs?.days == null || v.categories.audit_logs.days >= 365, {
      message: "Audit logs must be kept for at least 365 days",
      path: ["categories", "audit_logs", "days"],
    }),
  feature_flags: z
    .object({
      modules: z.record(z.enum(COPS_MODULES), z.boolean()),
    })
    .strict(),
  approval_policy: approvalPolicySchema,
  dunning_policy: dunningPolicySchema,
  price_book: priceBookSchema,
  currency_policy: currencyPolicySchema,
  esign_template: esignTemplateSchema,
  renewal_policy: renewalPolicySchema,
  sla_policy: slaPolicySchema,
  next_action_catalog: nextActionCatalogSchema,
} as const satisfies Record<CopsConfigKind, z.ZodTypeAny>;

/**
 * Built-in defaults. Retention keeps everything until an admin chooses otherwise; every module is on.
 * Kinds without an entry have no default (credit packages and trial templates start empty).
 */
export const COPS_CONFIG_DEFAULTS: Partial<Record<CopsConfigKind, Record<string, unknown>>> = {
  retention_policy: {
    default: { categories: Object.fromEntries(RETENTION_CATEGORIES.map((c) => [c, { days: null }])) },
  },
  feature_flags: {
    default: { modules: Object.fromEntries(COPS_MODULES.map((m) => [m, true])) },
  },
  trial_template: {
    standard: { name: "Standard trial", plan: "trial", trial_days: 14, credits: 500, integrations: ["crm", "email"] },
  },
  // Seeded from docs/ops/cops-commercial-policy.default.json.
  approval_policy: { default: COMMERCIAL_POLICY_DEFAULTS.approval_policy },
  dunning_policy: { default: COMMERCIAL_POLICY_DEFAULTS.dunning_policy },
  price_book: { default: COMMERCIAL_POLICY_DEFAULTS.price_book },
  currency_policy: { default: COMMERCIAL_POLICY_DEFAULTS.currency_policy },
  renewal_policy: { default: COMMERCIAL_POLICY_DEFAULTS.renewal_policy },
  sla_policy: { default: DEFAULT_SLA_POLICY },
  next_action_catalog: { default: DEFAULT_NEXT_ACTION_CATALOG },
};

export const COPS_CONFIG_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isCopsConfigKind(value: string): value is CopsConfigKind {
  return (COPS_CONFIG_KINDS as readonly string[]).includes(value);
}
