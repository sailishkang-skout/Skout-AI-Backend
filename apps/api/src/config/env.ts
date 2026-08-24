import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

const candidatePaths = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), ".env.local"),
  path.resolve(process.cwd(), "../.env"),
  path.resolve(process.cwd(), "../.env.local"),
  path.resolve(process.cwd(), "../../.env"),
  path.resolve(process.cwd(), "../../.env.local"),
];

if (process.env.NODE_ENV !== "test" && !process.env.VITEST) {
  for (const envPath of candidatePaths) {
    dotenv.config({ path: envPath });
  }
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().default(3001),
    HOST: z.string().default("0.0.0.0"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    SERVICE_NAME: z.string().default("skout-api"),
    SERVICE_VERSION: z.string().optional(),
    SENTRY_DSN: z.string().optional(),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
    POSTHOG_API_KEY: z.string().optional(),
    POSTHOG_HOST: z.string().default("https://us.i.posthog.com"),
    POSTHOG_PROJECT_ID: z.string().optional(),
    /** Datadog API key — ECS Fargate agent sidecar (not serverless/Lambda). */
    DD_API_KEY: z.string().optional(),
    DD_SITE: z.string().default("us5.datadoghq.com"),
    TRUST_PROXY: z
      .string()
      .optional()
      .transform((v) => {
        if (v === "true" || v === "1") return true;
        if (v === "false" || v === "0") return false;
        return process.env.NODE_ENV === "production";
      }),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(200),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
    DATABASE_URL: z.string().url().optional(),
    DATABASE_HOST: z.string().optional(),
    DATABASE_PORT: z.coerce.number().optional(),
    DATABASE_NAME: z.string().default("skout"),
    DATABASE_USER: z.string().default("skout"),
    DATABASE_PASSWORD: z.string().optional(),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    CORS_ORIGIN: z
      .string()
      .default("http://localhost:3000")
      .transform((val) => val.split(",").map((s) => s.trim())),
    CLERK_SECRET_KEY: z.string().optional(),
    CLERK_PUBLISHABLE_KEY: z.string().optional(),
    /** When true, skip JWT and use stub user (local only; never set in prod). */
    AUTH_STUB: z
      .string()
      .optional()
      .transform((v) => v === "true" || v === "1"),
    /** Default email for stub auth when no x-stub-user-email header is sent. */
    AUTH_STUB_EMAIL: z.string().email().optional(),
    /**
     * Shared secret for the static-auth admin data-import page (/admin/import in the
     * frontend). When set, requests to /api/v1/import/* may authenticate with
     * `Authorization: Bearer admin_<this value>` instead of a Clerk JWT. Scoped to
     * import routes only — never treated as a general-purpose API credential.
     * Leave unset to disable this auth path entirely.
     */
    ADMIN_IMPORT_SECRET: z.string().min(16).optional(),
    /** Workspace that admin-imported rows are activated into. Required if ADMIN_IMPORT_SECRET is set. */
    ADMIN_IMPORT_WORKSPACE_ID: z.string().uuid().optional(),
    /** When true, skip business-hours check and send emails immediately (testing only). */
    BYPASS_BUSINESS_HOURS: z
      .string()
      .optional()
      .transform((v) => v === "true" || v === "1"),
    EXPORTS_BUCKET: z.string().optional(),
    SCRAPE_BUCKET: z.string().optional(),
    S3_ENDPOINT: z.string().optional(),
    S3_FORCE_PATH_STYLE: z
      .string()
      .optional()
      .transform((v) => v === "true" || v === "1"),
    OPENSEARCH_URL: z.string().optional(),
    OPENSEARCH_USERNAME: z.string().optional(),
    OPENSEARCH_PASSWORD: z.string().optional(),
    OPENSEARCH_INDEX: z.string().default("prospects"),
    /** In-memory demo corpus size when OpenSearch is unavailable. */
    DEMO_CORPUS_SIZE: z.coerce.number().int().positive().default(5300),
    /** Credits charged per search page (cache miss only). */
    SEARCH_CREDIT_COST: z.coerce.number().int().min(0).default(1),
    /** Redis TTL for cached search result pages. */
    SEARCH_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    /** Redis TTL for cached prospect-by-ID (drawer) results. */
    PROSPECT_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(60),
    /** Redis TTL for cached smart-list run results. */
    SMART_LIST_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(120),
    CLICKHOUSE_URL: z.string().optional(),
    AI_SERVICE_URL: z.string().optional(),
    EMAIL_INTEL_SERVICE_URL: z.string().optional(),
    EMAIL_INTEL_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
    /** Discover runs multiple SMTP checks — allow a longer upstream timeout than verify. */
    EMAIL_INTEL_DISCOVER_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
    /** n8n / external callers of /api/v1/email-intel/* (header x-api-key). */
    EMAIL_INTEL_EXTERNAL_API_KEY: z.string().optional(),
    /** Warm-Up Tool CloudMap URL (e.g. http://warmup-tool.<ns>:3010). */
    WARMUP_TOOL_SERVICE_URL: z.string().optional(),
    WARMUP_TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    /** Platform provisioning Bearer for POST /api/v1/internal/provision-tenant. */
    WARMUP_TOOL_PLATFORM_PROVISIONING_KEY: z.string().optional(),
    /** OpenRouter API key (preferred). Also accepts OPEN_ROUTER_API_KEY via transform. */
    OPENROUTER_API_KEY: z.string().optional(),
    OPEN_ROUTER_API_KEY: z.string().optional(),
    /**
     * Legacy / alternate slot for the LLM key (SkoutDev/openai). Used as fallback when
     * OPENROUTER_API_KEY is missing or still the CDK placeholder.
     */
    OPENAI_API_KEY: z.string().optional(),
    OPENCORPORATES_API_KEY: z.string().optional(),
    OPENCORPORATES_BASE_URL: z.string().default("https://api.opencorporates.com/v0.4"),
    SEC_EDGAR_BASE_URL: z.string().default("https://efts.sec.gov/LATEST/search-index"),
    LINKEDIN_ACCOUNTS_JSON: z.string().optional(),
    /** Unipile DSN (e.g. https://api1.unipile.com:13111) for LinkedIn sequence sends. */
    UNIPILE_DSN: z.string().url().optional(),
    UNIPILE_API_KEY: z.string().optional(),
    INTEGRATION_ENCRYPTION_KEY: z.string().optional(),
    /** HMAC secret for signed tracking/unsubscribe tokens. Falls back to INTEGRATION_ENCRYPTION_KEY. */
    TRACKING_SIGNING_SECRET: z.string().optional(),
    // --- Enrichment provider API keys (PAL). Optional: stub adapters are used
    //     for any capability whose key is absent. ---
    HUNTER_API_KEY: z.string().optional(),
    MILLIONVERIFIER_API_KEY: z.string().optional(),
    ZEROBOUNCE_API_KEY: z.string().optional(),
    NEVERBOUNCE_API_KEY: z.string().optional(),
    PDL_API_KEY: z.string().optional(),
    REVENUEBASE_API_KEY: z.string().optional(),
    EXPLORIUM_API_KEY: z.string().optional(),
    CORESIGNAL_API_KEY: z.string().optional(),
    DATAGMA_API_KEY: z.string().optional(),
    KASPR_API_KEY: z.string().optional(),
    LUSHA_API_KEY: z.string().optional(),
    CONTACTOUT_API_KEY: z.string().optional(),
    COGNISM_API_KEY: z.string().optional(),
    // --- Enrichment provider base URLs (override per environment / sandbox). ---
    HUNTER_BASE_URL: z.string().default("https://api.hunter.io/v2"),
    MILLIONVERIFIER_BASE_URL: z.string().default("https://api.millionverifier.com/api/v3"),
    ZEROBOUNCE_BASE_URL: z.string().default("https://api.zerobounce.net/v2"),
    NEVERBOUNCE_BASE_URL: z.string().default("https://api.neverbounce.com/v4"),
    PDL_BASE_URL: z.string().default("https://api.peopledatalabs.com/v5"),
    REVENUEBASE_BASE_URL: z.string().default("https://api.revenuebase.ai"),
    EXPLORIUM_BASE_URL: z.string().default("https://api.explorium.ai/v1"),
    CORESIGNAL_BASE_URL: z.string().default("https://api.coresignal.com/cdapi/v2"),
    DATAGMA_BASE_URL: z.string().default("https://gateway.datagma.net/api/ingress"),
    KASPR_BASE_URL: z.string().default("https://api.developers.kaspr.io"),
    LUSHA_BASE_URL: z.string().default("https://api.lusha.com"),
    CONTACTOUT_BASE_URL: z.string().default("https://api.contactout.com"),
    COGNISM_BASE_URL: z.string().default("https://app.cognism.com/api"),
    HUBSPOT_CLIENT_ID: z.string().optional(),
    HUBSPOT_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_CLIENT_ID: z.string().optional(),
    MICROSOFT_CLIENT_SECRET: z.string().optional(),
    /** Razorpay checkout (optional — beta top-up remains when unset). */
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
    /** JSON array of { id, label, credits, amountInr }. */
    RAZORPAY_CREDIT_PACKS_JSON: z.string().optional(),
    /** Prefix for per-workspace CRM OAuth secrets in AWS Secrets Manager. */
    CRM_SECRETS_PREFIX: z.string().default("SkoutDev/crm"),
    /** When true, store CRM OAuth tokens in local `.crm-secrets/` instead of AWS. */
    CRM_CREDENTIALS_LOCAL: z
      .string()
      .optional()
      .transform((v) => v === "true" || v === "1"),
    AWS_REGION: z.string().optional(),
    /** Public API base URL for OAuth callbacks (e.g. https://alb.example.com). */
    API_PUBLIC_URL: z.string().optional(),
    /** Frontend origin for post-OAuth redirects. Defaults to first CORS_ORIGIN. */
    FRONTEND_URL: z.string().optional(),
    /** Base URL used in invite-accept links (defaults to FRONTEND_URL). */
    INVITE_BASE_URL: z.string().optional(),
    /** From-address for transactional emails (invites, OTP). */
    SES_FROM_EMAIL: z.string().default("noreply@skoutai.io"),
    /** AWS SES SMTP credentials. When SMTP_HOST absent, emails are logged only. */
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().default(587),
    SMTP_USERNAME: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    // --- Enrichment tunables. ---
    ENRICHMENT_REQUEST_TIMEOUT_MS: z.coerce.number().default(8000),
    ENRICHMENT_PHONE_SCORE_GATE: z.coerce.number().default(80),
    ENRICHMENT_AI_TIMEOUT_MS: z.coerce.number().default(15000),
    // --- Signal stacking score (D5) — tunable until real conversion data can calibrate these. ---
    SIGNAL_STACK_DEFAULT_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.6),
    SIGNAL_STACK_RECENCY_HALF_LIFE_DAYS: z.coerce.number().positive().default(14),
    SIGNAL_STACK_RECENCY_FLOOR: z.coerce.number().min(0).max(1).default(0.05),
    SIGNAL_STACK_MULTIPLIER_2_TYPES: z.coerce.number().min(1).default(1.3),
    SIGNAL_STACK_MULTIPLIER_3_TYPES: z.coerce.number().min(1).default(1.6),
    SIGNAL_STACK_DECISION_MAKER_MULTIPLIER: z.coerce.number().min(1).default(1.25),
    SIGNAL_STACK_SCORE_SCALE: z.coerce.number().positive().default(35),
    // --- Inbox rotation / health thresholds. ---
    INBOX_BOUNCE_RATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.05),
    INBOX_SPAM_RATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.01),
    INBOX_MIN_SENT_BEFORE_HEALTH_CHECK: z.coerce.number().int().positive().default(20),
    // --- Sending domain warmup. ---
    WARMUP_MAX_DAYS: z.coerce.number().int().positive().default(30),
    WARMUP_MAX_DAILY_LIMIT: z.coerce.number().int().positive().default(200),
    // --- DNSBL blacklist monitoring. ---
    DNSBL_CHECK_INTERVAL_HOURS: z.coerce.number().int().positive().default(6),
    DNS_RESOLVER_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    // --- R20.2 — click-to-call + SMS (Twilio or Telnyx). All optional until configured. ---
    /** When true and Twilio creds exist, use Twilio; otherwise fall back to Telnyx when configured. */
    TWILIO_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === "true" || v === "1"),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    /** The Twilio number used as callerId for both legs of a bridged call. */
    TWILIO_PHONE_NUMBER: z.string().optional(),
    /** Publicly reachable base URL Twilio calls back for TwiML + status (defaults to API_PUBLIC_URL). */
    TWILIO_WEBHOOK_BASE_URL: z.string().optional(),
    /** Telnyx API key (v2 Bearer auth). Used when TWILIO_ENABLED is false. */
    TELNYX_API_KEY: z.string().optional(),
    /** Telnyx number used as callerId for bridged calls and outbound SMS. */
    TELNYX_PHONE_NUMBER: z.string().optional(),
    /** Telnyx TeXML application / connection ID for outbound calls. */
    TELNYX_CONNECTION_ID: z.string().optional(),
    /** Optional alias for TWILIO_WEBHOOK_BASE_URL (Telnyx TeXML + status callbacks). */
    TELECOM_WEBHOOK_BASE_URL: z.string().optional(),
    // --- R16.2 — meeting-bot vendor (Recall.ai / Fireflies.ai — vendor TBD). All optional. ---
    MEETING_BOT_PROVIDER: z.enum(["recall", "fireflies"]).optional(),
    MEETING_BOT_API_KEY: z.string().optional(),
    /** Shared secret to validate inbound meeting-bot webhooks (transcript/summary delivery). */
    MEETING_BOT_WEBHOOK_SECRET: z.string().optional(),
    // R22.1 — Apollo.io import is workspace-scoped BYOK (Settings → Integrations), not a
    // platform env var: each workspace pulls from its own Apollo account, so a shared platform
    // key wouldn't make sense the way TWILIO_*/MEETING_BOT_* platform keys do.
    // --- Smart list auto-refresh (R10.2). ---
    SMART_LIST_REFRESH_SWEEP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
    // --- Task/sequence/draft reminders (R17.2). ---
    REMINDER_SWEEP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(15),
    /** How many hours before (task/sequence step due) or after (draft created) something is
     * considered "needs a reminder". */
    REMINDER_LEAD_HOURS: z.coerce.number().int().positive().default(24),
    // --- R17.3 signal-triggered SDR alerts. ---
    /** How often the alert-sweep worker matches newly-recorded signals against alert_rules. */
    ALERT_SWEEP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(5),
    /** How often the digest worker batches pending digest-preference notifications into one email. */
    ALERT_DIGEST_SWEEP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(1440),
    // --- R18.1 engagement-decay risk flag. ---
    /** How often the risk-decay sweep re-evaluates activated prospects. */
    RISK_DECAY_SWEEP_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),
    /** No opens/replies/activity for this many days -> engagement_decay signal. */
    RISK_DECAY_INACTIVITY_DAYS: z.coerce.number().int().positive().default(21),
  })
  .transform((data) => {
    let next = data;
    if (!data.DATABASE_URL && data.DATABASE_HOST && data.DATABASE_PASSWORD) {
      const port = data.DATABASE_PORT ?? 5432;
      next = {
        ...data,
        DATABASE_URL: `postgresql://${data.DATABASE_USER}:${encodeURIComponent(data.DATABASE_PASSWORD)}@${data.DATABASE_HOST}:${port}/${data.DATABASE_NAME}`,
      };
    }
    if (!next.FRONTEND_URL && next.CORS_ORIGIN[0]) {
      next = { ...next, FRONTEND_URL: next.CORS_ORIGIN[0] };
    }
    if (!next.TWILIO_WEBHOOK_BASE_URL && next.API_PUBLIC_URL) {
      next = { ...next, TWILIO_WEBHOOK_BASE_URL: next.API_PUBLIC_URL };
    }
    if (!next.TELECOM_WEBHOOK_BASE_URL && next.TWILIO_WEBHOOK_BASE_URL) {
      next = { ...next, TELECOM_WEBHOOK_BASE_URL: next.TWILIO_WEBHOOK_BASE_URL };
    }
    // Alias OPEN_ROUTER_API_KEY → OPENROUTER_API_KEY (common env naming)
    if (!next.OPENROUTER_API_KEY && next.OPEN_ROUTER_API_KEY) {
      next = { ...next, OPENROUTER_API_KEY: next.OPEN_ROUTER_API_KEY };
    }
    // Treat CDK placeholders as unset; fall back to OPENAI_API_KEY when that holds the
    // real OpenRouter key (historically stored in SkoutDev/openai during the migration).
    const isPlaceholder = (v?: string) =>
      !v ||
      v.trim() === "" ||
      v.trim().toLowerCase() === "replace-me" ||
      v.trim().toLowerCase() === "changeme";
    if (isPlaceholder(next.OPENROUTER_API_KEY)) {
      const fallback = next.OPENAI_API_KEY;
      next = {
        ...next,
        OPENROUTER_API_KEY: isPlaceholder(fallback) ? undefined : fallback,
      };
    }
    return next;
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }
  return parsed.data;
}
