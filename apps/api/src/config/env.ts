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

for (const envPath of candidatePaths) {
  dotenv.config({ path: envPath });
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
    EXPORTS_BUCKET: z.string().optional(),
    SCRAPE_BUCKET: z.string().optional(),
    OPENSEARCH_URL: z.string().optional(),
    OPENSEARCH_USERNAME: z.string().optional(),
    OPENSEARCH_PASSWORD: z.string().optional(),
    OPENSEARCH_INDEX: z.string().default("prospects"),
    CLICKHOUSE_URL: z.string().optional(),
    AI_SERVICE_URL: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    OPENCORPORATES_API_KEY: z.string().optional(),
    OPENCORPORATES_BASE_URL: z.string().default("https://api.opencorporates.com/v0.4"),
    SEC_EDGAR_BASE_URL: z.string().default("https://efts.sec.gov/LATEST/search-index"),
    LINKEDIN_ACCOUNTS_JSON: z.string().optional(),
    INTEGRATION_ENCRYPTION_KEY: z.string().optional(),
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
    CONTACTOUT_BASE_URL: z.string().default("https://api.contactout.com"),
    COGNISM_BASE_URL: z.string().default("https://app.cognism.com/api"),
    HUBSPOT_CLIENT_ID: z.string().optional(),
    HUBSPOT_CLIENT_SECRET: z.string().optional(),
    /** Public API base URL for OAuth callbacks (e.g. https://alb.example.com). */
    API_PUBLIC_URL: z.string().optional(),
    /** Frontend origin for post-OAuth redirects. Defaults to first CORS_ORIGIN. */
    FRONTEND_URL: z.string().optional(),
    // --- Enrichment tunables. ---
    ENRICHMENT_REQUEST_TIMEOUT_MS: z.coerce.number().default(8000),
    ENRICHMENT_PHONE_SCORE_GATE: z.coerce.number().default(80),
    ENRICHMENT_AI_TIMEOUT_MS: z.coerce.number().default(5000),
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
