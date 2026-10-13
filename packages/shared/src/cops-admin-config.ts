import { z } from "zod";

/**
 * COPS-07 admin configuration (Bible p.16): the config kinds kept in the versioned config store,
 * their schemas and the built-in defaults shown when a workspace has saved nothing. Config that
 * already has its own store (activation templates, sequences, gate policies, notification routes)
 * is not here.
 */
export const COPS_CONFIG_KINDS = ["credit_package", "trial_template", "email_template", "retention_policy", "feature_flags"] as const;
export type CopsConfigKind = (typeof COPS_CONFIG_KINDS)[number];

/** Appendix F retention categories. */
export const RETENTION_CATEGORIES = ["core_records", "communications", "attachments", "audit_logs", "diagnostics", "ai_traces", "tombstones"] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORIES)[number];

export const COPS_MODULES = ["crm", "commercial", "provisioning", "onboarding", "tickets", "admin"] as const;
export type CopsModule = (typeof COPS_MODULES)[number];

const text = (max: number) => z.string().trim().min(1).max(max);

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
};

export const COPS_CONFIG_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isCopsConfigKind(value: string): value is CopsConfigKind {
  return (COPS_CONFIG_KINDS as readonly string[]).includes(value);
}
