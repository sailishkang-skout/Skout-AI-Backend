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

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3002),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  SERVICE_NAME: z.string().default("skout-crm"),
  SERVICE_VERSION: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
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
  CORS_ORIGIN: z
    .string()
    .default("http://localhost:3000")
    .transform((val) => val.split(",").map((s) => s.trim())),
  CLERK_SECRET_KEY: z.string().optional(),
  AUTH_STUB: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  FRONTEND_URL: z.string().optional(),
  // --- R16.2 — meeting-bot vendor (Recall.ai / Fireflies.ai — vendor TBD). All optional. ---
  MEETING_BOT_PROVIDER: z.enum(["recall", "fireflies"]).optional(),
  MEETING_BOT_API_KEY: z.string().optional(),
  /** Shared secret checked against `?secret=` on the inbound webhook. */
  MEETING_BOT_WEBHOOK_SECRET: z.string().optional(),
  /** Publicly reachable base URL the meeting-bot vendor calls back (defaults to FRONTEND_URL's origin swapped to this service — set explicitly in production). */
  CRM_PUBLIC_URL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(overrides?: Partial<Env>): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.message}`);
  }

  let databaseUrl = parsed.data.DATABASE_URL;
  if (!databaseUrl && parsed.data.DATABASE_HOST) {
    const password = parsed.data.DATABASE_PASSWORD ?? "";
    databaseUrl = `postgresql://${parsed.data.DATABASE_USER}:${encodeURIComponent(password)}@${parsed.data.DATABASE_HOST}:${parsed.data.DATABASE_PORT ?? 5432}/${parsed.data.DATABASE_NAME}`;
  }

  // Root monorepo `.env` sets PORT=3001 for the API. Do not let CRM steal that port
  // unless the caller explicitly exports CRM_PORT (or a non-3001 PORT).
  const crmPortEnv = process.env.CRM_PORT;
  let port = parsed.data.PORT;
  if (crmPortEnv && Number.isFinite(Number(crmPortEnv))) {
    port = Number(crmPortEnv);
  } else if (port === 3001) {
    port = 3002;
  }

  return { ...parsed.data, PORT: port, DATABASE_URL: databaseUrl, ...overrides };
}
