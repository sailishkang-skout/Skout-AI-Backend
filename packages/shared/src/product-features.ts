/**
 * Early access: the product areas COPS can switch on or off per workspace, and the plan presets that
 * fill them in on approval (docs/superpowers/specs/2026-11-17-early-access-approval-design.md).
 * A switch is stored as the platform-managed entitlement `feature.<key>`; an absent row means ON, so
 * workspaces that predate the switches keep everything.
 */
export const PRODUCT_FEATURES = [
  "ai",
  "sequences",
  "linkedin",
  "inbox",
  "enrichment",
  "smart_lists",
  "tam",
  "workflows",
  "crm",
  "warmup",
  "meeting_voice",
  "analytics",
] as const;
export type ProductFeature = (typeof PRODUCT_FEATURES)[number];

export type WorkspaceAccessStatus = "pending" | "invited" | "active" | "rejected";

export const FEATURE_LABELS: Record<ProductFeature, string> = {
  ai: "AI & Dexter",
  sequences: "Sequences",
  linkedin: "LinkedIn outreach",
  inbox: "Unified inbox",
  enrichment: "Enrichment (email/phone lookups)",
  smart_lists: "Smart lists",
  tam: "Market (TAM)",
  workflows: "Workflows & automation",
  crm: "CRM",
  warmup: "Warm-up",
  meeting_voice: "Meeting bot & voice",
  analytics: "Analytics & reports",
};

/** First path segment after /api/v1/. Anything not listed (auth, team, billing, lists...) is never gated. */
export const FEATURE_API_PREFIXES: Record<ProductFeature, readonly string[]> = {
  // decisions: Dexter's decision queue (dexter-platform.routes.ts).
  ai: ["ai", "dexter", "decisions"],
  sequences: ["sequences", "activation-rules"],
  linkedin: ["linkedin"],
  inbox: ["inbox", "inboxes", "messaging", "deliverability", "domains"],
  enrichment: ["enrichment", "email-intel", "workbooks", "scrape"],
  smart_lists: ["smart-lists"],
  tam: ["tam", "regional-tam-gate", "regional-intel", "regional-brief"],
  workflows: ["automations", "workflows", "automation-policy"],
  // calendar: CRM meetings live under the CRM area of the app.
  crm: ["crm", "account-360", "person-360", "identity-merge", "calendar"],
  warmup: ["warmup-tool"],
  meeting_voice: ["calls", "numbers"],
  analytics: ["analytics", "forecasts", "board-pack", "report-schedules", "gtm-learning-outcomes", "cro"],
};

const FEATURE_BY_SEGMENT = new Map<string, ProductFeature>(
  PRODUCT_FEATURES.flatMap((f) => FEATURE_API_PREFIXES[f].map((p) => [p, f] as const))
);

const API_PREFIX = "/api/v1/";

/** The feature an API request belongs to, or null when the route is not feature-gated. */
export function featureForApiPath(url: string): ProductFeature | null {
  const path = url.split("?")[0] ?? "";
  if (!path.startsWith(API_PREFIX)) return null;
  const segment = path.slice(API_PREFIX.length).split("/")[0] ?? "";
  return FEATURE_BY_SEGMENT.get(segment) ?? null;
}

export type PlanPresetCode = "full" | "multichannel";

const allOn = () => Object.fromEntries(PRODUCT_FEATURES.map((f) => [f, true])) as Record<ProductFeature, boolean>;

/** At launch both plans include every feature; they differ by capacity (PLAN_LIMITS in cops-usage). */
export const PLAN_PRESETS: Record<PlanPresetCode, { label: string; credits: number; features: Record<ProductFeature, boolean> }> = {
  full: { label: "Skout Full", credits: 500, features: allOn() },
  multichannel: { label: "Skout Full Multichannel", credits: 500, features: allOn() },
};
